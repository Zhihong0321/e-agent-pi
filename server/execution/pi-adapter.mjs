// Isolated Pi runtime adapter: one fresh, run-bound worker process per attempt.
// No warm reuse — session, token, tool and event bindings die with the process,
// which is what makes the attempt-scoped worker token safe.
import { RpcClient } from '@earendil-works/pi-coding-agent';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { killTree, rpcClientPid } from '../proc.mjs';
import { agentEnv } from '../agent-env.mjs';
import { applyPiEvent } from '../pi-stream.mjs';
import { findModel, resolveModelCredentials } from '../models.mjs';
import { agentWorkspace, PI_CLI_PATH, PI_PACKAGE_DIR, ROOT, RUNTIME_DIR, STORAGE } from '../paths.mjs';
import { buildPiArgs, materializeAgentRuntime, resolveToolProfile } from '../runtime.mjs';
import { manifestRevisionOf } from './contracts.mjs';
import { isWaitingAtLlmGate } from '../queue/llm-gate.mjs';
import { createSilenceWatch } from '../queue/silence.mjs';

const HOST_TOOLS_EXTENSION = path.join(ROOT, 'agent', 'extensions', 'host-tools.ts');

let modelsJsonProvider = null;
export function setModelsJsonProvider(fn) {
  modelsJsonProvider = fn;
}

/** Runs before every worker process is spawned; the host uses it to wait for memory headroom. */
let beforeSpawn = null;
export function setBeforeSpawn(fn) {
  beforeSpawn = fn;
}

/**
 * The worker factory the runner calls. Opts (from runAgent):
 *   profile, manifest, token, attemptId, runRef, runKind, sessionFile, modelId,
 *   signal, images, onEvent, onToolEvent, onFinishRun
 */
export function piWorkerFactory(opts) {
  const { profile, manifest, token, attemptId, sessionFile, signal } = opts;
  const workerUrl = opts.workerUrl || `http://127.0.0.1:${process.env.PORT || 8080}`;
  // Chat turns are ordinary Pi conversations: no finish_run, the final answer is Pi's own text.
  const isChat = opts.runKind === 'chat';
  let pi = null;
  let pid = null;
  let piSession = null;
  let completionAccepted = false;
  let lastError = '';
  let modelTurns = 0;
  const runtimeDir = path.join(RUNTIME_DIR, 'execution', attemptId);

  async function start() {
    // Pi would silently create a blank conversation at a missing --session path.
    if (sessionFile && !existsSync(sessionFile)) {
      throw Object.assign(
        new Error(`The saved conversation for this chat is missing (${path.basename(sessionFile)}), so it cannot be resumed`),
        { execCode: 'SESSION_UNAVAILABLE' },
      );
    }
    const modelsJson = modelsJsonProvider ? await modelsJsonProvider() : JSON.parse(await readFile(path.join(RUNTIME_DIR, '..', 'models.json'), 'utf8').catch(() => '{}'));
    const mcpServers = (manifest.mcpServers || []).map((server) => ({ ...server }));
    await mkdir(runtimeDir, { recursive: true });
    await materializeAgentRuntime(profile.agentRow || profile, mcpServers, modelsJson, {
      modelId: opts.modelId, runtimeKey: path.join('execution', attemptId), companyId: opts.ctx?.companyId || null,
    });
    const manifestFile = path.join(runtimeDir, 'execution-manifest.json');
    await writeFile(manifestFile, JSON.stringify(manifest.manifest, null, 1), 'utf8');

    const resolved = await resolveModelCredentials();
    const active = findModel(resolved.models, opts.modelId);
    if (!active?.available) throw new Error('No model configured for this execution run');

    const agent = profile.agentRow || profile;
    const skills = agent.skills || [];
    // Same launcher as chat slots: explicit --skill paths, skill-aware tool
    // profile, file sharing, and spawn-subagents. mcpCount stays 0 so Pi does
    // not open a second MCP adapter; host-tools is the V2 tool bridge.
    const { profile: toolProfile } = await resolveToolProfile(agent, skills);
    const args = buildPiArgs({
      agent,
      skills,
      mcpCount: 0,
      runtimeDir,
      provider: active.provider,
      model: active.model,
      sessionFile,
      toolProfile,
      thinkingLevel: agent.thinkingLevel || profile.thinkingLevel || null,
    });
    args.push('--extension', HOST_TOOLS_EXTENSION);

    const cwd = opts.cwd || opts.workspace || profile.workspace || agentWorkspace(agent, opts.ctx?.companyId);
    await mkdir(cwd, { recursive: true });

    await beforeSpawn?.();
    pi = new RpcClient({
      cliPath: PI_CLI_PATH,
      cwd,
      provider: active.provider,
      model: active.model,
      env: agentEnv(profile.agentRow || profile, {
        TENANT_ID: opts.ctx?.companyId || '',
        EXECUTION_WORKER_URL: workerUrl,
        EXECUTION_WORKER_TOKEN: token,
        EXECUTION_MANIFEST_FILE: manifestFile,
        EXECUTION_RUN_KIND: opts.runKind || '',
        PI_CODING_AGENT_DIR: runtimeDir,
        PI_PACKAGE_DIR,
      }),
      args,
    });
    await pi.start();
    pid = rpcClientPid(pi);
    if (isChat) {
      const state = await pi.getState();
      if (state?.sessionFile) piSession = { sessionId: state.sessionId, sessionFile: state.sessionFile };
    }
  }

  function assertSignal() {
    if (signal?.aborted) throw Object.assign(new Error('Run was aborted'), { execCode: 'CANCELLED' });
  }

  async function prompt(message, { onEvent } = {}) {
    assertSignal();
    lastError = null;
    const currentTurn = { blocks: [], text: '' };
    let settle;
    const settled = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    // A Pi whose model call waits in a provider's line has nothing to say; that is queueing, not silence.
    const silence = createSilenceWatch({
      isWaiting: () => isWaitingAtLlmGate(`execution/${attemptId}`),
      onSilent: () => settle.reject(new Error('Worker went silent before finishing the turn')),
    });
    const bump = () => silence.bump();
    const unsubscribe = pi.onEvent((event) => {
      try {
        bump();
        if (event?.type === 'agent_settled') { settle.resolve(); return; }
        if (event?.type === 'message_end' && event.message?.role === 'assistant') {
          modelTurns += 1;
          lastError = event.message.errorMessage ? String(event.message.errorMessage) : null;
        }
        if (!isChat && event?.type === 'tool_execution_end' && String(event.toolName || '') === 'finish_run') {
          if (finishRunAccepted(event.result)) completionAccepted = true;
          if (completionAccepted) {
            // Acknowledged completion boundary: stop further model turns with
            // the runtime's own API rather than assuming the model will stop.
            void pi.abort().catch(() => {});
          }
        }
        const mapped = applyPiEvent(currentTurn, event);
        onEvent?.(event, currentTurn);
        if (mapped && !(completionAccepted && mapped.type === 'error')) opts.onEvent?.(mapped, currentTurn);
      } catch {
        /* event mapping must never kill the run */
      }
    });
    bump();
    try {
      void settled.catch(() => {});
      if (opts.images?.length) await pi.prompt(message, opts.images);
      else await pi.prompt(message);
      await settled;
      if (lastError && !completionAccepted) throw new Error(lastError);
      return { text: currentTurn.text };
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('Run was aborted'), { execCode: 'CANCELLED' });
      throw error;
    } finally {
      silence.stop();
      unsubscribe();
    }
  }

  function onAbort() {
    void pi?.abort().catch(() => {});
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  return {
    start,
    prompt,
    modelTurns: () => modelTurns,
    settledWithoutError: () => !lastError,
    /** Pi's own session identity, once its file exists on disk (a never-written session has nothing to resume). */
    sessionRef: () => (piSession && existsSync(piSession.sessionFile) ? piSession : null),
    markCompletionAccepted: () => { completionAccepted = true; },
    async dispose() {
      signal?.removeEventListener('abort', onAbort);
      const client = pi;
      pi = null;
      if (client) await client.stop().catch(() => {});
      await killTree(pid);
    },
  };
}

export function computeManifestRevision(manifest) {
  return manifestRevisionOf(manifest);
}

/** Host bridge payload, not free text. A rejection body can contain the word "accepted". */
export function finishRunAccepted(result) {
  const details = result && typeof result === 'object' ? (result.details && typeof result.details === 'object' ? result.details : result) : null;
  return Boolean(details && details.ok === true && details.data && details.data.accepted === true);
}
