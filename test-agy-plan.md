# Antigravity CLI (AGY) Cloud Spike: `/test-agy` Implementation Plan

## 1. Executive Summary

This plan outlines a **zero-blast-radius, non-intrusive spike** to integrate the **Google Antigravity CLI (`agy`)** into the Railway cloud host alongside the existing Pi Agent. 

The goal is to provide a dedicated **`/test-agy`** testing harness to verify:
1. Cloud installation of the Linux `agy` binary.
2. Headless OAuth authentication using a **Google Account with Gemini AI Pro** subscription (without consuming developer API credits).
3. Real-time NDJSON event streaming and latency.
4. Autonomous agentic tool execution (`--dangerously-skip-permissions`).
5. Shared consumption of the host's existing Skills (`SKILL.md`) and MCP catalog.

Once verified on `/test-agy`, we will formulate the permanent dual-engine build plan or assess whether full integration is worth the maintenance investment.

---

## 2. Core Principles & Constraints

1. **Zero Impact on Current Codebase**:
   - The production Pi Agent, Website Dev Agent, Proposal Agent, and Settings page will remain 100% untouched.
   - All diagnostic code is isolated in [`server/test-agy.mjs`](file:///E:/000/uiv2/server/test-agy.mjs).
   - Only a single 3-line route delegator is added to [`server/index.mjs`](file:///E:/000/uiv2/server/index.mjs).
2. **Gemini AI Pro Account (Not Gemini API)**:
   - Must authenticate via Google User Account OAuth2 (`access_token` + `refresh_token`), consuming Gemini Pro/Advanced subscription quotas rather than a metered `GEMINI_API_KEY`.
3. **Headless Link-and-Code Exchange**:
   - The `/test-agy` web page will orchestrate the OAuth flow: generate the Google auth link, display it to the user, accept the returned auth code, and pipe it to `agy`'s `stdin`.
4. **Persistent Credentials**:
   - OAuth tokens will be persisted on Railway's volume at `/storage/.gemini/` and symlinked to `/root/.gemini`. Logins will survive container restarts and redeployments.
5. **Full Agentic Authorization**:
   - AGY will be invoked with `--dangerously-skip-permissions`, controlled solely through system prompts (`AGENTS.md`).
6. **Server Specs**:
   - Current server resources (6 vCPU, 8GB RAM) provide more than enough headroom for concurrent operations.

---

## 3. Architecture Overview

```
                               ┌────────────────────────────────┐
                               │  Browser: GET /test-agy        │
                               └───────────────┬────────────────┘
                                               │
                                               ▼
                               ┌────────────────────────────────┐
                               │       server/index.mjs         │
                               │  (Route: /test-agy -> delegator)│
                               └───────────────┬────────────────┘
                                               │
                                               ▼
                               ┌────────────────────────────────┐
                               │       server/test-agy.mjs      │
                               │   • Standalone Diagnostic UI   │
                               │   • Headless Auth Manager      │
                               │   • NDJSON Streaming Runner    │
                               └───────────────┬────────────────┘
                                               │
                                               ▼
                               ┌────────────────────────────────┐
                               │        agy CLI Subprocess      │
                               │  Flags:                        │
                               │  --input-format stream-json    │
                               │  --output-format stream-json   │
                               │  --dangerously-skip-permissions│
                               │  --conversation <id>           │
                               └───────────────┬────────────────┘
                                               │
                         ┌─────────────────────┴─────────────────────┐
                         ▼                                           ▼
          ┌─────────────────────────────┐             ┌─────────────────────────────┐
          │  /storage/.gemini           │             │  Shared Catalog             │
          │  (Persistent OAuth Tokens)  │             │  • /storage/library/skills  │
          │  Gemini Pro Account session │             │  • PostgreSQL mcp_servers   │
          └─────────────────────────────┘             └─────────────────────────────┘
```

---

## 4. Implementation Steps

### Step 1: Dockerfile & Environment Setup ([`Dockerfile`](file:///E:/000/uiv2/Dockerfile))
1. Install the Linux `x86_64` `agy` binary to `/usr/local/bin/agy` and set executable permissions (`chmod +x`).
2. Symlink the persistent volume on startup:
   ```bash
   mkdir -p /storage/.gemini
   ln -sfn /storage/.gemini /root/.gemini
   ```

### Step 2: Minimal Route Delegator ([`server/index.mjs`](file:///E:/000/uiv2/server/index.mjs))
Add an isolated check before the static file handler:
```javascript
import { handleTestAgy } from "./test-agy.mjs";

// Inside request listener:
if (pathname === "/test-agy" || pathname.startsWith("/api/test-agy")) {
  return handleTestAgy(req, res, url);
}
```

### Step 3: The Isolated Test Module ([`server/test-agy.mjs`](file:///E:/000/uiv2/server/test-agy.mjs))
Create a self-contained module serving an interactive diagnostic console with the following endpoints:
* `GET /test-agy`: Renders the single-page HTML/JS test console.
* `GET /api/test-agy/health`: Verifies binary presence (`agy --version`), available models (`agy models`), and token status.
* `POST /api/test-agy/auth/start`: Spawns `agy` in headless auth mode and captures the Google OAuth sign-in link from `stdout`.
* `POST /api/test-agy/auth/submit`: Writes the user's authorization code to `stdin` to complete token exchange and persist credentials.
* `POST /api/test-agy/prompt`: Runs a streaming turn with `--input-format stream-json --output-format stream-json --dangerously-skip-permissions` and pipes live NDJSON events over SSE.

---

## 5. The 5 Diagnostic Probes on `/test-agy`

| Probe | Test Goal | Execution / Validation |
| :--- | :--- | :--- |
| **Probe 1: Binary & CLI Health** | Confirm binary works in Debian container | Runs `agy --version` and `agy models`. Lists supported models (e.g. `gemini-3.8-flash-high`, `gemini-3.1-pro-high`). |
| **Probe 2: Headless OAuth Link & Code** | Authenticate Gemini Pro account | Generates login URL, accepts auth code, exchanges token, and verifies `oauth_credentials.json` on `/storage/.gemini/`. |
| **Probe 3: Minimal Dry-Run Turn** | Validate subscription quota | Runs `agy -p "ping" --output-format stream-json --dangerously-skip-permissions`. Asserts HTTP 200 and no auth errors. |
| **Probe 4: NDJSON Streaming & Latency** | Measure live response performance | Sends a multi-line creative task. Measures Time-to-First-Token (TTFT), token consumption, and stream stability. |
| **Probe 5: Shared Skills & Tool Check** | Validate agentic execution & skills | Instructs AGY to execute a file modification and reads an existing skill from `.agents/skills/`. Verifies zero permission prompts. |

---

## 6. Evaluation Criteria ("Is It Worth Building?")

After completing the diagnostic run on `/test-agy`, evaluate the following decision gates:

| Decision Gate | Green Light (Proceed to Full Build) | Red Light (Reconsider / Stop) |
| :--- | :--- | :--- |
| **Token Longevity** | Token auto-refreshes seamlessly over 24+ hours across restarts. | Google OAuth requires continuous manual re-authentication on cloud IPs. |
| **Streaming Cleanliness** | NDJSON events parse cleanly into `thinking`, `tool`, and `text` blocks. | CLI buffers output or hangs without explicit stdin closures. |
| **Agentic Tool Stability** | Tools run unattended without hanging or crashing the container. | Complex permission issues occur in headless container environments. |

---

## 7. Starting the Next Session

In the next session, instruct the assistant:
> *"Proceed with Step 1 and Step 2 of `test-agy-plan.md` to build the `/test-agy` diagnostic harness."*
