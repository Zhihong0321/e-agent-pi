## Goal
Add a simple, read-only Activity Log page that shows, for each recorded system call:
- which agent handled it;
- which tools were used (including tool status/error);
- which authenticated user initiated it;
- when it happened and the related session/turn.

The page will live in the existing authenticated Settings console as a new `#activity` tab, rather than adding a new top-level workspace tab. This keeps operational/audit data separate from Agents/Chats/Live/Files and reuses the current settings auth and visual language.

## Findings driving the design
- The current database stores sessions/messages and orchestrator jobs, but tool calls are embedded in serialized assistant messages and are not queryable records.
- Sessions have `user_id`, `agent_id`, `engine`, and `model_id`, but messages/tool events do not have actor or call-level attribution.
- Pi and AGY streams already expose tool start/update/end data (`tool name`, call id, arguments/detail, result, error state), so instrumentation can be added at the existing stream boundary instead of changing the engines.
- `JobsSettings` is only a job summary and cannot answer user/tool questions.
- The current Settings page already uses hash tabs and authenticated fetches, and its existing table/card styles can support a compact log.

## Implementation plan

### 1. Add a normalized activity-event persistence module
Create `server/activity.mjs` with:
- an `activity_events` table migration (created from `connectDb()` or a dedicated migration helper);
- a single insert helper that accepts the request/session context and event payload;
- a paginated/filterable list helper.

Use a deliberately small schema, with nullable relationships so normal chat, management turns, and orchestrator work can all be represented:
- `id`, `occurred_at`;
- `user_id`, `session_id`, `parent_session_id`;
- `agent_id`, `agent_slug`/name snapshot, `engine`, `model_id`;
- `event_type` (for example `turn_started`, `tool_call`, `turn_completed`, `turn_failed`);
- `tool_name`, `tool_call_id`;
- redacted/clipped `detail`, `result`, and `error` fields;
- `status`, `duration_ms`;
- JSON metadata/correlation id where useful.

Add indexes for newest-by-time and the common filters (`user_id`, `agent_id`, `event_type`, `session_id`). Do not store secrets or full prompts/results by default; keep tool detail/result clipped and pass through a redaction helper for keys, cookies, tokens, and password-like fields.

### 2. Instrument the existing turn/tool boundaries
Update the server paths that already own the needed context:
- normal chat/streaming turns in `server/index.mjs`;
- management turns in `runManageTurn`;
- Pi tool events at the existing `applyPiEvent`/event callback boundary;
- AGY tool events at the existing AGY stream callback boundary;
- orchestrator task/attempt transitions only where the existing session/agent context is already available.

Record at minimum:
- a turn start event with current authenticated user, session, agent, engine, and model;
- one event per tool call, finalized on tool end with status/result/error and duration;
- a turn completed/failed event with total duration and tool count.

Thread the authenticated user id into the existing session/turn context instead of inferring it from message text. Ensure both newly created sessions and existing owned sessions retain the user id. Keep event writes non-blocking/failure-tolerant so an audit insert cannot break a chat turn; log persistence failures through the existing debug logger.

### 3. Add an authenticated read-only API
Add a route in `server/index.mjs`, for example `GET /api/activity`, protected by the same settings/session authentication used by the Settings console.

Supported query parameters:
- `limit` (bounded, default 100);
- `before`/cursor for pagination;
- `userId`, `agentId`, `eventType`, `toolName`, `status`, `sessionId`;
- `since` and `until` timestamps.

Return `{ events, nextCursor }` with display-safe fields. For non-admin users, constrain results to their own `user_id`; admins may view all users and use the user filter. Do not expose raw secrets, internal provider credentials, or unrestricted prompt/tool payloads.

### 4. Add the Settings Activity tab and page component
Create `app/activity-log.tsx` using the same request pattern as `app/jobs-settings.tsx`:
- load the newest events on mount;
- refresh button and optional auto-refresh toggle/interval (default manual refresh is sufficient for the first version);
- compact filters for user/agent/type/status/tool and time window;
- a responsive table on desktop with columns: Time, User, Agent, Event, Tool, Status, Session;
- a stacked/card layout or horizontal scroll on narrow screens;
- expandable row details for clipped tool detail/result/error and duration;
- empty, loading, and error states.

Keep the first UI intentionally simple: no destructive controls, no cleanup UI, and no editing. Use existing `settings-card`, `usage-log`, `models-table`, and `pre` styles; add only minimal activity-specific CSS if needed.

### 5. Register the new hash tab
Update `app/settings.tsx`:
- extend the `Tab` union and `TABS` array with `activity`;
- render `<ActivityLog />` when `tab === "activity"`;
- preserve current hash/query routing and auth gate.

### 6. Tests and verification
Add focused server tests for:
- event insertion/redaction and bounded field lengths;
- filtering/pagination and admin-vs-user visibility;
- tool start/end finalization and failed-tool recording.

Add frontend coverage if the project’s existing test setup supports component tests; otherwise verify the component through the existing build/typecheck and a black-box browser pass.

Run the targeted tests, then the normal build/typecheck. Verify manually that:
1. a user turn appears with the correct user and agent;
2. Pi and AGY tool calls show tool names and status;
3. an admin can filter by user;
4. a regular user cannot see another user’s events;
5. secrets are absent from displayed details;
6. the page remains usable on a narrow viewport.

## Expected files
- New: `server/activity.mjs`
- New: `app/activity-log.tsx`
- Likely: `server/db.mjs` (migration/table/index initialization)
- Likely: `server/index.mjs` (route and instrumentation/context propagation)
- Likely: `server/pi-stream.mjs` and `server/agy-stream.mjs` (event payload hooks, only if needed by the existing callback shape)
- Likely: `app/settings.tsx` and `app/globals.css`
- New/updated tests near existing server/app tests

The implementation should be incremental and backward-compatible: existing chat, jobs, and transcripts continue to work even if an activity insert fails, and historical events that were never normalized will not be fabricated from incomplete transcript data.