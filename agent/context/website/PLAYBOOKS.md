# Website Dev Agent — PLAYBOOKS

### Text / value change (email, phone, number, wording)
When: "update X to Y on the site".
Read: CODEMAP concept index → the exact lines. `grep -n "old value" index.html` to confirm.
Edit: every location listed (JSON-LD + visible + footer). Keep formatting. Do not invent a phone or street address; the PR Center does not publish either.
Verify: `grep -n "old value" index.html styles.css script.js` returns nothing.
Done when: reply lists each place changed and the live URL. First edit within 5 tool calls.
Never: invent a value that is not on the page or in PROJECT.md; if the operator's value contradicts PROJECT.md (e.g. a second registration number), ask once.

### Add / edit a certification row
Read: index.html :392-471 (one `article.reg-row` as template).
Edit: insert/modify the row keeping NO. sequence and the six columns; if the credential is headline-worthy also og:description :10 and PRODUCT.md § Positioning; drop the document into `assets/certs/` if supplied.
Verify: count rows `grep -c 'class="reg-row"' index.html` (header row + N).
Done when: row visible under the register; live URL.

### Update the verified metrics
Read: :266-309.
Edit: `data-count` **and** the visible text for each of the three readouts; the SYNCED :273 and CHECKED :288/:296/:304 timestamps; og:description :10.
Verify: `grep -n "data-count" index.html` shows the new values.
Never: change one without the other; the count-up animation reads `data-count`, screen readers and no-JS read the text.

### Generate and place an image
When: "add a photo/hero image of …".
1. `node "$CLOUD_PI_IMAGEN" generate --prompt "…" --out assets/<name>.png --aspect 16:9` (JSON result has `path`, `bytes`).
2. Reference it with a relative path in index.html; add `alt`; add a caption if it replaces a "synthetic" SVG drawing (DESIGN.md § Provenance).
3. Show it in the reply: `![desc](assets/<name>.png)`.
Verify: `ls -l assets/<name>.png`; `grep -n "<name>.png" index.html`.
Never: `/assets/...` absolute paths; images over ~2 MB without mentioning it (they ship in the bundle).

### Fonts
Host boot rewrites `url("../assets/fonts/` → `url("assets/fonts/` in styles.css if the old
path reappears. Live check: `https://ee-html.up.railway.app/app/e-agent-site/assets/fonts/Archivo-400-n-0102.woff2` returns `font/woff2`.

### Add a section
Read: an existing section of the same shape (:310 capability for rows, :484 field for cards) and styles.css block for it.
Edit: markup after the closest sibling; styles in a new `/* ==== NAME ==== */` block using `:root` tokens only; add nav/mobile/footer anchors (three places).
Verify: anchors resolve (`grep -n 'href="#newid"' index.html` → 3 hits, `id="newid"` → 1).

### Redesign / restyle
When: "redesign", "I don't like the style", "more images".
Do **not** run `/impeccable init` (PRODUCT.md exists) and do **not** start the concept-seed / build-phase ceremony unless the operator explicitly asks for a full new visual world; `.impeccable/build/state.json` already has an abandoned comp round from 2026-09-03.
1. Restate the requested direction in 3 bullets and get one "go".
2. Change tokens in `:root` first (:245), then component blocks, then markup. Keep section ids and the content facts.
3. Use `/impeccable polish` or `/impeccable critique` on `index.html` for a review pass if attached.
4. Generate images with the Imagen playbook where the brief says "more images".
Done when: one summary of what changed per section + live URL. No more than one clarifying question for the whole job.

### Clean the workspace (one-time)
Host boot already deletes `README.md`, `Dockerfile`, `.dockerignore`, unused cert PDFs, and
the unused `solar-panel*.png` files. Do not re-add those. Cert documents live on the PR Center.

### Out of scope → redirect
Proposal pages → Proposal Agent. Packages/prices → Package Updater. NEWPAGES → NEWPAGES Site Manager. Skills/MCP → Settings Agent. Publishing → the host does it; never ask for or use an API key.
