# Job Queue Manager — plan (2026-10-10)

## Purpose

Deliver **every** job within the server's limits. A request may be delayed; it is
**never** rejected, timed out or killed because of load. The user must never see
"server busy" / "too many requests".

The owner's warning: do not build a silent killer. Any timer, depth limit,
retry cap or "give up" path added to the waiting path is a defect.

## Design (owner's decisions)

One job queue manager sits between requests and the two scarce things:
starting a Pi process, and calling an LLM.

```
request -> [ Pi gate ] -> spawn Pi -> Pi calls LLM -> [ LLM gate, per provider ] -> provider
            max N Pi                                   max N concurrent
            at once                                    max X calls / minute
```

Both gates are the same primitive: a gate that lets N through and keeps the
rest in a plain FIFO line. Keep it small. No priorities, aging, per-tenant caps
or fairness logic until real use shows a tenant starving.

### Pi gate
- Caps concurrent Pi processes (protects the server from crashing). Default 3 (today's `PI_POOL_SIZE`).
- Replaces `acquireCapacity` in `server/execution/runner.mjs:101-111` and the capacity math in `tickInner` (`runner.mjs:695-763`).
- Must also cover the other start paths: legacy pool `getOrCreatePiSlot` / `startSlotClient` (`server/index.mjs:1085`, `:848`), `prewarmSlot` (`:974`), the v2 worker `piWorkerFactory` (`server/execution/pi-adapter.mjs:28`), legacy jobs `runJobTick` (`server/orchestrator.mjs:635`), agy (`server/agy-stream.mjs`), company-research / DI runs.
- Memory: high memory makes a new start **wait**; it never errors and never evicts a running job.

### LLM gate (one per provider)
- Caps concurrent calls and calls per minute.
- Pi child processes call providers directly with keys from `models.json`, so the server cannot throttle them today. The only way to queue them: `buildPiModelsJson` (`server/index.mjs:1718`) points each provider's `baseUrl` at a local server path; the server forwards to the real provider after the gate lets the call through. Streaming must be piped through (Hive AI is stream-only), holding the slot for the stream's lifetime.
- Upstream 429: the gate waits (honour Retry-After) and re-sends. The user never sees it.
- Server-side callers move onto the same gate and lose their private retry loops: `server/ads-research/portable/src/llm.mjs`, `document_inteligence/checker/judge.mjs`, `server/company-research/*`, `testModelRoundTrip` in `server/models.mjs`.
- Real provider errors (provider truly down) pass through unchanged. The gate neither invents nor hides errors.

### Control
Admin settings, changeable without a deploy:
- max Pi at once
- per provider: max concurrent calls, calls per minute
Provider limits: check the credential vault remarks (`D:\Tools\my-vault\vault.json`) first, else ask the owner.
Visibility: queue length and wait time in the existing status snapshot (`snapshot` in `server/index.mjs:432`, `executionHealth` in `server/execution/routes.mjs:71`).

## The never-kill contract

- No timeout on waiting, no maximum queue depth.
- A waiting request leaves the line only when it runs or when the user cancels it.
- The gate never stops, evicts or times out work that already started.
- If the gate code itself throws, the request proceeds as it does today (fail open).
- A waiting user sees "Queued, position N" and the connection stays alive (heartbeat).

## Existing kill/refuse points the gate must neutralise

Each needs a test.

1. `CAPACITY_UNAVAILABLE` after `admissionWaitMs: 20_000` — `runner.mjs:20,101-109`. Becomes an unlimited wait.
2. "Host is at memory capacity… try again in a minute" — `index.mjs:768` (`ensureMemoryHeadroom`). Becomes a wait.
3. "This chat already has an active run" CONFLICT — `runner.mjs:149`. A second message must queue behind the first, not be rejected.
4. Run / plan deadlines (`DEFAULT_LIMITS`, `request_deadline_at`, `tickInner` `REQUEST_DEADLINE` block at `runner.mjs:707-711`). Time spent waiting must not count against any deadline; a deadline measures running time only.
5. The 300 s "Worker went silent before finishing the turn" timer — `pi-adapter.mjs:119`. A Pi waiting at the LLM gate emits no events; the adapter must pause this timer while a call waits at the gate.
6. Also check what sits in front of the queue while a request waits: the chat HTTP route, Railway's proxy timeout, and the client retry in `app/use-studio.ts:528` (retries on 408/429/5xx). The heartbeat must keep the stream alive; `acceptChatRun` is called before any stream output today, verify.

## Invariants to keep

- No parent/child deadlock: an orchestrator must not hold a slot while waiting for children that need one (v2 `submitPlanHandler` ends the parent turn; test it). Legacy `maxParallelSlots = pool - 1` (`orchestrator.mjs:92`) stays until v1 is gone.
- Warm idle slots are not "active"; only running turns consume Pi-gate capacity. Idle eviction (`pi-idle.mjs`, `sweepIdleSlots`) is unchanged.
- Restart safety: queued work is rebuilt from `queued` rows in the DB (`reconcileOnStartup`, `runner.mjs:875`).
- Assumption: one Railway replica (the pool is in memory). If that changes, revisit.

## Build order

1. Gate module (`server/queue/`, pure, no IO) + unit tests for the contract: waits indefinitely, never rejects, cancel removes a waiter, a throw falls through, token bucket for per-minute rate.
2. Pi gate wired into all start paths; fix kill points 1-4 and 6.
3. LLM gate, one provider at a time (cheapest first), pass-through of real errors; fix kill point 5; move server-side callers onto it.
4. Admin settings (max Pi, per-provider limits) + queue length / wait time in the status snapshot.
5. Load test: fake upstream that randomly returns 429, ~30 concurrent chats from several tenants. Pass = zero rejections, Pi count never above the cap, nobody starved, every job finished.

Verification the owner can check: a test holding all slots for 60 s proves waiters are not rejected and run when a slot frees; a test where the gate throws proves the request still runs; grep the final diff for `reject` / `throw` / `setTimeout` on the waiting path and show it.

## Repo rules (AGENTS.md)

Commit only on `main`. Never create or switch branches. Preserve unrelated working-tree changes; the tree is shared with other sessions, so never stash, checkout or reset (see memory: shared worktree, shared index commits). Use `graft ask` / `graft callers` before grepping; run `graft build` after big changes. Prod deploys from push to main — do not push without the owner's say.
