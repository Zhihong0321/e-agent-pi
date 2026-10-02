// Hardened wrapper around the legion swarm CLI.
//
// Every defence here exists because of an observed failure:
//   - groq returned `API 400 ... list_files did not match schema`  -> retry on a DIFFERENT provider
//   - workers returned "empty mutation result"                     -> treat as failure, retry
//   - minimax/mimo leaked raw <think> blocks, sometimes ONLY think -> strip, then retry if empty
//   - answers truncated mid-sentence                               -> JSON contract makes it detectable
//   - a whole run died and wrote nothing                           -> persist raw stdout before parsing
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LEGION = process.env.LEGION_PATH || null;

// Rotation order for retries. A failed task is retried on a provider that did NOT produce it.
const PROVIDERS = ['minimax', 'mimo-0730', 'openrouter', 'cavoti', 'mimo-0726'];

const HEADER = /^===== #(\d+) \[([^\]]+)\] \(([^)]*)\)\s*(\(FAILED\))?\s*=====$/;

/** Remove chain-of-thought blocks, closed or left dangling by truncation. */
export function stripThink(s) {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .trim();
}

/** Pull the last fenced JSON object/array out of a worker's prose. */
export function extractJson(s) {
  const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1].trim());
  const candidates = fences.length ? fences.reverse() : [];
  const braced = s.match(/[[{][\s\S]*[\]}]/);
  if (braced) candidates.push(braced[0]);
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try the next candidate */ }
  }
  return null;
}

function parseBlocks(stdout) {
  const lines = stdout.split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(HEADER);
    if (m) {
      if (cur) out.push(cur);
      cur = { index: +m[1], type: m[2], provider: m[3].trim(), failed: !!m[4], lines: [] };
    } else if (cur) {
      if (/^⚔️/.test(line)) continue;         // swarm footer
      cur.lines.push(line);
    }
  }
  if (cur) out.push(cur);
  return out.map(b => ({ ...b, text: b.lines.join('\n').trim() }));
}

function runLegion(tasks, { preset, root, caller = 'opus', rawDir, tag }) {
  if (!LEGION) {
    return Promise.resolve({ stdout: '', stderr: 'LEGION_PATH is not configured', code: -1 });
  }
  return new Promise(resolve => {
    const args = [LEGION];
    if (preset) args.push(`--preset=${preset}`);
    args.push('-');
    const child = spawn('node', args, {
      env: { ...process.env, LEGION_ROOT: root, LEGION_CALLER: caller },
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => resolve({ stdout, stderr: stderr + `\nspawn error: ${e.message}`, code: -1 }));
    child.on('close', code => {
      // Persist BEFORE parsing — a crash below must never lose worker output.
      if (rawDir) {
        fs.mkdirSync(rawDir, { recursive: true });
        fs.writeFileSync(path.join(rawDir, `${tag}.out.txt`), stdout);
        if (stderr.trim()) fs.writeFileSync(path.join(rawDir, `${tag}.err.txt`), stderr);
      }
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(tasks.join('\n') + '\n');
  });
}

const isBad = t => !t || /^ERROR:/i.test(t) || /empty mutation result/i.test(t);

/**
 * Dispatch tasks to the swarm and return one result per task, in order.
 * Each result: { ok, text, json, provider, error }
 *
 * @param tasks   array of "type: prompt" strings
 * @param opts.wantJson  require parseable JSON; unparseable counts as failure and is retried
 */
export async function swarm(tasks, opts = {}) {
  const { preset, root, caller = 'opus', rawDir, wantJson = false, retries = 1, label = 'swarm', log = () => {} } = opts;
  const results = new Array(tasks.length).fill(null);
  let pending = tasks.map((t, i) => ({ i, task: t }));

  for (let attempt = 0; attempt <= retries && pending.length; attempt++) {
    const tag = `${label}-a${attempt}`;
    log(`  swarm ${label}: attempt ${attempt + 1}, ${pending.length} task(s)`);
    const { stdout, code } = await runLegion(pending.map(p => p.task), {
      preset, root, caller, rawDir, tag,
    });
    const blocks = parseBlocks(stdout);

    if (!blocks.length) {
      log(`  ! swarm ${label}: no result blocks (exit ${code}) — raw kept at ${tag}.out.txt`);
      // whole-run death: everything still pending goes to the next attempt
      continue;
    }

    const next = [];
    for (let n = 0; n < pending.length; n++) {
      const p = pending[n];
      const b = blocks.find(x => x.index === n + 1);
      const clean = b ? stripThink(b.text) : '';
      const json = b && (wantJson ? extractJson(clean) : null);
      const failed = !b || b.failed || isBad(clean) || (wantJson && !json);

      if (!failed) {
        results[p.i] = { ok: true, text: clean, json, provider: b.provider };
      } else if (attempt < retries) {
        // Retry on a provider that is NOT the one that just failed.
        const bad = b?.provider ?? '';
        const alt = PROVIDERS.find(x => x !== bad) ?? PROVIDERS[0];
        const retask = p.task.replace(/^(\w+)(@[\w.-]+)?:/, `$1@${alt}:`);
        next.push({ i: p.i, task: retask });
        log(`  ↻ task ${p.i + 1} failed on ${bad || 'n/a'} -> retrying on ${alt}`);
      } else {
        results[p.i] = {
          ok: false, text: clean, json: null, provider: b?.provider,
          error: !b ? 'no result block' : b.failed ? 'worker reported FAILED'
            : wantJson && !json ? 'unparseable JSON' : 'empty/error result',
        };
      }
    }
    pending = next;
  }

  for (let i = 0; i < results.length; i++) {
    if (!results[i]) results[i] = { ok: false, text: '', json: null, error: 'run produced no output' };
  }
  return results;
}
