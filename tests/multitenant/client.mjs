// Local HTTP client (one cookie jar per login) and container DB probe runner for the multi-tenant test.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BASE = 'https://e-agent.up.railway.app';
export const RUN_ID = process.env.MT_RUN || new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = path.join(here, 'evidence');
mkdirSync(evidenceDir, { recursive: true });
export const evidenceFile = path.join(evidenceDir, `${RUN_ID}.jsonl`);

export function log(entry) {
  appendFileSync(evidenceFile, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
}

export function makeClient(who) {
  let cookie = '';
  async function call(method, pathname, body, { headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (cookie) h.cookie = cookie;
    const res = await fetch(BASE + pathname, {
      method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie?.().find((c) => c.startsWith('demo_session=')) || '';
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data = text;
    if (!raw) { try { data = JSON.parse(text); } catch { /* keep text */ } }
    log({ who, method, path: pathname, body, status: res.status, response: typeof data === 'string' ? data.slice(0, 2000) : JSON.stringify(data).slice(0, 4000) });
    return { status: res.status, data };
  }
  return {
    who,
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b ?? {}, o),
    patch: (p, b, o) => call('PATCH', p, b ?? {}, o),
    del: (p, o) => call('DELETE', p, undefined, o),
    login: async (username, password) => {
      const r = await call('POST', '/api/demo/login', { username, password });
      return r;
    },
    logout: () => { cookie = ''; },
    hasCookie: () => Boolean(cookie),
    cookie: () => cookie,
    setCookie: (c) => { cookie = c; },
  };
}

// Runs probe.mjs inside the prod container. Returns the parsed @@JSON payload.
export function probe(op, args = {}) {
  const arg = Buffer.from(JSON.stringify({ op, ...args })).toString('base64');
  const out = execFileSync('bash', [path.join(here, 'ssh.sh'), path.join(here, 'probe.mjs'), arg], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = out.split(/\r?\n/).find((l) => l.startsWith('@@JSON'));
  if (!line) throw new Error('probe produced no JSON: ' + out.slice(0, 500));
  const value = JSON.parse(line.slice('@@JSON'.length));
  log({ who: 'probe', op, args: { ...args, password: undefined }, response: JSON.stringify(value).slice(0, 4000) });
  return value;
}

export const fixturesFile = path.join(here, '.fixtures.local.json');
export function loadFixtures() {
  return existsSync(fixturesFile) ? JSON.parse(readFileSync(fixturesFile, 'utf8')) : {};
}
export function saveFixtures(f) {
  writeFileSync(fixturesFile, JSON.stringify(f, null, 2));
}
