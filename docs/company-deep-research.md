# Company Deep Research in UIv2

The specialist `company-deep-research` is registered when the UIv2 host boots with its existing Postgres connection. The Orchestrator discovers it through the same catalog as the other specialists. Ask the Orchestrator to research a company, ideally with a known website, phone or full address.

Example: “Research Acme Solar Sdn Bhd. Its website is https://example.com/ and its phone is 011-2345 6789.” Use real company anchors; a name alone produces `needs_review` unless a supplied anchor corroborates it. No company facts are attributed before the identity gate passes.

## Existing services and credentials

- Tavily: Settings → Keys → Tavily company research has five masked API key slots (`tavily_api_key_1` through `_5`). Searches rotate through unique saved keys and fail over on authentication, quota, rate-limit or server errors; each attempt counts against the dossier budget. Blank fields preserve saved keys; Remove explicitly clears a slot. Legacy `tavily_api_key`, the host's `TAVILY_API_KEY`, or a key in an existing Tavily MCP registration remain supported. New keys work without restarting the host. Only search is used; answer generation, raw-page extraction, crawl and research endpoints are disabled. Raw keys stay on the host. The separate Jina key pool is used by the generic Web Search tool, not by Company Deep Research.
- Pi: reuses the existing model catalog, saved API key, provider base URL and active model. `COMPANY_RESEARCH_MODEL` can select a catalog entry explicitly. The local SDK tested was **0.84.4**; it was not upgraded to the plan's assumed 1.0.0. Keep the checked-in npm lockfile when deploying. Model/credential stores, settings and research sessions are in memory; no research extensions, skills or project context are loaded.
- Scrapling: the wrapper looks up the existing `scrapling` MCP registration. It supports its configured stdio command or HTTP URL. HTTP headers come from the MCP registration's `config.headers`. Only HTTP `get` or `make_request` with `method: GET` is used; social pages, browser/stealth tools, shell and filesystem tools are unavailable to the research sessions.
- Postgres: the same UIv2 database stores jobs, source text/hashes, transcripts, progress and private dossiers. No separate Railway service or Redis is required.

## Execution

The chat specialist exposes `research_company`, `get_company_dossier`, `replay_company_dossier`, `publish_company_report` and `unpublish_company_report`. A job is asynchronous; its id is returned immediately. The host claims jobs using Postgres row locks and a renewable lease token. One dossier runs at a time per host process. An interrupted job is retried after its lease expires; claim and stale evidence/submission cleanup are atomic. The worker's token fences its evidence, runs, progress, heartbeat and terminal writes after another worker takes ownership. Graceful host shutdown releases the active lease immediately and aborts research sessions before closing the database; abrupt crashes still recover on lease expiry.

1. Two discovery searches and a supplied-site fetch run concurrently to establish identity. A name and a strong phone/address/domain anchor must agree in the same evidence item. Name/postcode alone requires review.
2. Discovery, company-site and social-snippet lanes gather evidence. Company crawling picks contact/about/team/services/projects/portfolio links, capped at ten additional pages. Optional RDAP, Wayback, imported Newpages and PageSpeed lanes supplement it.
3. Four Pi sessions research registry/identity, business/people, signals/scale and risks/news. Their active tool allowlist is asserted to be exactly `search`, `fetch_pages`, `submit_findings`.
4. Submission validates schema, source ids, quote substrings, literal fact values, identifiers, contacts and dates. Rejections are returned to the agent for at most two repairs. If repairs fail, individually supported claims survive with a `partial` lane and a validation warning. Conflicting values stay visible. One gap-fill round can revisit missing SSM/status/people/headcount.
5. Code re-verifies the saved submissions, normalizes phones/age/contacts, reconciles claims and computes status, confidence, legitimacy and coverage. Summary and outreach prompts are deterministic and grounded in accepted facts. JSON, Markdown and HTML are rendered from the canonical dossier.

Defaults: 30 search attempts, 40 Tavily credits, 40 page/robots requests per dossier; each session has two searches, ten page requests, eight turns, a 40,000-token threshold and a two-minute deadline. The first pass synthesizes gathered evidence; gap-fill can make one targeted lookup before finalizing on OpenAI-compatible models. Search attempts including retries reserve budget before calling Tavily. Token thresholds stop subsequent turns after the provider reports usage, so the final provider turn can cross the threshold. Evidence lane failures or blocked pages produce `partial`; missing optional configuration is `skipped` and visible in `meta.lanes`. Unknown data receives no risk penalty. Only quoted, corroborated adverse findings or registry hard caps can produce `HIGH_RISK`.

Discovery searches and optional metadata overlap. Shared per-dossier limits allow at most three concurrent searches and three Scrapling calls. Identical searches and page requests share an in-flight promise; repeated searches spend no extra credits. Identical URL/mode/content evidence is persisted once. Up to three independent original pages are fetched after discovery, preserving snippet evidence when originals are unavailable. Agent context prefers original pages, includes selected middle passages relevant to its section, and remains bounded to approximately 8,500 characters.

An authoritative-domain search snippet alone does not make a fact `confirmed`: the original HTTP document or metadata is required. Phone agreement counts source domains and groups company/social claims into one self-reported origin. Web coverage evaluates the live site, domain age and archive history separately; missing metadata and unverified people do not inflate coverage. These corrections are versioned as `company-research-v2.1`.

Published phones and emails are also extracted deterministically from the supplied company's fetched original pages, then passed through the same quote/value validation. The resulting `contacts` lane is persisted for replay and does not spend model tokens. Contact presence indicates publication, not independent ownership verification.

## Private API

These routes use the existing UIv2 owner/session or management API authentication. Dossiers, raw evidence and transcripts remain private. HTML reports have a responsive editorial layout, evidence badges, clickable citations, contact directory, score breakdown and print styles.

```http
POST /api/company-research/dossiers
{ "seed": { "name": "Company", "website": "https://example.com/", "phone": "011-2345 6789", "place_id": "optional" }, "options": { "force": false, "pitchSignals": false } }

GET  /api/company-research/dossiers/:id
GET  /api/company-research/dossiers/:id/events
GET  /api/company-research/dossiers/:id/artifact?format=json|md|html
POST /api/company-research/dossiers/:id/replay
POST /api/company-research/dossiers/:id/publish
DELETE /api/company-research/dossiers/:id/publish
```

Jobs have `queued`, `running`, `needs_review`, `complete`, `partial` or `failed` status. SSE includes wave/lane/agent/identity/finished events and supports `Last-Event-ID`. Matching seed, options and pipeline version reuse queued/running jobs, complete results for 30 days, or partial results for one day unless `force` is true; `place_id` is optional. Replay reads stored evidence and submissions and uses the original result timestamp for reproducible ages/recency; it applies the currently deployed reconciliation version, makes no model or network calls and spends zero new credits. A published report remains a snapshot until explicitly republished.

The internal MCP gateway `/api/internal/company-research` accepts only a per-boot capability injected into the research specialist. Owner credentials cannot be used in place of that capability. Raw Scrapling/MCP attachments, coding tools and file-sharing extensions are excluded from the specialist's runtime even if attached through Settings.

## Published reports

When the user requests publication, `publish_company_report` persists a designed HTML snapshot and returns `/reports/company/:token` on this production host. Only `complete` or `partial` dossiers with a locked identity can be published. Unknowns, conflicts and failed lanes stay visible. The public page contains accepted claim excerpts, not full source documents or transcripts. Reports have opaque links, no indexing, no scripts or external assets. They are accessible to anyone with the link. Republish updates the snapshot at the same link; unpublish removes the public link without deleting the private dossier. `COMPANY_RESEARCH_PUBLIC_URL` can set the canonical public origin; otherwise the Railway public domain is used.

`/reports/company/preview` is a public layout preview, clearly marked as containing no researched company. It is available without a configured research provider. Actual company reports require the Tavily key and saved model credentials.

## Optional inputs

PageSpeed requires `PSI_API_KEY` and `pitchSignals: true`. RDAP uses IANA's HTTPS bootstrap. A missing RDAP service is recorded as skipped; **there is no automatic `.my` port-43 WHOIS fallback**, because [MYNIC restricts it to authorized registrars](https://www.mynic.my/resources/domains/faq). Wayback records counts as a lower bound if its 10,000-row cap is reached. MX lookups are optional and currently remain `null`.

Import Newpages records with the existing database connection:

```powershell
node server/company-research/import-newpages.mjs E:\path\newpages-records.json
```

The input is a JSON array of records with `id`, `name`, and optional `ssm_no`, `pic`, `phone`, `address`, `website`, `url` (the original directory source URL). Names are normalized and matched with `pg_trgm` when the database permits that extension; an exact/substring fallback works without it. A matching name alone remains a candidate. Only a corroborating phone/domain/full-address anchor and a source URL allow a directory record to enter the evidence set.

## Fetch policy and limits of verification

Page URLs must come from the seed, search results, observed links or the supplied company's registrable domain. Private/reserved IPs, mixed public/private DNS answers, non-HTTP schemes, credentials in URLs, nonstandard ports and snippets-only domains are blocked. Redirects are disabled and changed response URLs are rejected. The wrapper reads `robots.txt` through Scrapling, honors the research agent's group, and fails closed if its policy cannot be retrieved. The fetcher should also have network-level egress restrictions: host-side DNS checks do not pin the remote Scrapling process's DNS resolution, so they alone cannot guarantee protection against DNS rebinding.

HTTP-only fetching is deliberate until a domain fetchability matrix validates browser strategies. Redirecting or bot-blocked sites may provide snippets only; the result reports the missing coverage. Archived snapshot recovery, paid social adapters, batch APIs, refresh schedules and a dedicated dashboard are future extensions.

Quote checks prove text provenance and reject fabricated quotations; they do not prove every semantic interpretation or the truth of a source. Literal values, exact dates, tier-based confidence and conservative scores reduce that risk, but the plan's zero unsupported-claim ship gate still requires hand-reviewed company runs. The 20/30-company gold set, live Tavily/Scrapling checks, p95 latency/cost measurements, scoring calibration and retention policy are not yet validated.

## Validation

```powershell
npm run test:company-research
npm run build
```

The suite tests quote/value/date rejection and repair, Pi's real tool-isolation setup, malicious page-link handling, robots rules, SSRF checks, phone collisions, tiers/conflicts, budgets, metadata parsing, anchor matching, real Postgres migrations/trigram matching/queue leases/replay (using PGlite), private HTTP/SSE/artifacts and the stdio chat MCP round trip. Adjacent runtime/context/environment/search regression tests also pass. Existing unrelated Settings-page lint errors remain; the research backend and modified runtime modules pass focused ESLint.
