## Goal
Add a database-backed, reviewable custom SOP for every persisted agent, with exactly one SOP per agent and runtime enforcement only for reviewed/approved SOPs.

## Implementation plan

1. **Add a Postgres SOP schema and repository module**
   - Create `server/sops.mjs` following the existing `server/blueprints.mjs`/catalog patterns.
   - Add idempotent startup SQL, invoked during server boot, for an `agent_sops` table keyed by `agent_id` with a foreign key to `agents(id)` and `ON DELETE CASCADE`.
   - Enforce `UNIQUE(agent_id)` at the database level so an agent can never have more than one SOP.
   - Store SOP title/content (or structured rules plus rendered content if the existing payload conventions require it), lifecycle status (`draft`, `pending_review`, `approved`, `rejected`), creator/reviewer IDs, review timestamps, and created/updated timestamps.
   - Provide repository functions for: list all/current SOPs for human review, fetch by agent, create the one missing SOP, update an unapproved SOP, and transition review status. Update operations must not permit changing an approved SOP in place without first returning it to an editable state; the one-row invariant remains intact.
   - Use authenticated user IDs for creator/reviewer fields; do not trust an approver name supplied by the browser.

2. **Wire schema initialization and API routes**
   - Call the SOP schema initializer from the same boot path that initializes the catalog/blueprint tables.
   - Add authenticated endpoints under an agent-scoped shape such as:
     - `GET /api/sops` for the review list, with agent metadata and current status.
     - `GET /api/agents/:agentId/sop` for the current SOP.
     - `POST /api/agents/:agentId/sop` to create the one SOP when none exists.
     - `PUT/PATCH /api/agents/:agentId/sop` to edit the current SOP while it is not approved.
     - `POST /api/agents/:agentId/sop/status` to submit, approve, reject, or retire it.
   - Validate agent existence and scope against the persisted `agents` table so the feature applies to catalog agents and Document Intelligence agents that are seeded into that table.
   - Require an authenticated user for reading/managing SOPs; require `role = admin` for approval/rejection/retirement transitions. Keep create/edit available to the permitted authenticated human/operator path used by the existing Settings management APIs.
   - Return clear conflict errors for duplicate creation and invalid status transitions.

3. **Integrate custom SOP into runtime enforcement**
   - Extend the agent runtime assembly in `server/runtime.mjs` (the `buildRoleText`/materialization path) to load the current SOP for the selected agent.
   - Inject only an approved SOP into the system role/context text, with a clearly delimited immutable section indicating that it is an enforced SOP. Do not place draft or rejected content into the runtime prompt.
   - Ensure the same behavior applies to orchestrator-dispatched specialists, since they already create sessions with an agent ID and materialize that agent’s normal runtime.
   - Decide and implement a fail-closed/visible behavior for agents without an approved SOP: mark them as unenforced and prevent claims that the SOP is active; preserve current operation if the product requires gradual rollout, but expose the missing-approval state to the UI/logging.
   - Invalidate/rebuild runtime materialization after SOP approval or edits, using the existing runtime reset/materialization mechanism so an approved SOP cannot remain stale in a running agent process.
   - Do not change the separate in-session `spawn_subagent` child loader unless a later requirement explicitly says child subagents must inherit the parent’s SOP; the current child model intentionally disables parent context/skills.

4. **Add Settings review and authoring UI**
   - Extend `app/settings.tsx` with an SOP view/panel modeled on the existing blueprint review UI.
   - Show every persisted agent, whether it has an SOP, current title/content, status, last reviewer, and review timestamp; include an explicit “unenforced/no approved SOP” state.
   - Add create/edit controls for an agent with no SOP or an editable SOP, and submit/review controls for status transitions.
   - Restrict approve/reject/retire controls in the UI for non-admin users, while retaining server-side authorization as the source of truth.
   - Display the one-SOP constraint and handle duplicate/conflict responses without silently overwriting another record.

5. **Cover tests and regression cases**
   - Add `server/sops.test.mjs` using the existing node:test/database test conventions.
   - Test schema constraints and lifecycle behavior: one SOP per agent, duplicate creation conflict, agent-delete cascade, editable vs approved transitions, and reviewer identity sourced from the authenticated user.
   - Test route authorization: unauthenticated access, non-admin review transitions, admin approval/rejection, agent-not-found, and invalid status transitions.
   - Test runtime assembly: approved SOP text is injected for the matching agent, draft/rejected text is excluded, and changing approval causes runtime re-materialization/reset.
   - Add focused UI/API integration coverage if the current frontend test setup supports it; otherwise verify the existing app build/type checks and exercise the HTTP routes with the server’s established test harness.

6. **Refresh repository context and verify**
   - Run the focused SOP/server tests plus the existing affected server tests and frontend checks.
   - Refresh the graft graph after the implementation so the new SOP module/routes/runtime edges are indexed.
   - Report any deliberate product choice around agents with no approved SOP (visible unenforced state versus blocking execution) and ensure the final behavior is reflected consistently in API, UI, and runtime.

## Expected files
- New: `server/sops.mjs`, `server/sops.test.mjs` (and any focused route/UI test file required by existing conventions).
- Update: `server/catalog.mjs` or the shared boot initializer, `server/index.mjs`, `server/runtime.mjs`, `app/settings.tsx`, and potentially runtime reset/cache helpers.
- No changes to agent role/context files are required for the first implementation; the database SOP becomes the editable source for custom per-agent SOP content.