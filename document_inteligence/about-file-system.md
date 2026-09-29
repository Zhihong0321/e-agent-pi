# File system: one rule for every agent

Agents create files. The host publishes files. Chat displays the returned attachment.

## Two locations

Agent workspaces under `/storage/workspaces/<agent>/` (and `/storage/workspace/` for the
website agent) hold editable working files. They keep each agent's work separate.

Completed files shared with the user live under:

```text
/storage/files/<company-id>/<file-id>/<filename>
```

This is the existing persistent volume, not the container image or a temporary folder.
The shareable address is `/files/<file-id>/<filename>` on the app's domain. It contains
no agent ID or session ID. The host determines the company; an agent cannot choose it.

## Publish once the file is ready

Pi agents call:

```text
share_file({ path: "documents/invoice.pdf" })
```

Shell-capable engines use the same host function through its thin client:

```sh
node "$CLOUD_PI_SHARE_FILE" "documents/invoice.pdf"
```

The publisher resolves the source inside the caller's workspace, checks the real path
against symlink escapes, and copies the file into shared storage. It hashes the filename
and bytes while copying. Only a finished, non-empty copy becomes visible at the final
location. That hash is the file ID. Concurrent publication of the same version is safe;
neither call replaces an existing file.

The returned `shared_files` array contains each file's `id`, `name`, `bytes`, `url`, and
Markdown `link`. The tool result is the source of truth. The model may describe the file,
but must copy the returned URL exactly.

Document Intelligence's generators call this publisher automatically. They return the
reference in `pdf` or `file`, plus `shared_files`. Issued documents save the shared route
in `document.pdf_path`. `get_document` reads that saved reference; for an older document
with a workspace path it publishes the existing PDF without rendering or issuing again,
then updates only `pdf_path` to the shared route. Later lookups no longer need the original
workspace file. The invoice's business data and numbering do not change.

## Display and handoff

The stream handler extracts structured references from the full tool result before its
display text is shortened. It stores them on the tool block in the existing message
transcript. The client renders a file attachment from that reference, independently of
the assistant's Markdown or which agent is currently selected.

The app's service worker must pass `/files/` requests to the network, including navigation.
Never serve the offline app page or cache file bytes for this route. Dev/preview proxy it to the host.

Specialist turns return `shared_files`. Orchestrator persists them in its existing task
row and returns them with dispatch/status results. No path inference or prose rewriting
is required. Use `shared_files` for every new tool that publishes files.

## Persistence and access

- Same filename and contents: same file ID and URL.
- Changed contents: new ID; the old URL continues to serve the old bytes.
- New session, agent handoff, process restart or deployment: no change to the URL.
- Removing or replacing the original workspace file: no change to the published copy.
- Company reset: business rows may be reset, but shared files remain.
- Deletion: only an explicit file deletion should remove a published copy; this change
  introduces no automatic cleanup or expiry.

Downloads require the existing owner session or API authorization and resolve only
inside the host-selected company's folder. PDF/media files can open inline. Other files,
including HTML, download as attachments so uploaded active content cannot run as the app.
The current app has one operator and a default company. Company folders already separate
storage, but full user-to-company membership remains a user-management responsibility.

No new database table, storage service, background worker or in-memory file registry is
needed. File bytes and IDs are on disk; invoice/task/message references use the existing
database. Volume backup and retention follow the app's existing storage operations.

## Compatibility and future changes

Keep `/api/files/raw` for historical links. Its workspace behavior is not the contract
for new shared files. Old absolute workspace links in chat retain their explicit owner;
they are not relabeled as the currently selected agent.

Do not invent URLs from filenames. Do not return `file://` or `/storage/` paths to users.
Do not add new regex passes that rewrite assistant replies. If a link in old history is
invalid, retrieve its document or publish the existing source file again.

Relevant code:

- `server/shared-files.mjs`: the single publisher and disk reader.
- `server/file-sharing.mjs`: agent authentication, common rules and download route.
- `server/share-file-cli.mjs`, `agent/extensions/share-file.ts`: thin clients.
- `document_inteligence/core/actions.mjs`: automatic publication and invoice lookup.
- `shared/shared-files.mjs`, `server/pi-stream.mjs`: structured attachment extraction.
- `server/orchestrator.mjs`, `app/chat-parts.tsx`: persistence, handoff and display.

Verification: `node --test server/shared-files.test.mjs shared/workspace-links.test.mjs`,
the Document Intelligence test suite, and the frontend build.
