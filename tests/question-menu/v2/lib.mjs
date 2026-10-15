// Shared helpers for the trusted question-menu instrument (v2). No marker is ever put into a user message:
// cases are identified by session id, never by text the agents can read.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const BASE = process.env.QM_BASE || 'https://e-agent.up.railway.app';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function runDir(runId) {
  const d = path.join(here, 'evidence', runId);
  mkdirSync(d, { recursive: true });
  return d;
}

export function makeLogger(runId) {
  const file = path.join(runDir(runId), 'http.jsonl');
  return (entry) => appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
}

export function makeClient(who, log = () => {}) {
  let cookie = '';
  async function call(method, pathname, body, { text = false } = {}) {
    const h = {};
    if (body !== undefined) h['content-type'] = 'application/json';
    if (cookie) h.cookie = cookie;
    const res = await fetch(BASE + pathname, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.getSetCookie?.().find((c) => c.startsWith('demo_session=')) || '';
    if (sc) cookie = sc.split(';')[0];
    const raw = await res.text();
    let data = raw;
    if (!text) { try { data = JSON.parse(raw); } catch { /* keep text */ } }
    log({ who, method, path: pathname, status: res.status, body: body === undefined ? undefined : JSON.stringify(body).slice(0, 600), response: typeof data === 'string' ? data.slice(0, 600) : JSON.stringify(data).slice(0, 1200) });
    return { status: res.status, data };
  }
  return {
    who,
    get: (p) => call('GET', p),
    post: (p, b, o) => call('POST', p, b ?? {}, o),
    // Sign-in names the company by its code (since dde74bc).
    login: (u, p, company) => call('POST', '/api/demo/login', { company, username: u, password: p }),
    cookie: () => cookie,
    setCookie: (c) => { cookie = c; },
  };
}

const ssh = path.join(here, '..', '..', 'multitenant', 'ssh.sh');
export function inContainer(script, payload) {
  const arg = Buffer.from(JSON.stringify(payload)).toString('base64');
  // railway ssh fails now and then (host key rotation, dropped session): retry before giving up.
  let out = ''; let lastErr;
  for (let attempt = 0; attempt < 4 && !out; attempt++) {
    try { out = execFileSync('bash', [ssh, script, arg], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { lastErr = e; execFileSync('bash', ['-c', 'sleep ' + (3 + attempt * 4)]); }
  }
  if (!out) throw lastErr;
  const line = out.split(/\r?\n/).find((l) => l.startsWith('@@JSON'));
  if (!line) throw new Error('container script produced no JSON: ' + out.slice(0, 500));
  return JSON.parse(line.slice('@@JSON'.length));
}
export const qmdb = (payload) => inContainer(path.join(here, 'qmdb.mjs'), payload);
export const probe = (op, args = {}) => inContainer(path.join(here, '..', '..', 'multitenant', 'probe.mjs'), { op, ...args });

export function fixturesPath(rep) { return path.join(here, `.fixtures-rep${rep}.local.json`); }
export function loadFixtures(rep) { const p = fixturesPath(rep); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}; }
export function saveFixtures(rep, f) { writeFileSync(fixturesPath(rep), JSON.stringify(f, null, 2)); }
