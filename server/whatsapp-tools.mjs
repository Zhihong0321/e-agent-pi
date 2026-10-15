import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendMarkdownBullet, upsertContactNote } from "./whatsapp-store.mjs";

// Hard per-hour backstop on send_text, independent of the role's ask-before-send policy.
export function createSendLimiter(limit, now = () => Date.now()) {
  let sent = [];
  return {
    allow() {
      const cutoff = now() - 60 * 60 * 1000;
      sent = sent.filter((t) => t > cutoff);
      if (sent.length >= limit) return false;
      sent.push(now());
      return true;
    },
  };
}

const requireText = (value, message) => {
  if (!value || !String(value).trim()) throw new Error(message);
};

export function createWhatsappTools({ store, sendText, limiter, memoryFile, contactsFile }) {
  return [
    {
      name: "list_chats",
      description: "List recent WhatsApp chats with name, id, and last message time.",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("max number of chats to return, default 20"),
      },
      handler: async ({ limit }) => ({ chats: store.listChats(limit || 20) }),
    },
    {
      name: "find_contact",
      description: "Resolve a name fragment to WhatsApp chat ids.",
      inputSchema: { query: z.string().describe("name fragment to search for") },
      handler: async ({ query }) => {
        requireText(query, "query is required");
        return { matches: store.findContacts(query, 20) };
      },
    },
    {
      name: "read_chat",
      description: "Read the most recent messages of one WhatsApp chat (newest first). Pass the 'before' timestamp from the oldest returned message to page further back.",
      inputSchema: {
        chat: z.string().describe("chat id (from list_chats/find_contact) or a name fragment"),
        limit: z.number().int().positive().optional().describe("max number of messages to return, default 20"),
        before: z.number().int().optional().describe("only return messages before this unix-seconds timestamp, for paging further back"),
      },
      handler: async ({ chat, limit, before }) => {
        requireText(chat, "chat is required");
        const jid = store.resolveChat(chat);
        return { messages: store.readChat(jid, limit || 20, before || 0) };
      },
    },
    {
      name: "search_messages",
      description: "Full-text search over stored WhatsApp messages, optionally scoped to one chat.",
      inputSchema: {
        query: z.string().describe("full-text search query"),
        chat: z.string().optional().describe("optional chat id or name fragment to restrict the search to"),
        limit: z.number().int().positive().optional().describe("max number of messages to return, default 20"),
      },
      handler: async ({ query, chat, limit }) => {
        requireText(query, "query is required");
        const chatJid = chat ? store.resolveChat(chat) : "";
        return { messages: store.searchMessages(query, chatJid, limit || 20) };
      },
    },
    {
      name: "send_text",
      description: "Send one text message to one WhatsApp chat. Only call this after the owner has explicitly approved the exact text in the current conversation.",
      inputSchema: {
        chat: z.string().describe("chat id (from list_chats/find_contact) or a name fragment"),
        text: z.string().describe("the exact text to send"),
      },
      handler: async ({ chat, text }) => {
        requireText(chat, "chat is required");
        requireText(text, "text is required");
        if (!limiter.allow()) throw new Error("hourly send cap reached, try again later");
        const jid = store.resolveChat(chat);
        const sentAt = await sendText(jid, text);
        return { sent: true, timestamp: sentAt, chat_jid: jid };
      },
    },
    {
      name: "remember",
      description: "Save a custom instruction from the owner for next time (e.g. a standing preference or rule). Also shown to the owner in the Settings tab and editable there.",
      inputSchema: {
        note: z.string().describe("the instruction or fact to remember, in your own words"),
      },
      handler: async ({ note }) => {
        requireText(note, "note is required");
        return { saved: true, memory: await appendMarkdownBullet(memoryFile, note) };
      },
    },
    {
      name: "save_contact",
      description: "Save or update what you know about one contact that WhatsApp itself doesn't tell you, e.g. 'potential client' or 'employee, accounts team'. Calling it again for the same contact replaces the old note.",
      inputSchema: {
        contact: z.string().describe("the contact's name or phone number/JID, as you'd refer to them"),
        note: z.string().describe("what to remember about this contact, e.g. 'potential client', 'employee - accounts team'"),
      },
      handler: async ({ contact, note }) => {
        requireText(contact, "contact and note are required");
        requireText(note, "contact and note are required");
        return { saved: true, contacts: await upsertContactNote(contactsFile, contact, note) };
      },
    },
  ];
}

function reply(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error) {
  return { content: [{ type: "text", text: `Error: ${error?.message || error}` }], isError: true };
}

export function buildWhatsappMcpServer(tools) {
  const server = new McpServer({ name: "whatsapp", version: "1.0.0" });
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (args) => {
      try {
        return reply(await tool.handler(args));
      } catch (error) {
        return fail(error);
      }
    });
  }
  return server;
}
