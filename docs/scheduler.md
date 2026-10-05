# Schedules

Open `/schedules` or choose **Schedules** in the workspace sidebar. Signed-in users can create one-time jobs, workspace reminders, internal email reminders, and daily, weekly, monthly, or five-field cron schedules. **Scheduler AI** exposes the same operations through native tools.

The page shows the saved target agent, timing and timezone, next due time, schedule status, last outcome, and run history. Owners and company admins can edit, pause, resume, or cancel schedules. AI run history links to the saved transcript. Private schedules are visible only to their owner and company admins.

AI jobs use an existing runnable Pi agent's exact catalog ID, model configuration, native tools, owner identity, and company context through the shared execution runner. AGY agents and Scheduler AI itself are excluded from scheduled targets. Instructions and activation authorization are saved per schedule revision.

Workspace reminders record their message in run history when due; they do not send push notifications. Email reminders use the existing internal mail service and require explicit confirmation of recipients/content/timing; supported recipients are @eternalgy.me addresses.

The host checks due work every five seconds. Occurrences have a unique schedule/time identity and durable claim, dispatch, execution reference, result, and delivery receipt. A schedule cannot start overlapping runs. Recurrence advances to the next future time; jobs more than 15 minutes late are marked missed without replaying a backlog. Pauses and edits apply to future dispatch, while an accepted run may finish.

On restart, accepted AI runs are reconciled from their execution records. Uncertain delivery/execution is marked blocked for inspection rather than repeated automatically. The worker rechecks the owner's active account, company membership, schedule revision, and activation authorization before dispatch. Model/provider failures remain visible in history.

Timing uses the selected IANA timezone (default Asia/Kuala_Lumpur). Cron fields: minute, hour, day of month, month, day of week. `0 9 * * 1` means Mondays at 09:00. Monthly day 31 skips months without that date. Invalid or nonexistent one-time local dates are rejected. Preview shows the next three occurrences before activation.

Validation: `npm run test:scheduler`, production Vite build, and the shared execution dispatcher/runner tests. Browser QA checks the desktop/mobile page, cron preview, pause controls, and transcript links.
