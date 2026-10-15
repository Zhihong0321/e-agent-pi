// Owns the single WhatsApp Web connection (Baileys) for the host. Runs as a child
// process so a crash in the unofficial socket library cannot take the server down.
// Serves the WhatsApp MCP tools at /mcp and a localhost-only control surface
// (status, QR, unlink) that the host proxies into Settings.
import http from "node:http";
import path from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState as loadAuthState,
} from "@whiskeysockets/baileys";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import QRCode from "qrcode";
import { openWhatsappStore } from "./whatsapp-store.mjs";
import { extractText, isLidJid, toUnixSeconds } from "./whatsapp-messages.mjs";
import { buildWhatsappMcpServer, createSendLimiter, createWhatsappTools } from "./whatsapp-tools.mjs";

const DATA_DIR = process.env.WA_DATA_DIR || path.join(process.cwd(), "data", "whatsapp");
const MCP_ADDR = process.env.WA_MCP_ADDR || "127.0.0.1:8765";
const SEND_HOURLY_CAP = Number(process.env.WA_SEND_HOURLY_CAP) || 20;
const AUTH_DIR = path.join(DATA_DIR, "auth");
const QR_FILE = path.join(DATA_DIR, "qr.png");
const MEMORY_FILE = path.join(DATA_DIR, "memory.md");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.md");
const MAX_UNPAIRED_ATTEMPTS = 20;
const MAX_RECONNECT_DELAY_MS = 60_000;

const logger = pino({ level: process.env.WA_LOG_LEVEL || "silent" });
const log = (message) => console.log(`[whatsapp] ${message}`);

let store = null;
let limiter = null;
let tools = null;
let sock = null;
let creds = null;
let generation = 0;
let connectedSince = 0;
let attempts = 0;
let reconnectTimer = null;
let stopping = false;

function ownJid() {
  return creds?.me?.id ? jidNormalizedUser(creds.me.id) : "";
}

function isLinked() {
  return Boolean(creds?.registered);
}

async function canonicalJid(jid, alt) {
  if (!jid || !isLidJid(jid)) return jid || "";
  if (alt && !isLidJid(alt)) return alt;
  const pn = await sock?.signalRepository?.lidMapping?.getPNForLID(jid).catch(() => null);
  return pn || jid;
}

async function storeMessage(msg) {
  const key = msg?.key;
  if (!key?.id || !key.remoteJid) return false;
  const chatJid = await canonicalJid(key.remoteJid, key.remoteJidAlt);
  const fromMe = Boolean(key.fromMe);
  const senderJid = fromMe
    ? ownJid()
    : await canonicalJid(key.participant || key.remoteJid, key.participant ? key.participantAlt : key.remoteJidAlt);
  return store.upsertMessage({
    id: key.id,
    chatJid,
    senderJid,
    fromMe,
    pushName: msg.pushName || "",
    text: extractText(msg.message),
    timestamp: toUnixSeconds(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
  });
}

async function storeChat(chat) {
  const jid = await canonicalJid(chat.id);
  if (!jid) return;
  store.upsertChat({
    jid,
    name: chat.name || "",
    isGroup: jid.endsWith("@g.us"),
    lastMessageAt: toUnixSeconds(chat.conversationTimestamp),
  });
}

async function storeContact(contact) {
  const name = contact.name || contact.notify;
  if (!name) return;
  const jid = await canonicalJid(contact.id, contact.lid);
  if (!jid || jid.endsWith("@g.us")) return;
  store.upsertChat({ jid, name, isGroup: false });
}

async function sendText(jid, text) {
  if (!sock || !isLinked() || connectedSince === 0) throw new Error("WhatsApp is not connected yet");
  const sent = await sock.sendMessage(jid, { text });
  if (!sent?.key?.id) throw new Error("send failed");
  const timestamp = toUnixSeconds(sent.messageTimestamp) || Math.floor(Date.now() / 1000);
  store.upsertMessage({ id: sent.key.id, chatJid: jid, senderJid: ownJid(), fromMe: true, text, timestamp });
  return timestamp;
}

function listen(socket, gen, event, handler) {
  socket.ev.on(event, async (payload) => {
    if (gen !== generation) return;
    try {
      await handler(payload);
    } catch (error) {
      log(`${event} handling failed: ${error?.message || error}`);
    }
  });
}

async function handleHistory({ chats = [], contacts = [], messages = [] }) {
  for (const chat of chats) await storeChat(chat);
  for (const contact of contacts) await storeContact(contact);
  let stored = 0;
  for (const msg of messages) {
    if (await storeMessage(msg)) stored += 1;
  }
  log(`history sync: chats=${chats.length} contacts=${contacts.length} messages=${stored}`);
}

function onConnectionUpdate(update, gen) {
  const { connection, lastDisconnect, qr } = update;
  if (qr) {
    QRCode.toFile(QR_FILE, qr, { width: 512, margin: 2 }).catch((error) => log(`could not write QR image: ${error.message}`));
    log("QR code ready; scan it in WhatsApp (Linked Devices)");
  }
  if (connection === "open") {
    connectedSince = Math.floor(Date.now() / 1000);
    attempts = 0;
    rm(QR_FILE, { force: true }).catch(() => {});
    log("connected");
    return;
  }
  if (connection !== "close") return;

  connectedSince = 0;
  const code = lastDisconnect?.error?.output?.statusCode;
  log(`disconnected code=${code ?? "?"}`);
  if (code === DisconnectReason.loggedOut) {
    log("logged out from the phone; clearing the session so a new QR can pair");
    wipeAuth().then(() => startSocket()).catch((error) => log(`re-pair failed: ${error.message}`));
    return;
  }
  if (code === DisconnectReason.connectionReplaced) {
    log("replaced by another WhatsApp Web session; not reconnecting");
    return;
  }
  scheduleReconnect(gen);
}

function scheduleReconnect(gen) {
  if (stopping || gen !== generation) return;
  attempts += 1;
  if (!isLinked() && attempts > MAX_UNPAIRED_ATTEMPTS) {
    log("QR was not scanned after many attempts; stopped. Use Refresh QR in Settings to try again.");
    return;
  }
  const delay = Math.min(MAX_RECONNECT_DELAY_MS, 2000 * attempts);
  reconnectTimer = setTimeout(() => {
    startSocket().catch((error) => log(`reconnect failed: ${error.message}`));
  }, delay);
}

function stopSocket() {
  generation += 1;
  clearTimeout(reconnectTimer);
  const previous = sock;
  sock = null;
  previous?.end(undefined);
}

async function startSocket() {
  stopSocket();
  const gen = generation;
  const { state, saveCreds } = await loadAuthState(AUTH_DIR);
  if (gen !== generation) return;

  const config = {
    auth: state,
    logger,
    browser: Browsers.macOS("Desktop"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async () => undefined,
  };
  try {
    const { version } = await fetchLatestBaileysVersion();
    config.version = version;
  } catch (error) {
    log(`could not fetch latest WhatsApp Web version, using the library default: ${error.message}`);
  }

  const socket = makeWASocket(config);
  sock = socket;
  creds = socket.authState.creds;
  socket.ev.on("creds.update", () => {
    if (gen === generation) saveCreds().catch((error) => log(`could not save session keys: ${error.message}`));
  });
  socket.ev.on("connection.update", (update) => {
    if (gen === generation) onConnectionUpdate(update, gen);
  });
  listen(socket, gen, "messages.upsert", async ({ messages }) => {
    for (const msg of messages) await storeMessage(msg);
  });
  listen(socket, gen, "messaging-history.set", handleHistory);
  listen(socket, gen, "chats.upsert", async (chats) => {
    for (const chat of chats) await storeChat(chat);
  });
  listen(socket, gen, "chats.update", async (chats) => {
    for (const chat of chats) await storeChat(chat);
  });
  listen(socket, gen, "contacts.upsert", async (contacts) => {
    for (const contact of contacts) await storeContact(contact);
  });
  listen(socket, gen, "contacts.update", async (contacts) => {
    for (const contact of contacts) await storeContact(contact);
  });
}

async function wipeAuth() {
  creds = null;
  await rm(AUTH_DIR, { recursive: true, force: true });
  await rm(QR_FILE, { force: true });
}

async function unlink() {
  try {
    await sock?.logout();
  } catch (error) {
    log(`logout request failed, clearing the local session anyway: ${error.message}`);
  }
  stopSocket();
  await wipeAuth();
  await startSocket();
}

function status() {
  const me = creds?.me;
  return {
    linked: isLinked(),
    phone: me?.id ? me.id.split("@")[0].split(":")[0] : undefined,
    pushName: me?.name || undefined,
    connectedSince: connectedSince || undefined,
  };
}

function sendJson(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve(raw ? JSON.parse(raw) : undefined);
    });
    req.on("error", reject);
  });
}

async function handleMcp(req, res) {
  const body = req.method === "POST" ? await readBody(req) : undefined;
  const server = buildWhatsappMcpServer(tools);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function route(req, res) {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/mcp") return handleMcp(req, res);
  if (req.method === "GET" && pathname === "/status") return sendJson(res, 200, status());
  if (req.method === "GET" && pathname === "/qr.png") {
    if (isLinked()) return sendJson(res, 409, { error: "already linked" });
    const png = await readFile(QR_FILE).catch(() => null);
    if (!png) return sendJson(res, 404, { error: "no QR yet" });
    res.writeHead(200, { "Content-Type": "image/png" });
    return res.end(png);
  }
  if (req.method === "POST" && pathname === "/qr/refresh") {
    if (isLinked()) return sendJson(res, 409, { error: "already linked" });
    await startSocket();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && pathname === "/unlink") {
    await unlink();
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: "not found" });
}

function startHttp() {
  const [host, port] = MCP_ADDR.split(":");
  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      log(`request failed: ${error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
      else res.end();
    });
  });
  server.listen(Number(port), host, () => log(`MCP and control listening on ${MCP_ADDR}`));
}

function shutdown() {
  stopping = true;
  stopSocket();
  store?.close();
  process.exit(0);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  store = openWhatsappStore(path.join(DATA_DIR, "messages.db"));
  limiter = createSendLimiter(SEND_HOURLY_CAP);
  tools = createWhatsappTools({ store, sendText, limiter, memoryFile: MEMORY_FILE, contactsFile: CONTACTS_FILE });
  startHttp();
  await startSocket();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((error) => {
  log(`worker failed to start: ${error.message}`);
  process.exit(1);
});
