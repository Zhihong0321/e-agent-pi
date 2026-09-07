# Google Ads Agent — plan

Status: planning only. Nothing built yet. Written 2026-09-07.

## 1. Where you actually stand

The vault entry `GOOGLE_ADS_OAUTH_CLIENT` already holds:

- OAuth client (Desktop app) — client_id + client_secret
- Developer token (MCC API Center): `[redacted — see vault: GOOGLE_ADS_OAUTH_CLIENT]`
- Target account: `464-254-9168`
- **Missing: `refresh_token`**

The "6 days" turned out **not** to be an API problem at all. Confirmed 2026-09-07 by
running `scripts/google-ads-oauth.mjs`: it is a **Google Account security hold** on
nurul@eternalgy.me — a new passkey was added, and Google blocks sensitive actions
(including granting an app OAuth access) for a cooling-off period afterwards. The
developer token's access level was never the blocker.

**Resolved 2026-09-07 — the API works.** A refresh token was obtained via
zhihong0321@gmail.com (added as an OAuth test user) and `listAccessibleCustomers`
returned **200**. A test-only token would have returned DEVELOPER_TOKEN_NOT_APPROVED,
so `[redacted — see vault: GOOGLE_ADS_OAUTH_CLIENT]` has production access — Explorer level or better. There is
no API-side wait.

**Working configuration — verified end to end 2026-09-07.** Live production data is
being returned from account "Eter GA". The non-obvious part is that every call must be
routed through the manager account via the `login-customer-id` header; calling the
target account directly returns USER_PERMISSION_DENIED.

| Setting | Value |
|---|---|
| Authorising Google account | zhihong0321@gmail.com (OAuth test user) |
| `login-customer-id` header | `4679976211` — MCC "Gan Zhi Hong", **required** |
| Target customer | `4642549168` — "Eter GA", MYR, Asia/Kuala_Lumpur, ENABLED, not a test account |
| Dead ends, ignore | `5633569313` cancelled; MCC shows "Setup in progress" but works anyway |

Two developer tokens exist. The vault's `[redacted — see vault: GOOGLE_ADS_OAUTH_CLIENT]` (from nurul's MCC) is
the one in use and it works. zhihong0321's MCC has its own [redacted — see vault: GOOGLE_ADS_OAUTH_CLIENT],
which the API Center confirms is at **Explorer Access**. Either is fine; don't mix them
mid-session.

Explorer allows **2,880 API operations/day** against production. One query counts as one
operation no matter how much data it returns — the `queryResourceConsumption` figure in
each response is a separate monitoring metric, not a quota counter. So reporting is
effectively unconstrained; only bulk mutates need counting, since each mutated item is
its own operation.

Current account contents: one Performance Max campaign, "Campaign #1" (id 24217953537),
ENABLED but with zero impressions, clicks, cost and conversions over the last 30 days —
so nothing is actually serving yet.

Reusable during development: `scripts/google-ads-query.mjs <customer-id> "<GAQL>"`, or
`list` in place of the customer id to enumerate accessible accounts.

**Ruled out 2026-09-07 — service accounts.** eternalgy.me is not a Google Workspace
domain (MX points at Hostinger and AWS SES, not Google), so nurul@eternalgy.me is a
consumer Google account on a custom domain. No Workspace means no admin console, so
domain-wide delegation cannot be authorised, and the Google Ads API rejects service
accounts without it. It also means the OAuth consent screen cannot be set to
"Internal". `scripts/google-ads-service-account.mjs` is parked, not deleted — it works
as written and would come alive if this ever moves onto Workspace.

So the only route in is the OAuth user flow: consent screen stays **External** in
**Testing**, with authorised accounts on the test-user list. Refresh tokens issued in
Testing expire after 7 days; publishing the app later removes that.

For reference, the access levels that will matter once sign-in works:

| Level | Accounts | Daily ops | Application |
|---|---|---|---|
| Test Account | test only | 15,000 | automatic |
| **Explorer** | **test + production** | **2,880 prod / 15,000 test** | **often granted automatically — no application** |
| Basic | test + production | 15,000 | apply, ~5 business days |
| Standard | test + production | unlimited | apply, ~10 business days |

**Action zero: open API Center and read the token's actual level.** Explorer is a new
intermediate tier that grants production access with no application. If the token is
already Explorer, you are not blocked — 2,880 operations/day is ample for one account.

If it is still pending Basic: brand verification on the linked Google Cloud project is
an optional signal that Google uses for faster determination, reported to cut the wait
from days to hours. Worth doing today either way.

Explorer restricts account creation, user management, planning tools (Keyword Planner)
and billing. None of those are in scope below.

## 2. Two engines, one brain

| | Google Ads Scripts | Google Ads API |
|---|---|---|
| Developer token | not needed | required |
| Approval | none, ever | gated on access level |
| Runs where | inside the Ads account | inside UIv2 |
| Scheduling | Google's scheduler | our cron |
| Chat-driven | no | yes |
| Ceiling | 30-min run cap, one account | full surface, multi-account |

The bet that makes "both" cheap: modern Ads Scripts expose `AdsApp.mutate()` /
`mutateAll()`, which take **the same operation shapes as the API**
(`CampaignBudgetOperation`, `CampaignOperation`, `AdGroupOperation`,
`AdGroupCriterionOperation`, `AdGroupAdOperation`). So we write the operation builders
**once**, as pure functions, and put two thin executors behind them:

```
server/google-ads-ops.mjs   ← pure builders + validators (no I/O, unit-tested)
        ├── executor A: REST mutate  →  UIv2 MCP tools
        └── executor B: emit JS body →  paste into Google Ads Scripts
```

Scripts is not a throwaway stopgap. It stays as the always-available path (no quota,
no token risk, survives any access-level change) for the scheduled optimization loop.

## 3. Files to touch

Mirrors the Sales Data Tools pattern exactly.

| File | Change |
|---|---|
| `server/google-ads.mjs` | new — refresh_token → access_token cache, REST client, GAQL `search`, `mutate` with `validateOnly` |
| `server/google-ads-ops.mjs` | new — pure operation builders + guardrail validators + Scripts codegen |
| `server/google-ads-mcp-server.mjs` | new — stdio MCP server, tool surface (§4) |
| `server/google-ads-mcp.mjs` | new — registration, copy of `server/sales-mcp.mjs:7` |
| `server/google-ads-ops.test.mjs` | new — builder/guardrail unit tests |
| `server/paths.mjs:128` | add `GOOGLE_ADS_MCP_SERVER`, slug, agent id beside `SALES_MCP_SERVER` |
| `server/secrets.mjs:3` | add `google_ads_client_id`, `_client_secret`, `_developer_token`, `_refresh_token`, `_customer_id`, `_login_customer_id`, `_writes_enabled` to `KEYS` |
| `server/catalog.mjs:747` | seed the agent inside `seedAgentCatalog()` |
| `agent/` | role prompt file, loaded like `PROPOSAL_ROLE_FILE` |
| `app/settings.tsx` | credential fields + the writes kill switch |

Zero new npm deps — the Ads API is plain REST over `fetch`. Pin the version in one
constant: **v25** is current (released July 2026, sunsets Aug 2027); releases are now
monthly and each major lives 12 months, so this constant needs a calendar reminder.

## 4. Tool surface

**Read-only — ships first, safe, works on a test account today**

- `ads_account_overview` — spend, conversions, CPA, budget pacing
- `ads_performance` — GAQL-backed, returns a ready-to-paste HTML report (same shape as the sales tools)
- `ads_search_terms` — what people actually typed
- `ads_wasted_spend` — cost with zero conversions, by keyword / search term / ad

**Optimization — writes, gated**

- `ads_propose_changes` — returns a change set + diff, applies nothing
- `ads_apply_changes` — applies a previously proposed set by id

**Creation — writes, gated**

- `ads_draft_campaign` — budget + campaign + ad group + keywords + RSA as one validated operation set, returned as a preview
- `ads_launch_campaign` — creates it **PAUSED**, always

RSA constraints the builders must enforce: ≥3 headlines (max 15), ≥2 descriptions
(max 4), ≥1 final URL, max 3 RSAs per ad group.

## 5. Guardrails

This agent moves real money, so these live in **code**, not in the role prompt — a
prompt can be argued out of a rule.

1. **Two-step writes.** No tool both decides and spends. `propose` → you approve → `apply`.
2. **Born paused.** New campaigns are created PAUSED. Enabling is a separate explicit act.
3. **Hard caps.** Max daily budget per campaign; max % budget change per run; max operations per run. Constants, not arguments.
4. **Validate first.** Every mutate runs with `validateOnly: true` and only re-runs for real on a clean validation.
5. **Audit log.** Append-only Postgres table: every mutate payload + response + who asked.
6. **Kill switch.** `google_ads_writes_enabled` — off, every write tool refuses. Toggle in Settings.
7. **Op budget.** Explorer is 2,880 prod ops/day. Reporting is cheap; a 200-ad-group build is not. Batch, and count before sending.

## 6. Phases

**Phase 0 — unblock (today, ~30 min, needs you)**
Read the real access level in API Center. Run brand verification on the GCP project if
Basic is still pending. Run the installed-app OAuth flow locally — I write the script,
you open the browser and approve, it exchanges the code for a `refresh_token` — then
store it in the vault and in Settings.

**Phase 1 — read-only — SHIPPED 2026-09-07**
`server/google-ads.mjs` (OAuth refresh, GAQL search, no mutate path), five MCP tools in
`server/google-ads-mcp-server.mjs`, agent seeded as slug `google-ads`, credentials in
Settings. Verified against the live account: all five tools return rendered reports,
`npm run build` passes, lint count unchanged from HEAD.

**Phase 2 — Scripts loop (no approval needed, real account)**
Generate the optimization script from the shared builders. You paste it into the Ads UI
and schedule it daily. Real automation on the real account, independent of token status.

**Phases 3 and 4 — campaign building — SHIPPED 2026-09-07**

The operator's constraint, given 2026-09-07, is stricter than the original plan:
**never fire any ads.** So the agent can build and edit, but nothing it touches can
ever serve. That is enforced structurally, in three layers:

1. `server/google-ads-ops.mjs` hardcodes `PAUSED` on every created entity — status is
   never a parameter — and `assertNoEnabling` deep-scans any payload for `ENABLED`.
2. `assertNotServing` refuses to edit anything currently running, because changing a
   live campaign changes live spending.
3. `server/google-ads-mutate.mjs` is the only path to `googleAds:mutate`, re-validates
   both rules, dry-runs every write with `validateOnly` first, and appends every
   attempt — refusals included — to `DATA_DIR/google-ads-writes.jsonl`.

There is deliberately **no unpause tool**. `ads_pause_campaign` exists because pausing
can only reduce spend; going live stays a human action in the Google Ads UI.

**Two-core design — SHIPPED 2026-09-07.** The operator asked for design and submission
to be separate: generate every input and setting *before* anything is sent, rather than
discovering fields by trial and error against the API.

*Core 1 — design, fully offline.* `scripts/build-ads-schema.mjs` extracts the transitive
closure of every creatable resource from Google's REST discovery document into
`server/google-ads-schema.json` — 221 types, 780 enum values, each with Google's own
description, 331 KB, committed. `server/google-ads-schema.mjs` reads it and makes no
requests ever. `ads_schema` exposes every field and option; `ads_plan_validate` checks a
whole plan (field names, enum values, `@ref` resolution, required fields, the
paused-only rule) and returns every problem at once. Verified by running the MCP server
with an empty environment — no credentials, no network.

*Core 2 — submit.* `planToOperations` turns the plan into one atomic mutate batch,
injecting `PAUSED` wherever status was omitted, because Google's own default for a new
campaign is ENABLED. `ads_plan_submit` needs `confirm: true`.

Plan format: entities with a unique `ref`, a `resource`, and `fields`; `"@ref"` points
one entity at another wherever a resource name goes.

Gotcha found by testing against Google: only `CampaignBudget`, `Campaign`, `AdGroup` and
`AssetGroup` accept a negative temp resource name. `AdGroupCriterion` and `AdGroupAd`
have composite names (`adGroupId~criterionId`) and are rejected with `BAD_RESOURCE_ID`,
so they are created without a `resourceName`. Covered by a regression test.

Verified: a 5-operation plan (budget → campaign → ad group → keyword → RSA) returns
**HTTP 200** from Google under `validateOnly`.

Tools: `ads_schema`, `ads_plan_validate`, `ads_plan_submit`,
`ads_draft_campaign` (dry run, writes nothing), `ads_create_campaign`
(needs `confirm: true`), `ads_edit_campaign`, `ads_add_keywords`, `ads_pause_campaign`.
Budget ceiling `GOOGLE_ADS_MAX_DAILY_BUDGET`, default 200.

Verified live: draft validates against Google, and all five refusal paths fire —
including refusing to edit "Campaign #1" because it is ENABLED. 9 unit tests cover the
invariant. Gotcha found the hard way: `contains_eu_political_advertising` is now
required on campaign create, and is pinned to
`DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING` (confirmed correct — no EU ads, ever).

Phases 1 and 2 are both unblocked right now. Phase 3 needs ≥ Explorer.

## 7. Open questions

- Scope: just `464-254-9168`, or should the agent work MCC-wide across client accounts? (Changes whether we set `login-customer-id` and how account selection works in every tool.)
- What does "optimize" mean for your account concretely — pausing zero-conversion spend, shifting budget to winners, bid adjustments, negative keywords? Ranked, so Phase 3 builds the right one first.
- Any spend ceiling the agent must never cross?
