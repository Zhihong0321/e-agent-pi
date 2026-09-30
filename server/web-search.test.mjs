import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { agentEnv } from "./agent-env.mjs";
import { rememberSecret } from "./secrets.mjs";
import { SEARCH_TOKEN, jinaKeys, resetSearchState, searchAuthorized, searchWeb, testJinaKeys } from "./web-search.mjs";

const KEYS = [
  { slot: 1, key: "jina_AAAA1111" },
  { slot: 2, key: "jina_BBBB2222" },
  { slot: 3, key: "jina_CCCC3333" },
];

const rows = [
  { title: "One", url: "https://a.example/1", description: "first", content: "page one", usage: { tokens: 12 } },
  { title: "Two", url: "https://a.example/2", description: "second", content: "page two", usage: { tokens: 8 } },
  { title: "No url", description: "dropped" },
];

/** Fake fetch: scripted status per bearer key, records every call. */
function fakeFetch(statusByKey = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const key = String(init.headers.Authorization).replace(/^Bearer /, "");
    calls.push({ url: String(url), key, headers: init.headers });
    const status = statusByKey[key] ?? 200;
    const body = status === 200 ? JSON.stringify({ code: 200, data: rows }) : `{"error":"status ${status}"}`;
    return { status, text: async () => body };
  };
  return { impl, calls };
}

beforeEach(() => resetSearchState());

test("searches rotate round-robin across tokens", async () => {
  const { impl, calls } = fakeFetch();
  const slots = [];
  for (let i = 0; i < 4; i++) slots.push((await searchWeb({ query: "solar" }, { fetch: impl, keys: KEYS })).slot);
  assert.deepEqual(slots, [1, 2, 3, 1]);
  assert.equal(calls.length, 4);
});

test("a failing token falls through to the next, then is skipped while cooling", async () => {
  const { impl, calls } = fakeFetch({ jina_AAAA1111: 429 });
  let clock = 1000;
  const deps = { fetch: impl, keys: KEYS, now: () => clock };
  const first = await searchWeb({ query: "solar" }, deps);
  assert.equal(first.ok, true);
  assert.equal(first.slot, 2);
  assert.deepEqual(first.attempts, [
    { slot: 1, status: 429 },
    { slot: 2, status: 200 },
  ]);
  // Ring position is now 2; slot 1 is cooling so it never shows up in the next attempts.
  const second = await searchWeb({ query: "solar" }, deps);
  const third = await searchWeb({ query: "solar" }, deps);
  assert.equal(second.attempts.some((a) => a.slot === 1), false);
  assert.equal(third.attempts.some((a) => a.slot === 1), false);
  // After the 429 cooldown it is tried again.
  clock += 31000;
  const later = [];
  for (let i = 0; i < 3; i++) later.push(...(await searchWeb({ query: "solar" }, deps)).attempts.map((a) => a.slot));
  assert.ok(later.includes(1));
  assert.ok(calls.length > 4);
});

test("an unusable query stops at the first token instead of burning the ring", async () => {
  const { impl, calls } = fakeFetch({ jina_AAAA1111: 422 });
  const out = await searchWeb({ query: "??" }, { fetch: impl, keys: KEYS });
  assert.equal(out.ok, false);
  assert.equal(calls.length, 1);
  assert.match(out.error, /HTTP 422/);
});

test("when every token fails the error names slots but never a token", async () => {
  const { impl } = fakeFetch({ jina_AAAA1111: 402, jina_BBBB2222: 429, jina_CCCC3333: 500 });
  const out = await searchWeb({ query: "solar" }, { fetch: impl, keys: KEYS });
  assert.equal(out.ok, false);
  assert.equal(out.status, 502);
  assert.match(out.error, /#1: 402, #2: 429, #3: 500/);
  assert.equal(JSON.stringify(out).includes("jina_"), false);
});

test("no tokens saved is a clear 503, and an empty query is a 400", async () => {
  const { impl, calls } = fakeFetch();
  const none = await searchWeb({ query: "solar" }, { fetch: impl, keys: [] });
  assert.equal(none.status, 503);
  assert.match(none.error, /Settings/);
  assert.equal((await searchWeb({ query: "  " }, { fetch: impl, keys: KEYS })).status, 400);
  assert.equal(calls.length, 0);
});

test("results are snippet-only by default, capped by num, and never include tokens", async () => {
  const { impl, calls } = fakeFetch();
  const out = await searchWeb({ query: "solar panel price", num: 1 }, { fetch: impl, keys: KEYS });
  assert.equal(out.results.length, 1);
  assert.deepEqual(out.results[0], { title: "One", url: "https://a.example/1", snippet: "first" });
  assert.equal(out.tokens, 20);
  assert.equal(calls[0].headers["X-Respond-With"], "no-content");
  assert.match(calls[0].url, /\?q=solar%20panel%20price$/);
  assert.equal(JSON.stringify(out).includes("jina_"), false);
});

test("full mode asks for page text and returns it", async () => {
  const { impl, calls } = fakeFetch();
  const out = await searchWeb({ query: "solar", full: true }, { fetch: impl, keys: KEYS });
  assert.equal(calls[0].headers["X-Respond-With"], undefined);
  assert.equal(out.results[0].content, "page one");
});

test("testJinaKeys reports each token on its own", async () => {
  const { impl } = fakeFetch({ jina_BBBB2222: 401 });
  const out = await testJinaKeys({ fetch: impl, keys: KEYS });
  assert.deepEqual(
    out.map((r) => [r.slot, r.ok]),
    [
      [1, true],
      [2, false],
      [3, true],
    ],
  );
  assert.match(out[1].error, /HTTP 401/);
});

test("saved tokens are read in slot order and duplicates count once", async () => {
  await rememberSecret("jina_api_key_1", "jina_same");
  await rememberSecret("jina_api_key_2", "jina_same");
  await rememberSecret("jina_api_key_3", "  jina_other  ");
  await rememberSecret("jina_api_key_4", "");
  assert.deepEqual(jinaKeys(), [
    { slot: 1, key: "jina_same" },
    { slot: 3, key: "jina_other" },
  ]);
  for (const n of [1, 2, 3, 4]) await rememberSecret(`jina_api_key_${n}`, "");
});

test("only the per-boot search token is accepted by the internal endpoint", () => {
  const req = (auth) => ({ headers: auth ? { authorization: auth } : {} });
  assert.equal(searchAuthorized(req(`Bearer ${SEARCH_TOKEN}`)), true);
  assert.equal(searchAuthorized(req("Bearer nope")), false);
  assert.equal(searchAuthorized(req("")), false);
});

test("agents get the search endpoint only once a Jina token exists, and never the token", async () => {
  const before = agentEnv({ slug: "website" }, {}, { PORT: "8080", PATH: "/bin" });
  assert.equal(before.CLOUD_PI_SEARCH_URL, undefined);
  assert.equal(before.CLOUD_PI_SEARCH_TOKEN, undefined);
  await rememberSecret("jina_api_key_1", "jina_secret_value");
  const after = agentEnv({ slug: "website" }, {}, { PORT: "8080", PATH: "/bin" });
  assert.equal(after.CLOUD_PI_SEARCH_URL, "http://127.0.0.1:8080");
  assert.equal(after.CLOUD_PI_SEARCH_TOKEN, SEARCH_TOKEN);
  assert.equal(JSON.stringify(after).includes("jina_secret_value"), false);
  await rememberSecret("jina_api_key_1", "");
});
