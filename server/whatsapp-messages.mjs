const WRAPPER_KEYS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
];

function unwrap(message) {
  let current = message;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const inner = WRAPPER_KEYS.map((key) => current[key]?.message).find(Boolean);
    if (!inner) break;
    current = inner;
  }
  return current;
}

export function extractText(message) {
  if (!message) return "[no content]";
  const content = unwrap(message);
  if (content.conversation) return content.conversation;
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  if (content.imageMessage) return `[image] ${content.imageMessage.caption ?? ""}`.trim();
  if (content.videoMessage) return `[video] ${content.videoMessage.caption ?? ""}`.trim();
  if (content.documentMessage) return `[document] ${content.documentMessage.caption ?? ""}`.trim();
  if (content.audioMessage) return "[audio]";
  return "[unsupported message type]";
}

// Baileys reports timestamps as numbers or protobuf Longs.
export function toUnixSeconds(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "object") return typeof value.toNumber === "function" ? value.toNumber() : Number(value.low) || 0;
  return Number(value) || 0;
}

export function isLidJid(jid) {
  return typeof jid === "string" && jid.endsWith("@lid");
}
