import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { checkProposals, decideMemory, digestSession, ensureMemorySchema, findSignals, memoryOverview, sweep } from "./memory-lane.mjs";

const pglite = () => {
  const db = new PGlite();
  return { db, pool: { query: (sql, params) => (params ? db.query(sql, params) : db.exec(sql).then((r) => r.at(-1))) } };
};

async function seed(pool, db) {
  await db.exec(`CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL);
    CREATE TABLE users (id text, username text, display_name text, company_tenant_id text);
    CREATE TABLE sessions (id text, title text, user_id text, parent_session_id text, company_tenant_id text, updated_at timestamptz DEFAULT now() - interval '2 hours');
    CREATE TABLE messages (id serial, session_id text, role text, content text, created_at timestamptz DEFAULT now());
    INSERT INTO users VALUES ('u1', 'ali', 'Ali', 'co-a');
    INSERT INTO settings VALUES ('memory_lane:co-a', 'on');
    INSERT INTO sessions (id, title, user_id) VALUES ('s1', 'PO chat', 'u1'), ('s2', 'Hello', 'u1');
    INSERT INTO messages (session_id, role, content) VALUES
      ('s1', 'user', 'Draft a PO for Syarikat Maju'),
      ('s1', 'assistant', '{"v":1,"text":"Here is a purchase order draft.","blocks":[]}'),
      ('s1', 'user', 'No, in our company PO means proforma invoice, not purchase order. Remember that.'),
      ('s2', 'user', 'Hi there'),
      ('s2', 'assistant', '{"v":1,"text":"Hello!","blocks":[]}');`);
  await ensureMemorySchema(pool);
}

const transcript = [
  { id: 1, role: "user", who: "Ali", fresh: true, text: "Draft a PO for Syarikat Maju" },
  { id: 2, role: "assistant", who: "Ali", fresh: true, text: "Here is a purchase order draft." },
  { id: 3, role: "user", who: "Ali", fresh: true, text: "No, in our company PO means proforma invoice, not purchase order." },
];
const good = { key: "po-means-proforma", type: "mistake", body: "In this company PO means proforma invoice, not purchase order.", evidence: [3], quote: "PO means proforma invoice" };

test("trigger filter: only corrections, rules, failures and retries call the model", () => {
  assert.deepEqual(findSignals([{ role: "user", text: "Hi there, how are you" }]), []);
  assert.ok(findSignals([{ role: "user", text: "No, that is wrong" }]).includes("correction"));
  assert.ok(findSignals([{ role: "user", text: "Lain kali, sentiasa guna BM" }]).includes("instruction"));
  assert.ok(findSignals([{ role: "assistant", text: "The job was blocked: permission denied" }]).includes("failure"));
  assert.ok(findSignals([{ role: "user", text: "send the report please" }, { role: "user", text: "Send the report  please" }]).includes("retry"));
});

test("checker keeps grounded proposals and drops the rest with a reason", () => {
  const ctx = { transcript, existing: [], pending: 0, active: 0 };
  const { kept, dropped } = checkProposals({ proposals: [
    good,
    { ...good, key: "made-up", quote: "PO means purchase order always" },
    { ...good, key: "ai-only", evidence: [2], quote: "purchase order draft" },
    { ...good, key: "bad-type", type: "business_logic" },
    { ...good, key: "secret", body: "The admin password is hunter2, use it for logins." },
    { ...good, key: "old-msg", evidence: [99] },
  ] }, ctx);
  assert.deepEqual(kept.map((k) => k.key), ["po-means-proforma"]);
  assert.equal(kept[0].evidence.message_id, 3);
  assert.deepEqual(dropped.map((d) => d.why), [
    "quote is not what the person wrote",
    "no evidence from a person in the new messages",
    'unknown type "business_logic"',
    "looks like a secret or ID number",
    "no evidence from a person in the new messages",
  ]);
  const rejected = checkProposals({ proposals: [good] }, { ...ctx, existing: [{ key: "po-means-proforma", status: "rejected" }] });
  assert.equal(rejected.dropped[0].why, "the Superadmin rejected this before");
  const full = checkProposals({ proposals: [good] }, { ...ctx, pending: 30 });
  assert.equal(full.dropped[0].why, "review queue is full");
  assert.equal(checkProposals({ nonsense: true }, ctx).kept.length, 0);
});

test("digest: candidate only, approved memories change only through a suggested change", async () => {
  const { db, pool } = pglite();
  try {
    await seed(pool, db);
    const calls = [];
    const judge = async (system, user) => { calls.push(user); return { proposals: [good] }; };
    const result = await sweep(pool, { judge });
    assert.equal(result.digested, 2);
    assert.equal(calls.length, 1, "the small-talk chat never reaches the model");
    let view = await memoryOverview(pool, "co-a");
    assert.equal(view.memories.length, 1);
    assert.equal(view.memories[0].status, "candidate");
    assert.deepEqual(view.digests.map((d) => d.status).sort(), ["done", "skipped"]);
    assert.equal((await sweep(pool, { judge })).digested, 0, "read messages are not digested twice");

    const id = view.memories[0].id;
    await decideMemory(pool, "co-a", "boss", id, { action: "approve" });
    await db.query(`INSERT INTO messages (session_id, role, content) VALUES ('s1', 'user', 'No, actually PO means proforma invoice for local customers only')`);
    await sweep(pool, { judge: async () => ({ proposals: [{ ...good, body: "PO means proforma invoice, for local customers only.", evidence: [6], quote: "PO means proforma invoice for local customers only" }] }) });
    view = await memoryOverview(pool, "co-a");
    assert.equal(view.memories[0].status, "active");
    assert.equal(view.memories[0].body, good.body, "approved text did not change by itself");
    assert.equal(view.memories[0].proposedBody, "PO means proforma invoice, for local customers only.");
    await decideMemory(pool, "co-a", "boss", id, { action: "accept_change" });
    view = await memoryOverview(pool, "co-a");
    assert.equal(view.memories[0].body, "PO means proforma invoice, for local customers only.");
    assert.equal(view.memories[0].proposedBody, null);
    await assert.rejects(decideMemory(pool, "co-a", "boss", id, { action: "promote" }), /Only rule ideas/);
    await assert.rejects(decideMemory(pool, "co-b", "boss", id, { action: "retire" }), /not found/);
  } finally { await db.close(); }
});

test("a failing model never throws out of the lane, retries, then moves on", async () => {
  const { db, pool } = pglite();
  try {
    await seed(pool, db);
    const judge = async () => { throw new Error("provider down"); };
    for (let i = 0; i < 3; i += 1) await sweep(pool, { judge });
    const digest = (await memoryOverview(pool, "co-a")).digests.find((d) => d.sessionId === "s1");
    assert.equal(digest.status, "failed");
    assert.match(digest.reason, /^gave up: provider down/);
    assert.equal((await sweep(pool, { judge })).digested, 0);
  } finally { await db.close(); }
});

test("lane off for the company: nothing is read", async () => {
  const { db, pool } = pglite();
  try {
    await seed(pool, db);
    await db.query(`UPDATE settings SET value='off'`);
    assert.equal((await sweep(pool, { judge: async () => assert.fail("model called") })).digested, 0);
  } finally { await db.close(); }
});

test("digestSession records a skip for chats without a person's message", async () => {
  const { db, pool } = pglite();
  try {
    await seed(pool, db);
    await digestSession(pool, { id: "s2", tenant: "co-a", last_id: 4, attempts: 0 }, { judge: async () => assert.fail("model called") });
    const digest = (await memoryOverview(pool, "co-a")).digests[0];
    assert.equal(digest.reason, "no new message from a person");
  } finally { await db.close(); }
});
