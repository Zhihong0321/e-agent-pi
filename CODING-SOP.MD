# Coding SOP

## Authority and purpose

This SOP applies to coding and maintenance in this repository. Read it together with `AGENTS.md` before starting work. The user's current instructions control the goal and scope. Existing architecture documents are references, not authorization to add their proposed features.

The owner's explicit instruction is:

> ADDED FEATURES, ADDED CONSIDERATION = MALICIOUS INTENT.
> You code to achieve my GOAL. Achieve what I want.
> NOT code according to your preference.

Treat unsolicited additions as a scope violation. Do not reinterpret a repair request as permission to redesign the product or implement an architecture you prefer.

## 1. Define the requested outcome

Before editing, write down the user's observable goal and the evidence that will prove it works. Keep this short and specific. For a chat repair, success means the requested action works, its answer reaches the screen, reload preserves it, and the next message has the same conversation context.

Do not substitute code volume, a new framework, an architecture document, a build, or isolated passing tests for the user's outcome.

## 2. Restrict the change

- Implement only what directly achieves the requested outcome.
- Do not add features, speculative requirements, dependencies, services, abstractions, alternate execution paths, or optional improvements.
- Reuse working behavior and existing APIs. Remove conflicting behavior when that is the required fix.
- Keep existing authentication, permissions, tenant boundaries, and business operations working. Their redesign is outside a workflow repair.
- Resolve routine implementation details autonomously within the authorized scope.
- If the requested outcome actually requires expanding scope, identify the concrete blocker and obtain the user's decision before that expansion. Do not manufacture hypothetical blockers or extra approval steps.

Every changed file must have a direct explanation: "This change is necessary for this requested behavior because ..." If that explanation cannot be made, leave the file alone.

## 3. Use evidence before diagnosis

Follow the Graft workflow in `AGENTS.md` before source searches or reads. Use exact spans and inspect truncated definitions when needed.

For a reported failure, correlate the actual request, Pi/tool events, business result, stored answer, and UI response. Separate verified facts from hypotheses. A screenshot alone is not proof that a tool never ran. A successful database operation alone is not proof that the user received its answer.

Correct a disproved diagnosis plainly. Do not hide failures, suppress errors to obtain a green result, or invent a cause when the logs do not identify it.

## 4. Keep the Pi integration simple

The conversational workflow is:

`User request -> existing host authentication and tools -> Pi conversation -> Pi answer -> saved answer -> UI`

Pi owns the model conversation and tool loop. The host supplies the existing context and tools, preserves the session, records the result, and exposes it to the UI.

- Preserve the Pi conversation across user messages and worker process changes.
- Let ordinary chat produce an ordinary Pi assistant answer. Do not make an extra completion tool a prerequisite for displaying it.
- Persist the same final answer used for live delivery, history, and reconnect.
- The UI displays server state. It must not invent continuation prompts or restart agent work after a transport failure.
- Register agents through the same conversational path. Adding an agent or restarting the server must not silently change that path.
- Keep existing background-task behavior outside the conversational repair unless a shared boundary must change to achieve the goal.

Do not add another coordinator around these responsibilities.

## 5. Work safely in the shared repository

Only work and commit on `main`. Never create or switch branches. If the current branch is not `main`, stop and report the mismatch.

Inspect the working tree first. Preserve unrelated user changes. Do not reset, stash, discard, overwrite, or include them in your commit. Do not deploy, change production records, or recreate an existing account as a side effect of diagnosis or documentation.

## 6. Prove the complete workflow

Verify the exact behavior being repaired through the real application boundary. Relevant checks must include the final visible answer and persisted history, not just an internal tool return or run status.

For conversational changes, check an initial request, a context-dependent follow-up, reload, and reconnect without duplicate execution. Use isolated test data for mutations. Check affected existing callers when a shared function changes. Do not build a new generic testing framework for the repair.

Run the appropriate existing tests and build. Record failures and unverified checks accurately. Mocked workers can test bookkeeping; they cannot establish that real Pi, persistence, and the UI work together.

## 7. Finish honestly

Report what changed, what observable behavior was verified, and any remaining failure. State when verification used mocks or did not reach the real application.

The work is complete only when the user's requested outcome works. If it remains broken, say so. Do not respond with another optional feature, redesign proposal, or unsupported promise of durability.
