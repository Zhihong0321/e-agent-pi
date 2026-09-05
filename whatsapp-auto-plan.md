# WhatsApp Automation for the Pi Agent — Build Plan

## End goal (one sentence)

From the UIv2 PWA, the owner can tell their Pi agent "what did Ali say about the
quote?" or "reply to Ali that we ship Monday", and the agent reads, searches, and
sends on the owner's real WhatsApp number.

## Design intent

- The WhatsApp session lives on the VPS, not the phone. It stays linked and
  receives messages whether or not the PWA is open.
- One small Go sidecar built on whatsmeow does all WhatsApp work and exposes its
  abilities to the Pi agent as an MCP server. Nothing else in the app learns the
  WhatsApp protocol.
- Text only. Media is never stored on the server in the MVP.
- The agent never sends without the owner saying yes in the chat first.
- The PWA only needs three things for WhatsApp: show the pairing QR, show the
  link status, and offer an unlink button.

## What the MVP is

- Single user: the owner's own number. No multi-user.
- One sidecar process spawned by the Node server at boot, restarted if it exits,
  listening on localhost only, state kept on the Railway volume (DATA_DIR) so it
  survives redeploys.
- Sidecar keeps its own SQLite file: whatsmeow session store plus a messages
  table with full-text search. History sync on first pairing fills it with about
  a year of text. Live messages in both directions append to it afterwards.
- Sidecar speaks MCP over HTTP with exactly these tools:
  1. list_chats — recent chats with name, id, last message time.
  2. find_contact — resolve a name fragment to chat ids.
  3. read_chat — last N messages of one chat, optional "before" cursor.
  4. search_messages — full-text search, optional chat filter.
  5. send_text — send one text message to one chat.
- Agent exposure is a catalog row, not code: one `mcp_servers` entry pointing at
  the sidecar, attached to one agent. runtime.mjs already writes it into that
  agent's mcp.json.
- Send policy is enforced by the agent's role instructions: draft the message in
  chat, wait for the owner's explicit yes, then call send_text. The sidecar adds a
  hard per-hour send cap as a backstop.
- Settings gets a "WhatsApp" tab copied from the Models tab pattern: QR image
  while unlinked, phone number and "connected since" when linked, unlink button.

## What the MVP is not (guardrails)

Reject any of these if they appear in a task list, PR, or design note during the
MVP. Each one is a future phase, not a refinement of this one.

- No multi-user, no per-user sessions, no tenant column, no user-scoped keys.
- No Postgres for messages. SQLite inside the sidecar is the store.
- No media download, upload, or storage. If a message is media, store its caption
  and a "[image]" style marker only.
- No draft queue, approval table, approval UI, or web push. Approval is a chat
  reply.
- No engine abstraction. whatsmeow is the engine. No interface for "other
  WhatsApp libraries".
- No separate repo, microservice, message bus, job queue, or retry framework.
  The sidecar is a folder in this repo built in the Dockerfile.
- No group-specific features. Groups are chats like any other.
- No read receipts, typing indicators, reactions, presence, or status posts.
- No new auth. The sidecar binds to localhost and the PWA reaches it only through
  the existing authenticated Node routes.
- No settings beyond QR, status, unlink. No retention knobs, no rate-limit knobs.
- No caching layer, no vector search, no embeddings. FTS is enough.
- No polishing of chat names, avatars, or contact photos.

If a step is not needed to make the end-goal sentence true, it is out.

## Phases and done criteria

Each phase ends with a demonstration, not a code review. Do not start the next
phase until the current one is demonstrated.

### Phase 0 — Prove the link
Sidecar alone, run locally. Pairs by QR printed in the terminal. Incoming and
outgoing messages print to the log. History sync count prints after pairing.

Done when: a message typed on the phone appears in the sidecar log within
seconds, and the sidecar reconnects on its own after a restart without a new QR.

### Phase 1 — Store and expose
Sidecar writes history and live messages to SQLite with FTS. Sidecar serves the
five MCP tools over HTTP.

Done when: using any MCP client against the sidecar, search_messages finds a
message from last month, read_chat returns recent messages of a named contact,
and send_text delivers a message that shows up on the phone.

### Phase 2 — Wire into UIv2 (the end goal)
Dockerfile builds the sidecar. Node spawns it at boot with restart-on-exit and a
health probe. One mcp_servers row is attached to one agent. Settings gets the
WhatsApp tab with QR, status, unlink. Agent role text gets the ask-before-send
rule.

Done when, on the deployed Railway app:
1. The owner pairs from the Settings tab by scanning the QR.
2. In the PWA chat, "what did <contact> last say?" returns the real message.
3. "reply to <contact> that <text>" produces a draft, the owner says yes, and the
   message arrives on the contact's phone.
4. After a redeploy the link survives with no new QR.

Phase 2 done means the MVP is done. Stop and use it for a week before polishing.

## After the MVP (do not pull forward)

In rough priority, to be re-evaluated after real use:
- Hard approval: send_text requires a token issued by an approve action in the PWA.
- Multi-user: per-user sidecar sessions, Postgres store, encryption at rest.
- Media: on-demand download for the agent to look at images and documents.
- Web push when the agent has a draft waiting.
- Local archive in the PWA for offline search.

## Known risks (accepted for the MVP)

- Unofficial client violates WhatsApp terms. Human-pace personal use keeps ban
  risk low. Never bulk send.
- If the sidecar is offline about 14 days the phone unlinks it. Pair again.
- Messages older than the history sync window are not searchable unless the
  phone re-syncs them on demand later.
- Approval is prompt-enforced in the MVP. A misbehaving model could send without
  asking. The hourly send cap limits the damage.
