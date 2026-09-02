# Website Studio (Pi agent)

Cloud app for Railway. The agent only edits a volume workspace. GitHub is the remote. This service does not publish a public site.

## Railway

1. New project from GitHub: [Zhihong0321/e-agent-pi](https://github.com/Zhihong0321/e-agent-pi)
2. Add **PostgreSQL** (`DATABASE_URL` is injected)
3. Add a **Volume** mounted at `/storage` (one replica only)
4. Set variables:
   - `GITHUB_TOKEN`, `GITHUB_REPO`, optional `GITHUB_BRANCH`
   - `CAVOTI_API_KEY` and/or `KIMI_API_KEY`
5. Deploy. Start command is `node server/index.mjs` (Dockerfile).

## Debug (no log pasting)

After deploy, these stay public so they can be fetched directly:

- `GET /api/health` — boot step, postgres, git, env flags (booleans only), last events
- `GET /api/debug` — same plus persisted events

Nothing in those payloads is a secret. API keys are reported as present/absent only.

## Layout

| Path | Purpose |
|------|---------|
| `app/` | Studio UI |
| `agent/ROLE.md` | Agent prompt |
| `server/` | HTTP API + Pi + git sync |
| `/storage/workspace` | Agent files (volume) |
| `/storage/storage` | Pi sessions (volume) |
