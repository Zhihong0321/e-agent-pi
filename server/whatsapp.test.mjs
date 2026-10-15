import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appendMarkdownBullet, createWhatsappStore, upsertContactNote } from "./whatsapp-store.mjs";
import { extractText, toUnixSeconds } from "./whatsapp-messages.mjs";
import { createSendLimiter, createWhatsappTools } from "./whatsapp-tools.mjs";

const DM = "60111111111@s.whatsapp.net";
const OTHER = "60122222222@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";

function memoryStore() {
  return createWhatsappStore(new DatabaseSync(":memory:"));
}

function message(store, overrides) {
  return store.upsertMessage({
    id: `m-${Math.random()}`,
    chatJid: DM,
    senderJid: DM,
    fromMe: false,
    pushName: "Alice",
    text: "hello",
    timestamp: 1000,
    ...overrides,
  });
}

test("a new message is stored once and names a direct chat from the sender's push name", () => {
  const store = memoryStore();
  assert.equal(message(store, { id: "a1", text: "hi there" }), true);
  assert.equal(message(store, { id: "a1", text: "hi there" }), false);
  const [chat] = store.listChats(10);
  assert.equal(chat.jid, DM);
  assert.equal(chat.name, "Alice");
  assert.equal(chat.is_group, false);
  assert.equal(chat.last_message_at, 1000);
});

test("group chats are not named from a member's push name", () => {
  const store = memoryStore();
  message(store, { id: "g1", chatJid: GROUP, senderJid: OTHER, pushName: "Bob", timestamp: 2000 });
  assert.equal(store.listChats(10)[0].name, "");
  assert.equal(store.listChats(10)[0].is_group, true);
});

test("an empty name never overwrites a known chat name", () => {
  const store = memoryStore();
  store.upsertChat({ jid: DM, name: "Alice Tan", lastMessageAt: 5 });
  store.upsertChat({ jid: DM, name: "", lastMessageAt: 3 });
  const [chat] = store.listChats(10);
  assert.equal(chat.name, "Alice Tan");
  assert.equal(chat.last_message_at, 5);
});

test("an outgoing message keeps the chat's name and is searchable", () => {
  const store = memoryStore();
  message(store, { id: "in1", text: "invoice please", timestamp: 1000 });
  message(store, { id: "out1", text: "sending it now", fromMe: true, senderJid: OTHER, pushName: "", timestamp: 1100 });
  assert.equal(store.listChats(10)[0].name, "Alice");
  const hits = store.searchMessages("invoice", "", 10);
  assert.deepEqual(hits.map((m) => m.id), ["in1"]);
  assert.equal(store.searchMessages("sending", DM, 10)[0].from_me, true);
});

test("resolveChat takes a JID as-is, a unique name fragment, and rejects ambiguous or missing names", () => {
  const store = memoryStore();
  store.upsertChat({ jid: DM, name: "Alice Tan", lastMessageAt: 1 });
  store.upsertChat({ jid: OTHER, name: "Alan Lee", lastMessageAt: 2 });
  assert.equal(store.resolveChat(GROUP), GROUP);
  assert.equal(store.resolveChat("Alice"), DM);
  assert.throws(() => store.resolveChat("al"), /multiple chats match "al"/);
  assert.throws(() => store.resolveChat("nobody"), /no chat found matching "nobody"/);
});

test("readChat pages newest-first and honours the before timestamp", () => {
  const store = memoryStore();
  for (const [id, timestamp] of [["p1", 100], ["p2", 200], ["p3", 300]]) {
    message(store, { id, timestamp, text: id });
  }
  assert.deepEqual(store.readChat(DM, 2).map((m) => m.id), ["p3", "p2"]);
  assert.deepEqual(store.readChat(DM, 2, 200).map((m) => m.id), ["p1"]);
});

test("a malformed FTS query reports a readable error", () => {
  const store = memoryStore();
  assert.throws(() => store.searchMessages('"unterminated', "", 5), /search failed \(check FTS query syntax\)/);
});

test("notes: remember appends a dated bullet and save_contact replaces the same contact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wa-notes-"));
  try {
    const memory = path.join(dir, "memory.md");
    const contacts = path.join(dir, "contacts.md");
    await appendMarkdownBullet(memory, "  reply in Malay to family  ", new Date(2026, 9, 12));
    const memoryText = await appendMarkdownBullet(memory, "call before 9am", new Date(2026, 9, 12));
    assert.equal(memoryText, "- [2026-10-12] reply in Malay to family\n- [2026-10-12] call before 9am\n");

    await upsertContactNote(contacts, "Alice", "potential client");
    const updated = await upsertContactNote(contacts, "alice", "signed up");
    assert.equal(updated, "- **alice**: signed up\n");
    await upsertContactNote(contacts, "Bob", "employee");
    assert.equal(await readFile(contacts, "utf8"), "- **alice**: signed up\n- **Bob**: employee\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the send limiter allows the cap per rolling hour", () => {
  let clock = 0;
  const limiter = createSendLimiter(2, () => clock);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), false);
  clock = 60 * 60 * 1000 + 1;
  assert.equal(limiter.allow(), true);
});

test("send_text resolves the chat, sends once, and stops at the hourly cap", async () => {
  const store = memoryStore();
  store.upsertChat({ jid: DM, name: "Alice", lastMessageAt: 1 });
  const sent = [];
  const tools = createWhatsappTools({
    store,
    sendText: async (jid, text) => {
      sent.push({ jid, text });
      return 4242;
    },
    limiter: createSendLimiter(1),
    memoryFile: "unused",
    contactsFile: "unused",
  });
  const send = tools.find((t) => t.name === "send_text");
  assert.deepEqual(await send.handler({ chat: "Alice", text: "ok" }), { sent: true, timestamp: 4242, chat_jid: DM });
  assert.deepEqual(sent, [{ jid: DM, text: "ok" }]);
  await assert.rejects(send.handler({ chat: "Alice", text: "again" }), /hourly send cap reached/);
});

test("required tool arguments are enforced", async () => {
  const store = memoryStore();
  const tools = createWhatsappTools({ store, sendText: async () => 0, limiter: createSendLimiter(5), memoryFile: "x", contactsFile: "x" });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await assert.rejects(byName.find_contact.handler({ query: "  " }), /query is required/);
  await assert.rejects(byName.send_text.handler({ chat: DM, text: "" }), /text is required/);
  await assert.rejects(byName.save_contact.handler({ contact: "x", note: "" }), /contact and note are required/);
});

test("extractText reads common message shapes and unwraps ephemeral and view-once wrappers", () => {
  assert.equal(extractText(undefined), "[no content]");
  assert.equal(extractText({ conversation: "plain" }), "plain");
  assert.equal(extractText({ extendedTextMessage: { text: "linked" } }), "linked");
  assert.equal(extractText({ imageMessage: { caption: "receipt" } }), "[image] receipt");
  assert.equal(extractText({ imageMessage: {} }), "[image]");
  assert.equal(extractText({ audioMessage: {} }), "[audio]");
  assert.equal(extractText({ ephemeralMessage: { message: { conversation: "disappearing" } } }), "disappearing");
  assert.equal(extractText({ viewOnceMessageV2: { message: { imageMessage: { caption: "once" } } } }), "[image] once");
  assert.equal(extractText({ stickerMessage: {} }), "[unsupported message type]");
});

test("toUnixSeconds accepts numbers, Long-like objects, and missing values", () => {
  assert.equal(toUnixSeconds(1700000000), 1700000000);
  assert.equal(toUnixSeconds({ toNumber: () => 1700000001 }), 1700000001);
  assert.equal(toUnixSeconds({ low: 1700000002, high: 0 }), 1700000002);
  assert.equal(toUnixSeconds(undefined), 0);
});

test("the store reopens an existing database file without losing rows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wa-db-"));
  try {
    const file = path.join(dir, "messages.db");
    const first = createWhatsappStore(new DatabaseSync(file));
    message(first, { id: "keep", text: "still here" });
    first.close();
    const second = createWhatsappStore(new DatabaseSync(file));
    assert.equal(second.searchMessages("still", "", 5)[0].id, "keep");
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
