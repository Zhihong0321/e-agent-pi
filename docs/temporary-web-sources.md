# Temporary web sources

Ordinary web fetching is a host tool, not an AI summarization task. `fetch_web_source` renders one public page, saves the complete extracted body text, and returns its ID and metadata. `read_web_source` reads that stored text by section, search term or offset. Follow `hasMore`/`nextOffset` when a read spans multiple chunks. Fetch responses never silently return a truncated document as complete.

Give a source ID to the substantive worker (for example Template Designer). The orchestrator need not read the whole document first. The same URL reuses a saved copy for 24 hours; `fresh=true` explicitly refreshes it. Linked pages, PDFs and content requiring sign-in/interaction are separate extraction tasks. Advanced scrapers can preserve their full text with `save_web_source`.

Copies live at `/storage/temp/web-sources/<UUID>/source.txt` with `metadata.json` (or under the configured DATA_DIR). This tree contains disposable fetched sources only. Workspaces, uploads, shared files, documents, browser profiles, credentials and agent runtimes live elsewhere. The owner can clear these UUID folders manually or use Settings → Temporary storage to select and delete copies. A deleted reference cannot be read; fetch again if still needed. Preserve final work in the document/shared-file system first.

Owner endpoints: `GET /api/settings/temp`, `DELETE /api/settings/temp` with `{ids:[...]}`, and `GET /api/settings/temp/<id>` for complete text. All require Settings authentication. Agents receive read/fetch/save tools, not deletion tools. Cleanup accepts only managed UUID IDs, checks real paths, rejects symlinks and operates only inside the dedicated source directory. In-flight writes use staging folders and are published atomically.

Limits: 5 MB text per source, 250 MB of source text total, two concurrent page fetches. Limits cause an explicit error, never silent clipping. Storage lists text bytes; small metadata overhead is additional. Cleanup has no automatic expiry or scheduled deletion. Reuse and persistence are local to this host's volume.
