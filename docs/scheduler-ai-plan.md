# Scheduler AI and calendar schedules

Status: proposed plan only; no feature implementation.
Prepared: 5 October 2026, Asia/Kuala_Lumpur.

## Recommendation

Introduce a separate Scheduler AI backed by a host-owned scheduling module in the existing Node server and Postgres. Add a Schedule entry point to the calendar page. Calendar AI continues to read and explain dates; Scheduler AI creates and manages scheduled items; the server watches the clock and dispatches due actions.

This separates responsibilities without introducing a second agent runner, deployment, or general workflow engine. The Scheduler AI does not need to stay running between requests. Notes and fixed email reminders do not require an LLM call when they become due.

## Current code and constraints

- `document_inteligence/host.mjs:77-83` describes Calendar AI as read-only. `agent/roles/di-calendar.md` expressly prohibits database writes and notifications.
- `document_inteligence/core/calendar.mjs:134-151` reads live company records and returns a bounded calendar feed. Its current business deadlines should remain derived from their original records.
- `app/demo/page.tsx:72-115` contains the calendar view, filters, agenda, and event details. `app/calendar.tsx:3-5` routes to that view.
- `server/ee-mail.mjs:38-50` requires confirmation after displaying recipients, subject, and body, and restricts recipients to `@eternalgy.me`. `server/ee-mail-mcp.mjs:4-18` registers the existing integration for designated agents.
- `server/execution/runner.mjs:132-174` accepts named agent runs and deduplicates submissions. `server/execution/runner.mjs:577-624` submits background plans with user/company identity and agent profile snapshots. This path currently rejects Orchestrator as a target and requires delegation privileges.
- `docs/agent-execution-architecture.md` is a proposed specification, not proof of implementation. Reuse verified current runner capabilities and reconcile any remaining migration before implementing scheduling.

## User model

A schedule is a dated item with a title, optional note, visibility, timing, and zero or more actions. Use simple presets while sharing the same storage and timing rules.

| Preset | Behavior | Example |
| --- | --- | --- |
| Note | Appears on the calendar; no timed execution | Site visit on Friday; bring the updated quotation |
| Email reminder | Sends the saved message at the selected time or offset | Remind me by email 30 minutes before the visit |
| AI job | Runs the selected agent with saved instructions | Ask the Sales AI for an outstanding invoice report every Monday at 9 AM |

A note can have a reminder. An AI job can also have a note and optional completion email. Keep reminder delivery and completion delivery distinguishable: each has its own trigger, authorization, and result.

Support one-time dates and daily/weekly/monthly recurrence first. Offer cron expressions as an advanced timing option in the final phase. Always preview the interpreted timezone and next three occurrences before activation. Use company timezone with `Asia/Kuala_Lumpur` as fallback; store execution instants in UTC. All-day notes require an explicit send time if a reminder is added.

## Responsibility boundaries

| Component | Owns |
| --- | --- |
| Calendar AI | Reading and explaining business dates and scheduled items |
| Scheduler AI | Turning user requests into schedules; creating, changing, pausing, and cancelling them |
| Host scheduler | Time calculations, occurrence creation, durable dispatch, recovery, and dispatch history |
| Existing execution runner | Executing the selected AI with its allowed tools, capacity limits, identity, and output contract |
| Existing email integration | Sending authorized reminder/completion messages and recording provider responses |

The calendar UI can open the schedule editor or Scheduler AI with the selected date. Calendar AI should not gain write, email, or unrestricted delegation permissions to support that entry point. Scheduler AI should manage scheduling metadata rather than inherit every specialist's business tools.

## Proposed storage and tools

Use host-level, company-scoped schedules because targets can include agents outside Document Intelligence. Scope every read and mutation by authenticated company and owner/access policy.

- `schedules`: identity, company, owner, title, note, visibility, timezone, timing rule, start/end bounds, next due time, status, revision, and source chat/record link.
- `schedule_actions`: reminder time or offset, email payload/template binding, or target agent and prompt; execution limits and notification settings.
- `schedule_occurrences`: unique schedule/action/nominal due-time key, captured revision, dispatch status, execution reference, delivery receipt, errors, attempts, and timestamps.
- Saved authorization: who activated which revision, recipient/body or constrained template scope, and authorized job instructions. Bind authorization to the action revision, not a model-provided boolean.

Expose named host tools following the execution registry conventions: `schedule_preview`, `schedule_create`, `schedule_list`, `schedule_update`, `schedule_pause`, `schedule_resume`, `schedule_cancel`, and `schedule_history`. Use revision checks to reject stale edits. Recompute future occurrences and require renewed authorization when recipients, message scope, target, instructions, or timing materially change.

## Dispatch and reliability

1. A server timer finds due actions in Postgres; no browser tab or active AI chat is required. Execution still requires the server and database to be available.
2. Atomically create/claim occurrences with unique due-time keys and recoverable leases. Multiple server instances must not dispatch the same occurrence independently.
3. Fixed reminders call the existing email delivery handler through the authorized integration path. AI jobs submit work through the existing runner with a stable occurrence submission key and owner/company context.
4. Use a dedicated persisted job session for each occurrence so scheduling does not inject prompts into a busy interactive chat. Retain the originating chat link for navigation.
5. Capture accepted instructions/profile metadata; resolve currently allowed tools and owner access at execution. A deleted target, revoked access, or unavailable integration becomes a visible blocked occurrence; never substitute another agent silently.
6. Apply existing capacity controls, duration limits, and an overlap policy. Default: defer an occurrence while the previous occurrence is active; expire it after its grace period and show that it was skipped.
7. Proposed missed-run default: dispatch at most the latest missed occurrence within a configurable grace period; record older ones as missed. Do not replay a backlog of reminder emails after an outage.
8. Retry known transient failures with bounded backoff. An email timeout after submission can have an unknown delivery outcome: reconcile using provider evidence/idempotency if supported, otherwise mark uncertain for review rather than automatically sending another email. Do not promise exactly-once external delivery.
9. Pausing/cancelling prevents future dispatch. Stopping an already running job is a distinct action through the runner; cancellation cannot recall an email already sent.

## Email authorization

The current email API is built for interactive confirmation. Scheduled delivery needs an explicit host policy extension: preview the message and timing when activating the schedule, then persist authorization for those future occurrences. Do not simply have a background model supply `confirm=true`.

Start with fixed reminder text and current internal-domain recipients. Completion email can later use a clearly previewed constrained template, with fixed recipients and defined output scope. Broader recipients require a separate decision and email policy change. No email is sent while preparing this plan.

## Targeting any AI

Make the agent selector catalog-driven, without hardcoded specialist names. Offer currently runnable agents the owner is allowed to use. Every occurrence uses the selected agent's tools and execution restrictions; scheduling must not grant extra authority.

The existing background-plan endpoint cannot target Orchestrator. To support the user's eventual “any AI” requirement, add a general scheduled-run submission contract around the shared runner that also supports top-level Orchestrator runs. Keep the existing ban on recursively delegating to Orchestrator. Until a profile/runtime passes the scheduled-run contract, display it as unavailable with a reason. Scheduler AI itself should not be a target initially, to prevent a scheduled request from recursively creating more schedules without a separate design.

## Calendar and management UI

- Add “Schedule” / “New schedule” to the calendar, opening an editor with Note, Email reminder, and AI job presets.
- Display authored items beside derived business deadlines, with distinct labels and a Schedules source filter. Keep the original business records as the source of their deadlines.
- Show scheduled occurrence dates in bounded calendar ranges; mark missed execution in history rather than silently shifting its date.
- Show exact time/timezone, next run, selected AI or recipients, active/paused state, last result, and Edit/Pause/Cancel/History actions.
- Provide Scheduler AI chat and an Upcoming/History list for recurring jobs. Link each AI result to its persisted execution report.

## Delivery phases and checks

1. **Notes and calendar integration:** storage, access policy, dated notes, editor, feed merge, Scheduler AI registration and CRUD tools. Check company isolation, revisions, bounded ranges, timezone rendering, and unchanged business deadlines.
2. **One-time email reminders:** durable claims, activation authorization, email integration, delivery history, restart recovery. Check duplicate claims across workers, edits/cancellation before dispatch, revoked access, known failure retry, and uncertain delivery handling.
3. **One-time AI jobs:** shared runner submission, dedicated sessions, catalog target validation, output links, capacity and overlap controls. Check owner/company propagation, deleted targets, exact submission deduplication, timeouts, and permission enforcement.
4. **Recurring schedules:** daily/weekly/monthly timing, advanced cron, end dates, missed-run policy, and optional completion email. Check next-occurrence previews, month boundaries, timezone/DST behavior, restart catch-up, and no backlog replay.

Complete each phase with integration checks before enabling its next action type. Refresh Graft after substantial implementation changes. Work only on `main` and preserve the existing unrelated working-tree changes.

## Proposed defaults for discussion

Separate Scheduler AI; entry point stays on the calendar; company-visible schedules with owner/admin editing; private visibility available for personal items; internal email recipients; explicit activation preview; no AI call for note/reminder dispatch; current runnable profiles first, followed by a tested top-level Orchestrator adapter; recurrence and cron after one-time execution works reliably.

These are planning defaults, not implemented behavior or authorization to create real schedules or send messages.
