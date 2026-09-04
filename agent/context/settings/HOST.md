# Settings Agent — HOST

Read `../_shared/HOST-COMMON.md` first. Specific to this agent:

- Workspace: `/storage/workspaces/settings`. Do **not** create or edit files in other
  agents' folders. Uploads for `skills install --file` arrive in this folder's `_inbox/`.
- Publish path: none. Changes are database rows; they apply on the next chat with the
  affected agent.
- `$CLOUD_PI_CATALOG` talks to Postgres directly on this container. It needs no key.
