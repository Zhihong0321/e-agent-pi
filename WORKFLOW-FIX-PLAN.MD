# Plan to fix the Pi conversation workflow

Date: 2026-10-05 (Asia/Kuala_Lumpur).

Status: plan only; implementation has not started in this request.

Read `CODING-SOP.MD` and `AGENTS.md` before implementation. This plan repairs the existing conversational workflow. It does not authorize additional features or another framework rewrite.

## User goal

A simple request reaches Pi with the correct existing context and tools. Pi carries out the request and returns a readable answer. The same answer remains after reload. A follow-up continues that conversation. Adding an agent or restarting the server does not change this behavior.

Example: an authorized admin asks to add a user with a supplied username and password. The tool changes the record once, Pi reports the actual result, and a subsequent "done?" understands that request.

## Verified incident

Production chat: `3750f634-c1b5-4abc-8296-fde7dfc36529`.

On October 5, Malaysia time:

- 5:41:43 PM: `list_people` succeeded.
- 5:41:47 PM: `update_person` enabled login for the existing Gan Zhi Hong contact; the write was committed.
- 5:41:49 PM: completion was accepted with status `done` and a success summary.
- The saved assistant message had empty `text`; it contained thinking and tool blocks.
- The chat's `pi_session_id` and `pi_session_file` were both null.
- The next "done?" ran without the preceding conversation and returned `blocked / MISSING_INPUT`.

The account already exists and is active. Do not create it again to test this repair.

### Code-level cause (verified 2026-10-05)

Line numbers are as of this date; re-check them before editing.

- **Empty answer text:** `server/execution/pi-adapter.mjs:114-120` calls `pi.abort()` as soon as `finish_run` is accepted. The model called `update_person`, then `finish_run`, and was stopped before writing any answer. This produced a saved message with thinking and tool blocks but empty `text`.
- **Null session fields:** the execution-runner path passes `session.piSessionFile` to the worker (`server/index.mjs:3516` → `--session` at `server/runtime.mjs:242`), but nothing on that path writes the session reference back. Only the older chat path saves it (`server/index.mjs:1216-1224`). Every execution-runner turn therefore starts a blank Pi conversation, which is why "done?" lacked context.

The logs also contain `operator does not exist: text = uuid`. Its exact query has not been established. It did not prevent the account write. Do not claim it caused the incident or turn this repair into a repository-wide identifier migration.

## Repair contract

Use the existing execution path and Pi adapter. Pi supplies the conversational answer and owns the tool loop. The host owns the existing authenticated tool bridge, persistent Pi session reference, run record, and saved answer. The UI displays that saved answer and existing run state.

`Request -> authenticated host context/tools -> resumed Pi session -> Pi answer -> existing storage -> UI/history`

A worker process can be fresh while its Pi conversation is resumed. A closed browser connection does not mean the agent failed or the task should run again.

## Implementation sequence

Steps 1 and 2 fix the reported incident on their own. Implement and verify them first (greeting, tool-backed request, "done?" follow-up), then continue with steps 3, 4 and 5. A problem in step 5's routing change must not hold up the core fix.

### 1. Let conversational Pi turns return ordinary answers

Primary files: `server/execution/pi-adapter.mjs`, `server/execution/runner.mjs`, `agent/extensions/host-tools.ts`; relevant assembled role instructions only if they require the old conversational completion protocol.

- For conversational runs, remove the requirement to call `finish_run` and the completion-only follow-up prompt (`COMPLETION_ONLY_PROMPT`, `server/execution/runner.mjs:315`).
- Remove the abort-on-`finish_run` behaviour for conversational runs (`server/execution/pi-adapter.mjs:114-120`); it is what cut off the incident's answer.
- Decide chat vs. background by run kind (`kind === 'chat'`), not by prompt content. `specialistPrompt` (`server/execution/runner.mjs:802-826`) and `COMPLETION_ONLY_PROMPT` serve both kinds; only the chat side changes.
- A chat run's outcome becomes "Pi settled without error" or the actual Pi error/cancellation. Chat runs no longer carry a model-reported `done/blocked/failed` status; this is intended.
- Do not expose instructions telling conversational Pi turns to stop at `finish_run`. Let Pi complete its normal tool loop and produce its assistant answer.
- Capture the final answer and actual Pi error/cancellation state from the runtime. Do not infer business success from a guessed interpretation of the answer.
- Adapt the existing chat-run finalization to that result. Keep existing tool calls and their committed effects recorded.
- Keep the existing typed completion behavior for specialist background tasks. Check the shared callers, including scheduled runs, so this change does not remove their existing output.

Acceptance: a plain greeting and a tool-backed request both return readable answers without a conversational `finish_run` requirement. A Pi failure remains visible as a failure.

### 2. Preserve the Pi conversation

Primary files: `server/execution/pi-adapter.mjs`, `server/execution/runner.mjs`, the existing session wiring in `server/index.mjs` and `server/db.mjs`.

- Resume already works when a session file is known (`--session`, `server/runtime.mjs:242`). The missing piece is saving the reference back on the execution-runner path, as the older path does at `server/index.mjs:1216-1224`.
- Check where the session file is stored before writing code. Each run uses its own folder, `DATA_DIR/runtime/execution/<attemptId>` (`server/execution/pi-adapter.mjs:35`). No cleanup of it was found, but unless `DATA_DIR` is on a persistent Railway volume, the file will not survive a redeploy and the restart check will fail. Confirm persistence, or store the session file in a stable per-chat location under existing storage.
- Obtain Pi's actual session identity using its existing state API and save it to the existing chat session fields before accepting the turn as ready.
- Pass that saved session reference to the next conversational worker.
- If a known session file is unavailable, report the concrete problem. Do not silently replace the conversation with a blank one and claim continuation.
- Use the existing session storage and ownership checks; introduce no parallel memory store.

Acceptance: request one is remembered by request two, including after worker disposal and a normal server restart. Independent chats retain independent context.

### 3. Save the exact answer the user receives

Primary files: `server/index.mjs`, `server/execution/runner.mjs`, `server/pi-stream.mjs`; existing storage functions as needed.

- Make the final Pi answer the value used for the existing assistant message, run outcome, and final response.
- Finish persistence before sending the terminal response. Retain incremental streaming through the existing turn persister.
- Make normal completion and replay read the answer associated with that run. Do not recover a replay from whichever assistant message happens to be latest in the chat. Today the deduped replay branch does exactly that and prefers `outcome.summary` (`server/index.mjs:3527-3532`).
- Remove the mismatch where the response uses a completion summary while the saved transcript uses empty streamed text.
- For the existing affected chats, allow history rendering to use an already recorded completion summary when their saved text is empty. Do not execute their tools again or rewrite unrelated records.

Acceptance: the live answer, the answer after reload, and the answer after reconnect agree. The reported incident's recorded success can be read without rerunning user creation.

### 4. Remove UI-generated continuation work

Primary files: `app/use-studio.ts`, `app/studio.ts`, existing chat replay/status handling in `server/index.mjs`.

- Remove the automatic submission of `CONTINUE_PROMPT` for conversational transport recovery (`app/use-studio.ts:605`).
- The server has its own auto-continue loop on the older chat path (`AUTO_CONTINUE_PROMPT`, `server/index.mjs:3591`). Once step 5 routes every Pi agent through the execution runner, that loop becomes unused; remove it then rather than preserving it.
- Stop labeling every dropped stream as a host restart.
- Use the existing persisted run/status/history and submission replay behavior to reconnect to the submitted work.
- If a transport retry is necessary, retain the original request payload and its submission key. Do not replace the message, omit its attachments, or create a new task under the same key.
- Keep explicit user Stop behavior. Closing or reconnecting the stream must not duplicate a committed tool operation.

Acceptance: dropping the browser connection during a turn adds no invented user message and no second business write. Returning to the chat shows the saved result.

### 5. Make agent routing consistent

Primary files: `server/index.mjs`, `server/execution/profiles.mjs`, relevant existing catalog call sites.

- Remove conversational routing's dependence on the startup snapshot of migrated agent IDs (`setMigratedProfiles` at `server/index.mjs:2071-2072`).
- `isMigratedProfile` also decides whether the user-management and identity prompts are injected (`server/index.mjs:3404-3408`). Change it together with the routing check at `server/index.mjs:3498`, so a new agent cannot get the new path with the old prompt injection.
- Resolve the conversational path from the current agent's existing engine configuration. Existing Pi agents and newly created Pi agents must use the same repaired path immediately.
- Stop retaining the old conversational path as a silent fallback for agents missing from that snapshot. Remove code made unreachable by this change only where it belongs to this repair; do not rewrite other engines or unrelated specialized runners.
- Verify that the existing role, skills, tools, signed-in user context, model selection, and attachments reach the worker through this path.

Acceptance: an existing Pi agent and a Pi agent added during runtime have the same conversation behavior before and after restart.

## Verification and completion

Use the real Pi runtime, the existing application routes, and isolated business data. Scripted model replies may make transport timing reproducible, but must not replace Pi, the tool bridge, persistence, or business handlers. Also check the configured live model through the repaired path. Keep tests bounded to this repair and extend existing test files where practical.

| Check | Required result |
| --- | --- |
| Plain greeting | Readable final answer; no custom completion-tool requirement. |
| Add a disposable test login | Account mutation occurs once; visible answer reports the actual result. |
| Follow with "done?" | Same conversation; correct reference to the preceding request. |
| Reload after completion | Same final answer remains. |
| Drop/reconnect during the write | Existing run is recovered; no synthetic prompt or duplicate mutation. |
| Normal server restart between messages | Saved Pi context resumes and the prior answer remains available. |
| Add a Pi agent during runtime | Same chat path immediately and after restart. |
| Existing Stop and affected background callers | Existing cancellation and completion behavior still works. |

Run the affected existing test suites and production build. A successful build or mocked-worker test is not evidence that the table above passes. Record the actual inputs, run identity, committed tool result, saved answer, and rendered answer for the tool-backed case; exclude passwords from the evidence.

If the logged text/UUID error obstructs these checks, identify and fix its exact query/type boundary within the affected workflow. Do not guess or expand into a schema redesign.

Implementation is complete only when the required checks pass through the real application. Report any failed or unverified check explicitly. Follow the repository's `main`-only rule and preserve unrelated changes. Any subsequent deployment must follow the user's actual authorization; this documentation request performs no deployment.

## Scope exclusions

No new features, UI redesign, agent capabilities, models, dependencies, orchestrator service, generic retry framework, alternative conversation store, or speculative durability machinery. Do not implement unrelated proposals from older architecture plans. Every code change must be necessary to make the existing workflow above work.
