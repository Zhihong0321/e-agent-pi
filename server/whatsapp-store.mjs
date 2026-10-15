import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  is_group INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  push_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, timestamp DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  id UNINDEXED,
  chat_jid UNINDEXED,
  sender_jid UNINDEXED,
  from_me UNINDEXED,
  push_name UNINDEXED,
  timestamp UNINDEXED,
  text
);
`;

const CHAT_COLUMNS = "jid, name, is_group, last_message_at";
const MESSAGE_COLUMNS = "id, chat_jid, sender_jid, from_me, push_name, text, timestamp";

function toChat(row) {
  return { jid: row.jid, name: row.name, is_group: row.is_group !== 0, last_message_at: row.last_message_at };
}

function toMessage(row) {
  return {
    id: row.id,
    chat_jid: row.chat_jid,
    sender: row.sender_jid,
    from_me: row.from_me !== 0,
    push_name: row.push_name,
    text: row.text,
    timestamp: row.timestamp,
  };
}

export function openWhatsappStore(file) {
  return createWhatsappStore(new DatabaseSync(file));
}

export function createWhatsappStore(db) {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);

  const upsertChatStmt = db.prepare(`
    INSERT INTO chats (jid, name, is_group, last_message_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      name = CASE WHEN excluded.name != '' THEN excluded.name ELSE chats.name END,
      is_group = excluded.is_group,
      last_message_at = MAX(chats.last_message_at, excluded.last_message_at)
  `);
  const insertMessageStmt = db.prepare(`
    INSERT OR IGNORE INTO messages (id, chat_jid, sender_jid, from_me, push_name, text, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFtsStmt = db.prepare(`
    INSERT INTO messages_fts (id, chat_jid, sender_jid, from_me, push_name, timestamp, text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  function upsertChat({ jid, name = "", isGroup = false, lastMessageAt = 0 }) {
    upsertChatStmt.run(jid, name, isGroup ? 1 : 0, lastMessageAt);
  }

  // Stores a message once, keyed by WhatsApp message id, and mirrors it into FTS.
  // Returns true when the message was new.
  function upsertMessage({ id, chatJid, senderJid, fromMe = false, pushName = "", text = "", timestamp }) {
    const { changes } = insertMessageStmt.run(id, chatJid, senderJid, fromMe ? 1 : 0, pushName, text, timestamp);
    if (changes === 0) return false;
    insertFtsStmt.run(id, chatJid, senderJid, fromMe ? 1 : 0, pushName, timestamp, text);
    const isGroup = chatJid.endsWith("@g.us");
    upsertChat({
      jid: chatJid,
      name: !fromMe && !isGroup ? pushName : "",
      isGroup,
      lastMessageAt: timestamp,
    });
    return true;
  }

  function listChats(limit) {
    return db
      .prepare(`SELECT ${CHAT_COLUMNS} FROM chats ORDER BY last_message_at DESC LIMIT ?`)
      .all(limit)
      .map(toChat);
  }

  function findContacts(query, limit) {
    const like = `%${query}%`;
    return db
      .prepare(`
        SELECT ${CHAT_COLUMNS} FROM chats
        WHERE name LIKE ? COLLATE NOCASE OR jid LIKE ?
        ORDER BY last_message_at DESC LIMIT ?
      `)
      .all(like, like, limit)
      .map(toChat);
  }

  // Accepts a chat JID or a name fragment; throws when a fragment is ambiguous.
  function resolveChat(input) {
    if (input.includes("@")) return input;
    const matches = findContacts(input, 5);
    if (matches.length === 0) throw new Error(`no chat found matching "${input}"`);
    if (matches.length > 1) {
      const names = matches.map((m) => `${m.name} (${m.jid})`).join(", ");
      throw new Error(`multiple chats match "${input}", be more specific: ${names}`);
    }
    return matches[0].jid;
  }

  function readChat(chatJid, limit, before = 0) {
    const rows = before > 0
      ? db
        .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat_jid = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`)
        .all(chatJid, before, limit)
      : db
        .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?`)
        .all(chatJid, limit);
    return rows.map(toMessage);
  }

  function searchMessages(query, chatJid, limit) {
    try {
      const rows = chatJid
        ? db
          .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages_fts WHERE messages_fts MATCH ? AND chat_jid = ? ORDER BY timestamp DESC LIMIT ?`)
          .all(query, chatJid, limit)
        : db
          .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages_fts WHERE messages_fts MATCH ? ORDER BY timestamp DESC LIMIT ?`)
          .all(query, limit);
      return rows.map(toMessage);
    } catch (error) {
      throw new Error(`search failed (check FTS query syntax): ${error.message}`);
    }
  }

  return { upsertChat, upsertMessage, listChats, findContacts, resolveChat, readChat, searchMessages, close: () => db.close() };
}

async function readNoteFile(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function writeNoteFile(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

// Appends a dated bullet, e.g. "- [2026-10-12] prefers morning calls".
export async function appendMarkdownBullet(file, note, today = new Date()) {
  const existing = await readNoteFile(file);
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const line = `- [${date}] ${note.trim()}`;
  const trimmed = existing.replace(/\n+$/, "");
  const content = `${trimmed ? `${trimmed}\n` : ""}${line}\n`;
  await writeNoteFile(file, content);
  return content;
}

// Replaces the bullet for `key` (case-insensitive "**key**" match) or appends one.
export async function upsertContactNote(file, key, note) {
  const existing = await readNoteFile(file);
  const cleanKey = key.trim();
  const line = `- **${cleanKey}**: ${note.trim()}`;
  const lines = existing.trim() ? existing.replace(/\n+$/, "").split("\n") : [];
  const prefix = `- **${cleanKey}**`.toLowerCase();
  const index = lines.findIndex((l) => l.trim().toLowerCase().startsWith(prefix));
  if (index >= 0) lines[index] = line;
  else lines.push(line);
  const content = `${lines.join("\n")}\n`;
  await writeNoteFile(file, content);
  return content;
}
