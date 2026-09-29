---
name: web-search
description: Search the web by keyword and get ranked results (title, URL, snippet). Use when a question needs current or outside information you do not already have, such as news, prices, docs, or "look this up". Not for reading a specific known URL.
---

# Web search (host)

Run a keyword search on the host. Tokens stay on the host; you only get results.

```bash
node "$CLOUD_PI_SEARCH" "keywords to search"
node "$CLOUD_PI_SEARCH" "keywords to search" --num 8
```

If `$CLOUD_PI_SEARCH` is empty, web search is not configured. Tell the user to add Jina tokens in Settings → Keys. Do not ask them to paste a token in chat.

## Reading the result

JSON on one line. Check `ok` first.

- `ok: true` → `results` is a list of `{ title, url, snippet }`, best first.
- `ok: false` → `error` says why. Report it plainly; do not retry more than once.

## Habits

- Search with a few precise keywords, not a full sentence. Refine the words rather than repeating the same query.
- Snippets are enough for most answers. Only add `--full` when a snippet is not enough: it returns page text per result and burns far more of the shared search allowance.
- To read one specific page from a result, fetch that URL with your usual page tools instead of searching again.
- Cite the URLs you used. Do not present a snippet as verified fact if sources disagree.
