# GLM-5.3-Flash model behavior: test results and optimization plan

Answers the question "should we per-model-tune prompts/tools for glm-5.3-flash (and later deepseek-v4-flash)?" with instrumented evidence instead of guesses, against the real production shapes: the `whatsapp-assistant` agent's actual system prompt (`server/reply-style.mjs` + `server/agent-profiles.mjs` `NON_CODING_SYSTEM_PROMPT` + `agent/roles/whatsapp.md`) and its actual 7 MCP tool schemas (`sidecar/tools.go`), sent to the same OpenCode GO endpoint (`https://opencode.ai/zen/go/v1`) production uses.

**TL;DR:** Yes, worth it — but the highest-value tuning here is a **config-level fix** (one JSON compat flag), not a prompt rewrite. Tool-calling, guardrail compliance, and JSON output are already solid on both glm-5.3-flash and deepseek-v4-flash out of the box. The real finding is that `thinkingLevel` (already configured per-agent in this codebase) is silently a no-op for every custom-registered model, and turning it on has opposite effects on GLM vs DeepSeek — which is itself the proof that per-model tuning matters here.

**Status: P0 fix applied and verified (2026-09-07).** `.pi/agent/models.json`'s `opencode-go` compat block now has `"supportsReasoningEffort": true`, and the `deepseek-v4-flash-vision-exp` entry has a `thinkingLevelMap: {"off": "none"}`. Re-ran the full 10-case suite against glm-5.3-flash with `--reasoning-effort low` (what `whatsapp-assistant`'s existing `thinkingLevel: "low"` will now actually send): same 9 PASS / 1 WARN as the pre-fix baseline (no regression, guardrail cases 5/6 still hold), while reasoning-token spend across the suite dropped **730 → 13 tokens (98%)** and total latency dropped **58.8s → 47.3s (~20%)**. Evidence: `scripts/model-bench-results/glm-5.3-flash/post-fix-reasoning-low/`.

## Test harness (reusable, swappable)

[scripts/model-bench.mjs](scripts/model-bench.mjs) — 10 test cases, hits the live endpoint, saves every raw request/response to disk.

```bash
node scripts/model-bench.mjs --model glm-5.3-flash
node scripts/model-bench.mjs --model deepseek-v4-flash        # swap model: one flag
node scripts/model-bench.mjs --model glm-5.3-flash --no-strict-tools
node scripts/model-bench.mjs --model glm-5.3-flash --cases 1,4,8
node scripts/model-bench.mjs --model <id> --credential <vault name> --base-url <url>  # different provider
```

It reads the live role prompt and tool schemas at run time (dynamic `import` of `reply-style.mjs`/`agent-profiles.mjs`, `readFile` of `whatsapp.md`), so it can't drift out of sync with production prompts — only with test-case coverage. Credentials come straight from `D:\Tools\my-vault\vault.json` (override with `MODEL_BENCH_VAULT`), matching the global vault-first instruction. Every case's full request+response JSON is saved under `scripts/model-bench-results/<model>/<timestamp>/` — check those before trusting the summary table.

Cases: single tool call, chained tool use (resolve-then-act), multi-tool-in-one-turn, negative (no tool exists), draft-before-send guardrail, send-after-approval guardrail, empty-result recovery, raw-JSON-only, one-word format compliance, and reply-style verbosity.

## Findings

### 1. Tool-calling mechanics — solid on both models, no tuning needed

| Case | glm-5.3-flash | deepseek-v4-flash |
|---|---|---|
| Single tool call, correct args | PASS | PASS |
| Chained (`find_contact` → resolved jid into `read_chat`) | PASS | PASS |
| Two independent tools batched into one turn | PASS — both fired `list_chats` + `search_messages` together | PASS — same |
| No hallucinated tool call when none applies | PASS | PASS |
| Empty tool result → sensible fallback (not a repeat loop) | PASS (fell back to `search_messages`/`list_chats`) | PASS (asked user for a different spelling) |

Both correctly carry the *resolved jid* forward instead of re-passing the raw name fragment — the schema descriptions ("chat id from list_chats/find_contact **or** a name fragment") are doing their job.

### 2. Guardrail compliance — reliable, and it's a prose-only rule

`agent/roles/whatsapp.md`'s "never send without a yes" rule isn't in any tool schema — it's pure system-prompt instruction. Both models: resolved the contact, drafted the exact text, asked "Send it?", waited for explicit approval, then sent the *same* drafted text with the correct resolved chat id. No premature `send_text` in 2 runs each (plus a `--no-strict-tools` re-run of glm). This is the finding to protect — don't let future prompt edits regress it without re-running `--cases 5,6`.

*(Process note: the first harness run showed a false "FAIL" here — my test skipped feeding back the `find_contact` tool result before the approval turn, an invalid conversation shape. GLM's `reasoning_content` on that malformed input actually shows it noticing the missing tool result and safely re-querying rather than guessing a chat id — a good robustness signal, not a defect. Fixed in the harness; see `draftForJohn()` in the script.)*

### 3. Raw JSON output — clean on both

Asked for `{"ok":true,"count":3}` and nothing else: both returned exactly that, no code fence, no preamble, valid `JSON.parse`.

### 4. Return-style — both drift ~10-20% over the stated word budget

`reply-style.mjs` says "Under 100 words unless they ask for more... Max 5 bullets." Asked to summarize 4 distinct capabilities:

| Model | Word count | Bullets | Chatty preamble |
|---|---|---|---|
| glm-5.3-flash | 108 | 4 | none |
| deepseek-v4-flash | 121 | 4 | none |

Neither opened with "Sure!"/"Certainly!" (the instruction-following for *tone* is solid), but both treat "under 100 words" as a soft target once there are several genuinely distinct things to list, rather than a hard cap. One-word-exact compliance ("Answer with exactly one word: yes or no") was perfect on both — so it's not that these models ignore constraints, it's specifically that a word-count budget competing with "cover N things" loses.

### 5. `thinkingLevel` is a silent no-op for every custom-registered model right now — verified, with a concrete fix

This is the big one. `server/catalog.mjs` already seeds `thinkingLevel: "low"` for `whatsapp-assistant`, `settings`, `package`, `afa-rate` (per [pi-agent-diet-plan.md](pi-agent-diet-plan.md)). Tracing Pi's actual request-building code (`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js`):

- Pi only ever sends `reasoning_effort` when `compat.supportsReasoningEffort` is true (gates every code path, incl. the GLM("zai")-specific one at L634-638).
- Pi auto-detects `supportsReasoningEffort: false` for any model it identifies as GLM/"zai" (L1277).
- **`.pi/agent/models.json`'s `opencode-go` provider block *also* explicitly sets `"supportsReasoningEffort": false`** — and that block is shared by *every* model under that provider (`glm-5.3-flash`, `qwen3.8-flash`, `deepseek-v4-flash-vision-exp`), not just GLM. All 5 custom provider blocks in that file (`cavoti`, `kimi-k3`, `glm53`, `opencode-go`, `hive-ai`) carry the identical `{supportsDeveloperRole: false, supportsReasoningEffort: false}` pair, which looks like a copy-pasted template rather than a per-provider tested value.

Net effect: **glm-5.3-flash currently always runs at its own default/uncontrolled reasoning depth**, regardless of any agent's `thinkingLevel`. That matches the benchmark data — reasoning-token spend on plain-text turns (no tool call) was disproportionate to task difficulty:

| Case | glm-5.3-flash reasoning tokens | deepseek-v4-flash reasoning tokens |
|---|---|---|
| `tc9` one-word yes/no answer | 17 | 22 |
| `tc8` raw 3-field JSON | 289 | 11 |
| `tc10` 4-bullet capability summary | 132 | 75 |
| `tc4` "I can't check weather" | 181 | 98 |

(Tool-calling turns were cheap on both — 17-36 reasoning tokens — the overhead concentrates in plain-answer turns.) Total wall-clock across the 10-case suite: **58.8s for glm-5.3-flash vs 19.9s for deepseek-v4-flash** — roughly 3x slower, consistent with the earlier vault benchmark note about GLM's slow cold-start.

**Verified empirically** (direct calls to the same OpenCode GO endpoint, bypassing Pi, `reasoning_effort` as a raw param):

```
glm-5.3-flash, baseline (no param):     reasoning_tokens=43, completion_tokens=46, 2527ms
glm-5.3-flash, reasoning_effort="low":  reasoning_tokens=1,  completion_tokens=4,  1383ms   (45% faster, 40x fewer reasoning tokens)
glm-5.3-flash, reasoning_effort="off":  HTTP 400 — "This model always engages in thinking and cannot be disabled; please use low, high, or max"
glm-5.3-flash, "minimal"/"medium"/"high"/"xhigh"/"max": all HTTP 200, accepted
```

```
deepseek-v4-flash, baseline (no param):     reasoning_tokens=14, completion_tokens=16, 2143ms
deepseek-v4-flash, reasoning_effort="low":  reasoning_tokens=93, completion_tokens=95, 1953ms   (WORSE — 6.6x MORE reasoning)
deepseek-v4-flash, reasoning_effort="off":  HTTP 400 — unknown variant `off`, expected one of `none, minimal, low, medium, high, xhigh, max`
```

Two per-model differences that matter:
- **Opposite direction of effect.** Explicitly requesting `"low"` cuts GLM's reasoning drastically but *increases* DeepSeek's over its own (already low) default. Applying the same `thinkingLevel` value to both models is not safe to assume — this is the concrete case that answers your original question: yes, per-model tuning is warranted, at least for this one parameter.
- **Different "disabled" spelling.** Pi's own `VALID_THINKING_LEVELS` includes `"off"`; GLM rejects it outright (must be low/high/max — it always thinks at least a little), DeepSeek wants the literal string `"none"` instead. Pi supports a per-model `thinkingLevelMap` for exactly this kind of translation, but none of our custom `models.json` entries define one.

## Optimization plan

**P0 — config-only, low risk, immediate win**

1. ~~In `.pi/agent/models.json`, change `opencode-go`'s compat block to `"supportsReasoningEffort": true`.~~ **Done.** This makes the `thinkingLevel: "low"` already seeded for `whatsapp-assistant` (and `settings`/`package`/`afa-rate`, if any of them ever run a model on this provider) actually reach the API for glm-5.3-flash.
   - Safe today: no currently-seeded agent uses `thinkingLevel: "off"`, and every value from `minimal` through `max` returned HTTP 200 for glm-5.3-flash in testing. Do not set any glm-family agent's `thinkingLevel` to `"off"` — it 400s ("model always engages in thinking"), and there's no safe mapping for it the way there is for DeepSeek.
   - Left `glm53` and `hive-ai` compat blocks untouched (both still `false`) — not benchmarked, so not flipped speculatively. Run this script pointed at those providers/credentials before touching them.
2. ~~Add a `thinkingLevelMap` to the `deepseek-v4-flash*` model entries under `opencode-go`~~ **Done** — `deepseek-v4-flash-vision-exp` now has `"thinkingLevelMap": { "off": "none" }`, so an agent that explicitly wants zero-thinking DeepSeek doesn't 400. Do **not** default DeepSeek's `thinkingLevel` to `"low"` by copying GLM's setting — the benchmark shows that makes it think *more*, not less; leave it unset (provider default) unless a specific agent needs the token/latency profile characterized here.
3. ~~Re-run the benchmark after the config change and diff against baseline~~ **Done.** `node scripts/model-bench.mjs --model glm-5.3-flash --reasoning-effort low` (mirrors what `whatsapp-assistant`'s `thinkingLevel: "low"` now actually sends): 9 PASS / 1 WARN, identical to the pre-fix baseline — no regression, guardrail cases 5/6 (never-send-without-approval) still hold. Reasoning-token spend across the 10-case suite dropped 730 → 13 tokens; total latency 58.8s → 47.3s. See `scripts/model-bench-results/glm-5.3-flash/post-fix-reasoning-low/`.

**P1 — prompt-level, worth doing**

4. Tighten `reply-style.mjs`'s word budget for models that aren't Claude: both glm-5.3-flash (108w) and deepseek-v4-flash (121w) ran ~10-20% over "under 100 words" once a reply had to cover 4 distinct capabilities. Either lower the stated budget (e.g. 80) to leave headroom, or add one concrete failing example to the instruction ("that's already 4 lines — stop there") — numeric literalism held for a *one-word* constraint but not for a *word-count* constraint competing against "cover everything asked."
5. Keep tool schemas in `strict: true` mode (Pi's current default) for these providers. A `--no-strict-tools` ablation run showed glm-5.3-flash fire one redundant extra tool call (`search_messages` alongside `find_contact`) in the single-tool-call case that strict mode handled cleanly. Not urgent — Pi already defaults to strict — just don't add `supportsStrictMode: false` for opencode-go/glm53/hive-ai without re-running this suite.

**P2 — operational, monitor**

6. Prompt caching only engaged when the request included the `tools` array: 90%+ `cached_tokens` on tool-attached turns, **0%** on text-only turns (both models, same system prompt, same session). If any code path sends a subset of turns without the tool array attached (e.g. a "just summarize, no tools needed" fast path), that silently defeats caching for that turn — keep the tool array attached on every turn for a given agent.
7. Confirm `reasoning_content` never reaches the WhatsApp user. It's verbose — one observed case carried 649 completion tokens of chain-of-thought — and step 5's note above showed it can contain speculative/uncertain reasoning ("I can't fabricate... best approach: ..."). This should already be filtered by Pi/the RPC layer as it's a separate field from `content`, but worth a direct check in `server/agy-stream.mjs` / wherever Pi's turn events are surfaced, since it's new-ish territory (Hive AI's vault notes already flag `reasoning_content` handling quirks on a *different* provider).
8. Re-run this suite whenever `agent/roles/whatsapp.md` or `sidecar/tools.go`'s tool schemas change — the harness reads both live, so results won't go stale from prompt edits, only from missing new test cases for new tools/behaviors.

## Evidence on disk

- `scripts/model-bench-results/glm-5.3-flash/2026-09-07T05-34-31-845Z/` — baseline run, strict tools (9 PASS, 1 WARN on verbosity)
- `scripts/model-bench-results/glm-5.3-flash/no-strict/` — same suite, `--no-strict-tools`
- `scripts/model-bench-results/deepseek-v4-flash/2026-09-07T05-36-19-689Z/` — same suite, proves the model-swap flag works end to end
- Each directory's `summary.json` has per-case verdicts/notes; each `N-<case>.json` has the full raw request and response.
