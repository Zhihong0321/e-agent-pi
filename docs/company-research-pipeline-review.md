# Company research pipeline review — 2 October 2026

This review covers the UIv2 host, queue, Tavily/Scrapling evidence adapters, metadata, four Pi sessions, reconciliation, scoring, replay and public HTML reports. Changes below implement v2.1. Brave and Exa are recommendations; their credentials and live adapters have not been added in this revision.

## Corrections implemented

| Finding | Previous behavior | Correction |
|---|---|---|
| Stale queue ownership | A recovered worker could overwrite evidence/results from its replacement. Claim and cleanup were separate operations. | Atomic claim/cleanup and lease-token checks on worker writes, heartbeat, completion and failure. |
| Deploy recovery delay | Graceful shutdown left jobs running until the 15-minute lease expired. A concurrent production deploy reproduced this during live validation. | Await lease release and abort active Pi research sessions before the host closes its database. |
| Duplicate discovery | Repeated requests fetched the same page or query and stored duplicate evidence. | Shared in-flight request cache and URL/mode/content-hash evidence deduplication within each dossier. |
| Serial requests | Identity queries/home fetch, page batches and discovery queries waited for each preceding request. Metadata started after discovery. | Independent requests overlap, with shared caps of three searches and three Scrapling calls. Batch failures wait for siblings to settle before proceeding. |
| Transport failure | Tavily socket/timeout exceptions bypassed key failover. | Network failures retry within the reserved attempt/credit budget. |
| Thin evidence | Discovery relied heavily on shortened snippets, despite finding original URLs. | Fetch up to three selected independent originals from distinct domains, retain snippets if fetches fail, prefer originals in Pi context. |
| Missed contacts | Published phone/email recall depended on model excerpts and submissions; the live run missed available contacts. | Deterministic, quote-checked extraction from fetched company-controlled pages, persisted as a replayable findings lane. |
| Repeated people/events | Honorific names and punctuation variants created duplicate cards. | Normalize honorific/punctuation variants for grouping; keep distinct roles and differing event descriptions separate. |
| Missing middle passages | Head/footer excerpts could omit staff or registry details in the middle of a page. | Select bounded excerpts around terms relevant to each research section. |
| Whole-submission loss | Exhausted quote repairs discarded valid claims beside invalid claims. | Salvage individually checked claims as `partial`, with unsupported claims excluded and the failure visible. |
| Overstated authority | A snippet on an authoritative domain was enough for `confirmed`. | Require the fetched original or metadata; single-authority snippets remain qualified observations. |
| False source agreement | Three evidence ids/pages could satisfy phone agreement even from the same company. | Count distinct source domains; company and social claims form one self-reported origin. |
| Inflated coverage | An active website evaluated all 15 web points despite missing age/history; an unknown person evaluated people coverage. | Separate live website, age and archive criteria; require trusted people to evaluate that criterion. |
| Hidden fetch failures | Blocked pages inside a nominally successful lane could disappear from completion status. | Record partial lane status and a fetch limitation; overall status remains partial. |
| Limited dossier cache | Seeds without a Google place id were never reused; partial results could stay cached for 30 days. | Match seed/options/version without requiring place id; complete results use 30 days, partial results one day. |
| Per-lane credit mismatch | Agent search invocation counts were used as credits, including cached requests and advanced searches. | Attribute actual reserved credit deltas from the shared budget to each session. |

The earlier report-navigation bug is fixed separately: `/reports/` is excluded from the PWA app-shell fallback and fetched from the server. Existing installed-worker upgrade behavior was tested on desktop and mobile.

## Recommended provider routing

Keep one three-tool agent interface. The host chooses providers; the model does not receive keys or separate provider tools.

1. Identity: exact legal name plus supplied domain/phone/address; use the selected primary search provider. An API's company classification is discovery, not an identity lock.
2. Broad and current discovery: Brave Web/News, with Malaysia localization, exact names, extra snippets and appropriate freshness filters. Retain Tavily as a configurable primary or fallback until comparative results justify changing the default.
3. Leadership, delivered projects and difficult gaps: Exa `fast` or `auto`, `company`/`people` categories where appropriate, and bounded highlights/text. Prefer `auto` for important gaps where recall matters more than minimum latency.
4. Originals: Scrapling remains the direct-fetch path. Exa Contents can be an optional cached-content path for suitable sources, with URL provenance, provider/retrieval metadata, blocked-source policy and freshness limits retained. Do not bypass source restrictions or claim cached content is a fresh original.
5. Validation: all providers feed the same evidence store and quote checks. Multiple search engines returning one page are one source; provider-generated answers and summaries must never serve as verbatim evidence.
6. Fallback: switch after errors or poor recall, or run a second provider only for high-value gaps. Calling all three for every query increases cost and can increase latency without adding independent evidence.

### Brave

[Brave Web Search](https://api-dashboard.search.brave.com/app/documentation/web-search/codes) supports locale targeting, site operators, freshness filters and up to five extra snippets. These can improve exact-name registry/directory discovery and help select which originals are worth fetching. Use `spellcheck=false` for exact company names. A dedicated [News endpoint](https://api-dashboard.search.brave.com/api-reference/news/news_search/get) is useful for dated activity and adverse-news discovery.

Its [LLM Context endpoint](https://api-dashboard.search.brave.com/documentation/services/llm-context) adds bounded snippets and optional fetched-content metadata. This is worth comparing against our current short Tavily snippets. It does not replace provenance checks or original-source verification.

Brave's public [Search pricing](https://brave.com/search/api/) currently lists $5 per 1,000 requests. Illustratively, five Brave requests would be $0.025 before any applicable credits; that excludes Pi and all other providers. No claim is made that Brave is faster or has better Malaysian company recall in this app until measured.

### Exa

[Exa Search](https://exa.ai/docs/reference/search) supports `instant`, `fast`, `auto` and deeper search modes, and can return highlights/text with results. This can combine discovery and useful evidence retrieval, reducing separate page fetches when appropriate. Company/people categories can improve relevant-profile discovery. Those categories do **not** support publication-date or excluded-domain filters; unsupported combinations return errors.

[Exa Contents](https://exa.ai/docs/reference/get-contents) accepts batches of URLs. `maxAgeHours=-1` uses cache only, a positive value allows content within that age, and `0` fetches fresh content. The older `livecrawl` flag is deprecated. Always retain per-URL status and freshness; missing content is not an empty company footprint. Do not accept generated summaries as original source quotations.

[Exa pricing](https://exa.ai/pricing) currently advertises Search from $4 per 1,000 requests and Contents at $1 per 1,000 pages per content type. Different search modes and requested content affect spend; collect provider usage and estimated USD separately rather than treating Exa dollars as Tavily credits.

## Validation and remaining work

Regression tests cover concurrent limits, in-flight deduplication, counted retries, shared robots requests, original-vs-snippet authority, corrected coverage/source agreement, focused excerpts, claim salvage, concurrent identity discovery, stale-lease rejection and the existing API/MCP/report flow. Frontend build and focused backend lint are also required before deployment.

These tests demonstrate mechanics, not a measured production speedup or an accuracy guarantee. A fair provider comparison needs the same seeds, models, evidence rules and source policy. Benchmark 20–30 Malaysian companies, including ambiguous names and sparse footprints: median/p95 time, requests/credits/USD, correct SSM/identity, independently supported people/projects, quote failures and accepted coverage. Inspect the claims by hand. Compare Tavily-only, Brave-primary/Tavily-fallback, and selective Exa enrichment.

The Eternalgy live smoke test used the same `deepseek-v4.1-flash` model. The earlier completed attempt took 107.695 seconds, recorded 12 Tavily credits and 130,173 tokens. The recovered v2.1 attempt took 93.094 seconds, recorded 15 credits and 132,153 tokens; all four initial sessions and three gap sessions returned accepted submissions. This is approximately 14% less attempt time, 25% more search credits and 1.5% more tokens in one sample. These timings exclude the deployment interruption and lease wait, and the credit/token comparison excludes the interrupted attempt's spend. Selected independent originals remained unavailable, while Wayback failed and registry status remained unknown. The subsequent deterministic contact pass uses saved original-page evidence without extra searches or model tokens. Neither a general speedup nor a broad quality improvement is established by this one run.

Outstanding constraints:

- Literal quotes are not full semantic entailment. Signals, delivered-work descriptions, risk interpretations and same-name source attribution still need stronger claim-level checks and human-reviewed evaluation.
- Identical text on different publishers may be syndicated rather than independent. Domain counting prevents duplicate-page inflation but does not establish editorial independence.
- Per-dossier concurrency is not an account-wide rate limiter across multiple replicas. Before increasing queue concurrency, implement provider-wide throttling and a dossier-wide deadline/cancellation policy.
- Budgets and usage currently describe a research attempt. Recovery clears interrupted evidence/runs; it does not maintain a cumulative billing ledger or hard spend cap across all retries of a job. Preserve attempt history and cumulative reservations before promising dossier-wide cost limits under repeated restarts.
- Simultaneous enqueue requests can still race the lookup and create duplicate jobs. A transaction/advisory lock or explicit idempotency key should be added before high-volume batch ingestion.
- HTTP-only, no-redirect fetching still loses sources. Safe redirect handling requires validating every hop and controlling the fetcher's network egress; host DNS prechecks alone do not prevent remote DNS rebinding.
- No public search API provides official company registry verification automatically. Missing SSM records, headcount or paid data must remain unknown.
- The score is an evidence-based heuristic and has not been calibrated against a reviewed dataset. Low coverage should not be presented as evidence of fraud.
- Published reports are immutable snapshots until republished. A pipeline deployment does not silently rewrite a previously published assessment.
