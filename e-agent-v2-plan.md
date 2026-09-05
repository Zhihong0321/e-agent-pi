# E-Agent v2 — Chat Outcomes and Feedback — Build Plan

## End goal (one sentence)

Every chat in the PWA shows, without opening it, whether the agent is working,
waiting on the owner, done, or failed, and the owner can mark any finished chat
good or bad so failures can be traced to the agent, model, and prompt pack that
produced them.

## Design intent

- The chat is the task. There is no second object. A chat that turns out to be
  a question just ends in `done` with no deliverable, and that is fine.
- Status is declared by the agent or observed by the server. It is never guessed
  from the final text. A wrong badge costs more trust than no badge.
- The chat list keeps the WhatsApp vocabulary. Status is a small mark next to
  the preview, in the place a tick or an unread dot would be. No board, no
  columns, no drag.
- Feedback is one tap on the last reply. A reason is asked only on a bad mark,
  and only as three chips.
- The failure loop is a human loop. The owner reads a Failures page in Settings,
  edits the context pack, and watches whether the next week's failures move.
  Nothing trains anything automatically.

## What the MVP is

- Four new nullable columns on `sessions`, added with the same
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` pattern already in db.mjs:
  `state` (working, needs_user, done, failed), `deliverable` (short text),
  `blocker` (short text), `pack_hash` (from contextPackFingerprint at turn
  start).
- Two new nullable columns on `messages`: `rating` (good, bad) and
  `rating_reason` (wrong, incomplete, stuck, or free text).
- One new column on `debug_events`: `session_id`. Every logEvent call made
  inside a turn passes it in meta; persist() lifts it into the column.
- One Pi extension, `agent/extensions/report_status.ts`, attached to every Pi
  agent unconditionally in runtime.mjs next to the subagents line. It exposes a
  single tool `report_status(state, deliverable?, blocker?)` that returns "ok".
  The host reads the call from the turn's tool blocks after the turn ends and
  writes it to the session. No side channel, no socket, no file.
- One line added to the shared base prompt in the context pack: call
  report_status at the end of any turn where you built, changed, sent, or
  finished something, or where you are blocked and need the owner.
- Server-observed state, applied after the turn if the agent did not call the
  tool: `failed` when the last block is an error or the engine crashed or the
  auto-continue cap was hit; `needs_user` when the existing looksLikeQuestion
  check fires; otherwise `done`. `working` is set when a turn starts.
- Chat list: one mark per row (clock, blue dot, double tick, red mark) and a
  single filter strip above the list with All, Needs me, Working, Done, Failed.
- Chat view: the last assistant message gets a long-press (desktop: hover)
  thumbs up and thumbs down. Thumbs down shows three chips and an optional text
  box. One tap saves. No confirmation.
- Settings gets a Failures tab: sessions where state is failed, or any message
  is rated bad, newest first. Each row shows agent, model, engine, pack_hash,
  the rating reason, the deliverable or blocker text, and the last 30
  debug_events for that session. Rows group by pack_hash so a prompt edit can
  be judged against the version before it.

## What the MVP is not (guardrails)

Reject any of these if they appear in a task list, PR, or design note during
the MVP. Each is a later phase or never, not a refinement of this one.

- No `tasks` table, no task id, no task object separate from the session.
- No classifier that decides at chat start whether a message is a task or a
  question. The agent reports at the end; the server observes the rest.
- No task board, Kanban, columns, priorities, due dates, or assignment. One
  filter strip on the existing chat list is the entire task UI.
- No sub-task or dependency tracking. Subagent jobs stay inside their turn.
- No status inferred from regexes on the reply text beyond the one
  looksLikeQuestion check that already exists. Do not add new heuristics to
  make badges look smarter.
- No automatic prompt editing, no fine-tuning, no few-shot injection from rated
  messages, no "learning" pipeline. Rated messages are read by a person.
- No feedback form, survey, star scale, or separate feedback screen. Two
  thumbs, three chips, one text box.
- No notifications, push, email, or badges on the app icon for needs_user.
- No per-user anything. Single owner, as today.
- No rewrite of the chat list, the sidebar, or the session model to make room.
  Columns are added; nothing is renamed or moved.
- No agy engine extension. Agy sessions get server-observed state only in the
  MVP.
- No analytics dashboard, charts, success rates, or trends. The Failures tab is
  a list.

If a step is not needed to make the end-goal sentence true, it is out.

## Phases and done criteria

Each phase ends with a demonstration on the deployed Railway app, not a code
review. Do not start the next phase until the current one is demonstrated.

### Phase 0 — Record state
Columns added. report_status extension attached to every Pi agent. Base prompt
line added. Host writes agent-declared state, then server-observed state as a
fallback, at the end of every turn. debug_events carry session_id.

Done when, via the existing trace or sessions endpoint:
1. A chat where the agent finished a real job shows state done with a
   non-empty deliverable that the agent wrote itself.
2. A chat where the agent asked the owner a question shows needs_user.
3. A chat whose turn errored shows failed without any agent involvement.
4. The count of debug_events rows with a non-null session_id grows during a
   turn.

### Phase 1 — Show state and take feedback
Chat list marks and filter strip. Thumbs on the last assistant message with the
three chips on thumbs down.

Done when, on the phone:
1. Opening the app shows at a glance which chats need the owner, with no chat
   opened.
2. Tapping Needs me hides every other chat.
3. Thumbs down on a reply, picking a chip, and reloading the app shows the
   rating still there.

### Phase 2 — Failures tab (the end goal)
Settings tab listing failed and bad-rated sessions with agent, model, engine,
pack_hash, reason, deliverable or blocker, and the session's recent
debug_events, grouped by pack_hash.

Done when:
1. The owner rates a reply bad with reason "stuck", opens Settings, and finds
   that session in the Failures tab with the tool blocks and events that show
   where it stalled.
2. After editing the context pack, new failures appear under a different
   pack_hash than the old ones.

Phase 2 done means the MVP is done. Use it for two weeks before adding anything.

## After the MVP (do not pull forward)

In rough priority, to be re-evaluated after real use:
- A needs_user count on the app icon or a web push.
- Thumbs up examples surfaced next to the pack editor as reference, still
  pasted in by a person.
- A status convention for agy sessions (a trailing fenced block the host
  parses) so agy chats get agent-declared state too.
- Reopen: a done or failed chat that receives a new user message flips back to
  working. This may be needed sooner; decide after Phase 1 use.
- Deliverable links rendered as tappable cards in the chat list preview.

## Known risks (accepted for the MVP)

- Coverage depends on the base prompt line. A model that skips report_status
  falls to server-observed state, which is coarser but never wrong about
  failed.
- looksLikeQuestion is the one heuristic kept. It can mark a rhetorical question
  as needs_user. The owner opening the chat and replying fixes the state on the
  next turn.
- pack_hash changes whenever any context file changes, including runtime
  STATE.md if it is included in the fingerprint. Confirm contextPackFingerprint
  excludes runtime journal files before relying on grouping, or grouping will
  fragment.
- Ratings live on the message, not the session, so a chat with several finished
  jobs can carry mixed ratings. The Failures tab shows the session once with all
  its bad ratings; that is enough for reading, not for statistics.
