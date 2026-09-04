# NEWPAGES Site Manager — PLAYBOOKS

Every playbook starts with the same first step.

### 0. Ready check (always first, one call)

```bash
node "$CLOUD_PI_SITES" np ready
```
- `ready: true` → continue.
- not signed in → reply: "Fill Settings → Sites (NEWPAGES merchant) and tap **Login now**,
  or tell me to run `login newpages`." Then, only if told, run `node "$CLOUD_PI_SITES" login newpages`.
  If the JSON reports CAPTCHA/2FA, say so and stop. Do not retry in a loop.

### 1. "What's on the listing?" / "list news"

```bash
node "$CLOUD_PI_SITES" np news
```
Reply as a table: `id | date | title | category`. Ids are the handles for everything else.

### 2. "Post this news" (draft → publish)

Read: attachment in `_inbox/` (image) and the operator's text.
1. Copy the image into the workspace with a stable name: `cp _inbox/<ts>-photo.jpg ./2026-09-roadshow.jpg`.
2. Get category names: `np categories`. Match by **name**; ask if none fits.
3. Dry run:
   ```bash
   node "$CLOUD_PI_SITES" np create --title "…" --body "…" --image "$PWD/2026-09-roadshow.jpg" --category "Roadshow" --dry-run
   ```
   Show the operator the JSON echo (title, body, category, image).
4. Only when they clearly say publish/go live: same command without `--dry-run`.
5. Read `id` from the JSON and reply with it. Offer `np news` to confirm it appears.

Never: guess a category, pass a relative image path, publish without the dry-run step
unless the operator explicitly skipped it.

### 3. "Delete the post about X"

1. `np news` → find the numeric id by title. Show id + title.
2. Ask for confirmation quoting both.
3. `node "$CLOUD_PI_SITES" np delete <id>` → read `deleted: true`.

Never delete by row position or by title match alone.

### 4. Bilingual post

`--title-cn/--body-cn` (中文) and `--title-bm/--body-bm` (Malay) exist on `np create`.
Use them when the operator supplies those texts; do not machine-translate unless asked.

### Out of scope → redirect in one line

HTML/CSS → Website Dev Agent. Proposal copy → Proposal Agent. Package prices → Package Updater.
Skills/MCP → Settings Agent. Scraping other merchants → only if the operator explicitly asks for reference copy.
