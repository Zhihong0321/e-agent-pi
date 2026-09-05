# Architecture review — Pi instance handling, performance, stability

Date: 2026-09-05. Reviewer: Claude Fable 5.1 (senior-architect pass).
Scope: `server/index.mjs` Pi pool, `server/pi-idle.mjs`, `server/proc.mjs`, `server/runtime.mjs`, `server/metrics.mjs`, `server/agy-stream.mjs`, deploy config, plus 24 h of live samples and the event log from the running host (`/api/metrics`, `/api/debug`, `/api/health` on e-agent.up.railway.app, read at 04:04 UTC).

---

## 1. Verdict

The pool design is sound and the code is careful: per-agent+model processes, per-slot and per-agent locks, an idle sweep that never kills a busy or booting slot, a leaked-child reaper, process-tree kills, and a shutdown that waits for in-flight turns. For a single-operator studio this is above average.

But the one thing you asked for, "keep 1 instance alive so any session starts instantly", is **only half true in production**:

| Claim | Reality on the live host |
|---|---|
| One Pi stays warm | Yes, **within one server process**. The last-used slot lived 14 h straight (13:41 → 03:47) and served later chats without a restart. |
| Any session = direct start | **No after a restart or deploy.** Nothing pre-warms on boot. Both restarts in the last 24 h (12:48 and 03:47 UTC) left the pool at 0. The health endpoint right now reports `piPoolSize: 0`. The next message after every deploy pays the full cold start. |
| Switching agents is instant | **No.** Keep-warm is global (`PI_KEEP_WARM=1`), so using Sales then Website evicts Sales after 3 min. Every agent switch after that is a cold start. |
| 6 GB RAM available | **The container sees a 2,861 MB cgroup limit.** Peak usage in the window was 1,916 MB (67 % of the limit) during one turn with 36 child processes. Check the plan, or if a real 6 GB VPS is the next step, the numbers below tell you how to size it. |

Also: the "15 s boot" is not the spawn. From `starting Pi` to `Pi client started` is ~110 ms in the log. The wait the user feels is Pi's own init (skills, MCP adapter, `--session` resume of a large jsonl) plus the model's first token, and none of that is measured today. Section 4 says how to instrument it before tuning it.

---

## 2. What the live host shows (24 h, 5,762 samples at 15 s)

| Metric | Value |
|---|---|
| Container memory limit | 2,861 MB |
| Container RSS avg / peak | 407 MB / 1,916 MB |
| Node host RSS avg / peak | ~200 MB / 369 MB |
| Children RSS peak (Pi + MCP + subagents + Chromium) | 1,685 MB |
| Child process count peak | 36 |
| Container CPU avg / peak | 0.5 % / 96 % |
| Samples with a Pi alive | 89 % |
| Alive stretches | 15; longest 14 h 6 min (4 children, 368 MB); many 1–20 min stretches on 09-04 morning (deploys/resets) |
| Restarts in window | 2 (both clean `shutdown` → `boot complete` ~7 s) |

Three things fall out of this:

1. **Idle cost is small.** A warm Pi with one lazy MCP costs ~150–370 MB. Keeping two or three warm is affordable.
2. **Burst cost is large and unbounded.** One agent turn reached 36 children and 1.7 GB. That is subagent fan-out (`CLOUD_PI_SUBAGENT_MAX` defaults to 3, each child is a full Pi process that can itself hold MCP servers and Chromium). With `PI_POOL_SIZE=3` and two such turns overlapping on different agents, the container would exceed 2.8 GB and be OOM-killed with no warning, because nothing in the host looks at memory before starting a process.
3. **`load1` in the metrics (8–13) is the Railway host's load, not yours.** It is misleading on shared infrastructure and should not drive decisions. `containerCpuPct` is the right signal.

---

## 3. How the Pi lifecycle works today (and where it is good)

Reference points: `server/index.mjs`.

- **Pool key** = agent id + skill ids + MCP ids + role hash + context-pack fingerprint + model + imagen config (`agentBundleKey`, L378). Any config change yields a new key, so a stale process is never reused. Good.
- **Reservation** (`withPoolReserve`, L412) only guards the map lookup; `pi.start()` runs outside it, so a slow cold start for one agent never blocks another. Good.
- **Per-slot lock** (`withSlotLock`, L446) marks the slot busy for the duration of a turn and stamps `lastUsedAt` after. **Per-agent lock** (`withAgentLock`, L427) serializes chat + publish + journal per agent. Good for correctness.
- **Idle sweep** every 30 s (`sweepIdleSlots`, L504 → `pickIdleSlots`, `pi-idle.mjs`): keeps the N most-recently-used *live, non-busy, non-booting* slots, evicts the rest after 180 s idle. Unit-tested. Good.
- **Leak reaper** (`reapLeakedChildren`, `proc.mjs` L146): kills orphaned Pi/MCP/Scrapling processes older than 60 s that are not under a live slot's tree. This exists because the host is PID 1 in the container. Good and necessary.
- **Stop** (`stopSlot`, L474): removes from the pool, waits for the slot lock (so an in-flight turn finishes), `client.stop()`, then `killTree`. **Shutdown** (L2103) does this for all slots, so a deploy waits for in-flight turns up to Railway's SIGTERM grace. Good.
- **Restart on failure** (`ensurePiOnSlot`, L665): if `getState()` throws, the slot is restarted in place with the session file, then the turn proceeds. Good recovery path.
- **Turn wait** (`waitUntilAgentSettled`, L852): inactivity-based rather than wall-clock, so long tool-heavy turns are not killed. Good; this replaced a real bug in the upstream `waitForIdle`.

This is a well-reasoned design. The gaps are in what is *not* there: boot pre-warm, memory awareness, proactive dead-process detection, per-agent warmth, and instrumentation of the cold-start path.

---

## 4. Findings, ranked

### F1. Keep-warm does not survive a restart, so the first chat after every deploy is cold — **high**

- Where: `bootServices` (`server/index.mjs` L1101–1267) never creates a slot. `pickIdleSlots` only *protects* an existing slot from eviction.
- Evidence: pool empty after both restarts; `piPoolSize: 0` on `/api/health` now, 17 min after boot.
- Fix: persist the last-used `{agentId, modelId}` (a `settings` row, written in `getOrCreatePiSlot`). At the end of `bootServices`, after `boot.ready = true`, call `getOrCreatePiSlot` for that pair (and optionally for a fixed list in `PI_PREWARM_AGENTS`). Fire-and-forget with a log line; never block the health check on it. Cost: one process, ~150–300 MB, started while nobody is waiting.

### F2. Warmth is global, not per agent; every agent switch after 3 min is a cold start — **high**

- Where: `PI_KEEP_WARM=1` (L149) applies across the whole pool.
- The measured idle cost of a slot is small (see §2). Set `PI_KEEP_WARM=2` (or 3 on a real 6 GB box) so the two agents you actually alternate between both stay warm. Consider a per-agent pin (`PI_PIN_AGENTS=sales,website`) that the sweep never evicts; it is a five-line change in `pickIdleSlots` (pass a `pinned` set).

### F3. No memory-aware admission; burst fan-out can OOM the container silently — **high**

- Where: `getOrCreatePiSlot` (L610) and `evictIfNeeded` (L497) count slots, never bytes. `startSlotClient` (L525) spawns unconditionally. Subagents (`agent/extensions/subagents.ts` L45, `MAX_RUNNING=3`) multiply this inside one slot.
- Evidence: peak 1,916 MB of a 2,861 MB limit with 36 children in one turn.
- Fix, in order of effort:
  1. Set `CLOUD_PI_SUBAGENT_MAX=2` in the deploy env until the budget is known.
  2. Before spawning in `startSlotClient`, read `cgroupMemory()` (already in `metrics.mjs`). If `used / limit > 0.75`, evict the LRU idle slot first; if still over, throw a clear "host is at memory capacity, try again in a minute" error instead of letting the kernel choose the victim.
  3. Add the same check to the idle sweep: when over 60 % and more than `PI_KEEP_WARM` slots are live, evict extras immediately regardless of `idleMs`.

### F4. A dead Pi process is not noticed until the next turn — **medium**

- Where: `startSlotClient` never subscribes to the child's `exit`. `pickIdleSlots` treats any slot with `client` set as live. `piAlive` in metrics is the same test.
- Effect: after an OOM-kill or crash, the slot looks warm, the next turn calls `getState()`, waits up to the RPC's 30 s timeout (`rpc-client.js` L459), then restarts. The user pays 30 s plus a cold start, and `/api/health` lied in between.
- Fix: after `pi.start()`, do `pi.process?.once("exit", () => { if (slot.client === pi) { slot.client = undefined; slot.pid = null; logEvent("warn", ...) } })`. Also have `sweepIdleSlots` drop any slot whose `pid` fails `pidAlive`. Both are cheap and make F1's pre-warm self-healing (re-warm on exit when idle).

### F5. The cold-start path is not instrumented, so "15 s" cannot be attributed — **medium**

- What is logged: `starting Pi` and `Pi client started` (110 ms apart). What is not: time to first successful `getState`, time for `switchSession` to load the jsonl, time to first `message_start`/token, MCP adapter connect time.
- The in-memory event ring is 80 entries and the DB read is `LIMIT 50` (`debug.mjs` L3, L60). Two boots plus a few chats push everything else out; I could not reconstruct why the Sales slot restarted between 12:25 and 12:30 on 09-04 from what remains.
- Fix: emit one structured `turn metrics` line (you already have `turnMetrics`, L2035) with `spawnMs`, `readyMs` (spawn → getState ok), `sessionSwitchMs`, `firstTokenMs`, `totalMs`, `childrenAtEnd`. Raise `loadRecentFromDb` to 200 and add `?level=`/`?since=` filters. Then set the boot-beat floor from data instead of a guess.

### F6. Per-turn hot-path work that should be gated or moved off the lock — **medium**

All of this runs sequentially inside the agent lock before the `done` frame reaches the browser:

| Step | Where | Cost | Recommendation |
|---|---|---|---|
| `refreshSlotRuntime` on every turn of a warm slot | L517, called from L640 | Re-reads models JSON, rewrites `models.json`, `ROLE.md`, `mcp.json`, `settings.json` | The pool key already proves the bundle is unchanged. Skip when `slot.key` matches; Pi loaded `ROLE.md` at spawn via `--append-system-prompt` and does not re-read it, so the rewrite is redundant for the role text. |
| `publishToHost` on every Website chat | L2009 | Zips the whole workspace and SHA-1s it (`ee-html.mjs` L106) even when nothing changed | Cheap hash first: compare a max-mtime + file-count fingerprint before zipping. Or run it after the `done` frame and push a `host` frame late (the client already handles a separate `host` event). |
| `appendStateJournal` | L2028 | `git diff --stat` (8 s timeout) or a depth-4 stat walk of the workspace | Move after the `done` frame; it is host bookkeeping, not part of the reply. |
| `setSessionName` loop over the pool | L2038 | One RPC per turn | Only call when the title changed this turn. |

Expected gain: a few hundred ms to several seconds per turn on Website chats, and the reply appears before the bookkeeping instead of after.

### F7. Long-lived slots are never recycled — **low today, medium as usage grows**

- A slot lives until idle-evicted or the server restarts. Pi keeps every switched session in memory; RSS grows with session count and length. The 14 h slot was fine (368 MB), but there is no ceiling.
- Fix: in the sweep, recycle a slot that is idle *and* (age > 12 h or RSS > `PI_SLOT_MAX_RSS_MB`, default 900). Never recycle a busy slot. `rssKb(pid)` already exists in `metrics.mjs`.

### F8. Same-agent turns fully serialize, including a second user — **design note**

- `withAgentLock` means two people chatting to Sales at once queue behind each other for the whole first turn, which can be minutes. Fine for a single operator; not fine for a team. When that day comes, key the pool by session as well and accept the memory cost, guarded by F3. Do not do it before F3.

### F9. Deploy kills in-flight turns after the platform grace period — **low**

- `shutdown` waits on each slot's lock, which is correct, but Railway sends SIGKILL after its grace window regardless. The `enrichRestartPrompt` recovery is the mitigation. If you move to a VPS under systemd, set `TimeoutStopSec=300` so a long turn can finish.

### F10. Process-level stability details — **low**

- `uncaughtException` is logged and swallowed (L2085). This keeps the server up but can leave it in an undefined state (a torn SSE stream, a half-written file). Prefer: log, then if `turnsInFlight === 0` exit and let the restart policy bring it back clean; if turns are in flight, set a flag that triggers exit when they drain.
- `server.timeout/headersTimeout/requestTimeout = 0` (L2094) is required for SSE but also means a stuck non-SSE request never times out. Acceptable for a private studio; note it.
- `@earendil-works/pi-coding-agent` is `"latest"` in `package.json`. `npm ci` uses the lock (0.84.4) so builds are reproducible, but any `npm install` silently bumps the agent runtime. Pin it: `"0.84.4"`.
- The AGY engine (`agy-stream.mjs` `chatAgy`, L286) spawns a fresh `agy` per turn with no timeout and no kill on client abort. It is the secondary engine, so low priority, but add the same inactivity timer used for Pi.

---

## 5. Sizing for 6 GB / 3 vCPU

If the target really is a 6 GB VPS (the current container is capped at 2.86 GB), the measured numbers give a budget:

| Component | Idle | Burst |
|---|---|---|
| Node host | 200 MB | 370 MB |
| One warm Pi slot (1 lazy MCP) | 150–370 MB | — |
| One Pi turn with subagents ×3 + Scrapling Chromium | — | up to 1.7 GB |
| Postgres (if co-located) | 100–300 MB | 500 MB |
| OS + page cache headroom | 500 MB | — |

Recommended env for that box:

```
PI_POOL_SIZE=3
PI_KEEP_WARM=2
PI_SLOT_IDLE_MS=600000
CLOUD_PI_SUBAGENT_MAX=2
```

Plus the F3 memory guard so two burst turns cannot overlap. Three vCPUs are plenty: measured CPU averaged 0.5 % and only spiked during turns.

---

## 6. Recommended order of work

1. **F5 instrumentation** (half a day). You cannot tune the boot beat or the pool without `readyMs` and `firstTokenMs`.
2. **F1 boot pre-warm + F4 exit listener** (half a day). This is what makes "1 instance always alive" actually true.
3. **F2 `PI_KEEP_WARM=2`** (env change, today).
4. **F3 memory guard + `CLOUD_PI_SUBAGENT_MAX=2`** (one day). Prevents the one failure mode that would take the whole studio down.
5. **F6 hot-path gating** (one day). Visible per-turn latency win.
6. F7, F10 pinning and the uncaught-exception policy when convenient.

---

## 7. Scorecard

| Area | Score | Note |
|---|---|---|
| Pool correctness (locks, keys, eviction) | 8/10 | Clean, tested where it matters |
| Process hygiene (tree kill, reaper, PID 1) | 9/10 | Better than most |
| "Always one warm instance" | 4/10 | True within a process lifetime, false across restarts and agent switches |
| Memory safety on a shared box | 3/10 | No admission control; burst can exceed the cgroup limit |
| Observability of the cold path | 3/10 | Spawn is logged; readiness and first token are not; log ring too small |
| Per-turn overhead | 6/10 | Several avoidable steps sit on the critical path |
| Stability under failure | 6/10 | Reactive recovery is good; proactive detection is missing |

Overall: a solid 6.5/10 that becomes an 8+ with items 1–4 above, none of which are large changes.

---

## 8. Implemented 2026-09-05 (F1–F4)

Files: `server/index.mjs`, `server/pi-idle.mjs` (+ tests), `server/metrics.mjs`, `agent/extensions/subagents.ts`.

- **F1 boot pre-warm.** `getOrCreatePiSlot` records the last agent+model in the `settings` row `pi_last_slot`. After `boot complete`, `prewarmOnBoot()` boots that Pi (plus any in `PI_PREWARM_AGENTS`), sequentially, capped at `PI_KEEP_WARM`, without blocking the health check. Log line: `prewarmed agent=… readyMs=…`.
- **F2 warmth.** `PI_KEEP_WARM` default is now 2. New `PI_PIN_AGENTS=sales,website` (ids or slugs) are never idle-evicted. `CLOUD_PI_SUBAGENT_MAX` default lowered from 3 to 2.
- **F3 memory guard.** `cgroupMemory()` now exports `inactiveFile`; pressure = (used − reclaimable cache) / limit. Before every Pi spawn, `ensureMemoryHeadroom` evicts LRU idle slots while pressure ≥ `PI_MEM_HARD_PCT` (75) and otherwise refuses with a clear error. The 30 s sweep evicts warm extras beyond `PI_KEEP_WARM` when pressure ≥ `PI_MEM_SOFT_PCT` (60). No cgroup limit → no throttling.
- **F4 dead-process detection.** `watchSlotExit` clears the slot the instant the child exits, kills its tree, and re-warms an idle slot after 5 s (max 2 per 10 min, then the slot is dropped and logged). The sweep also drops any slot whose pid is gone. `/api/health` gained `piWarm` (agents with a live pid, busy flag, idle seconds); `/api/debug` gained `piPinned` and `piMemory`.
- `Pi client started` now logs `spawnMs`; the readiness/first-token timers from F5 are still to do.

Env summary: `PI_POOL_SIZE` `PI_KEEP_WARM` `PI_SLOT_IDLE_MS` `PI_IDLE_SWEEP_MS` `PI_PIN_AGENTS` `PI_PREWARM_AGENTS` `PI_MEM_SOFT_PCT` `PI_MEM_HARD_PCT` `CLOUD_PI_SUBAGENT_MAX`.

Verify after deploy: `/api/health` should show one entry in `piWarm` within ~20 s of `boot complete` with nobody chatting; `/api/debug` events should contain `prewarmed agent=…`.
