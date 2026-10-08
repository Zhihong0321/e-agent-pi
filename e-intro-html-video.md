# e — introduction video director's brief

**Brand:** e (by Eternalgy)

**Format:** HTML and animated application UI, rendered as video

**Length:** 2 minutes; final pacing can follow the recorded voice

**Master:** 1920 × 1080, 16:9, 30 fps

**Updated:** 5 October 2026

## Direction

Introduce e as an AI agent system for company workflows. Explain it through familiar work: documents, customers, purchases, claims, and people. The audience should leave understanding three things:

1. I can work with e, and my team can too.
2. I can ask questions and give instructions in ordinary language.
3. e connects documents, records, and specialist agents into a workflow.

This is a continuous presentation, not a sequence of static slides. A sentence becomes a document; a document becomes a record; a record becomes a workflow; the workflow resolves into the e identity.

Use text and the actual application's visual language. No photographs, image assets, stock illustrations, screenshot slides, or generated images are needed. Render the e mark as a lowercase text wordmark. Show people as initials in UI badges. A receipt is a small HTML document with selectable text, not a receipt photograph. Existing inline SVG UI icons and SVG connector paths can be retained as vector UI elements.

The preferred result is a running React/HTML presentation that reuses the current app's UI. Its displayed work is choreographed sample data, so every render has the same timing and outcome.

## Visual language

- Carry the current `/demo` UI into the film: pale surfaces, dark readable text, green accents, rounded panels, chat bubbles, compact status badges, and business tables. Resolve exact colors, font stacks, spacing, and radii from the current CSS during implementation.
- Use generous space and fewer rows than the full application. The viewer needs to read the active example without pausing.
- Keep one focal point per beat. Dim surrounding UI slightly when a field, message, or record matters.
- Use the same document and record IDs across scenes. Changes should feel like the same work moving forward.
- Use fades, short translations, small scale changes, line drawing, and restrained emphasis. Avoid constant floating, spinning, bouncing, and elaborate 3D effects.
- Narration explains the idea; the screen supplies a concrete example. Do not display a paragraph duplicating every spoken sentence.
- Show real UI labels where available. Editorial labels such as “Ready for review” may sit above the UI, but should not look like existing app buttons if they are not.

At 1080p, aim for 64–96 px main titles, 34–44 px supporting text, and 26–32 px focal UI text. Enlarge or crop the app to achieve readability rather than showing a tiny full desktop. Keep essential material at least 96 px from the frame edges. Reserve a quiet lower region for optional subtitles.

## Timeline

| Scene | Time | Purpose |
| --- | --- | --- |
| 0 — Meet e | 00:00–00:10 | Introduce the name and purpose. |
| 1 — My work. Our work. | 00:10–00:35 | Show individual and team capabilities. |
| 2 — How do you work with e? | 00:35–00:55 | Demonstrate ordinary-language interaction. |
| 3 — More than a document | 00:55–01:24 | Show saved records and connected workflows. |
| 4 — Agents working together | 01:24–01:50 | Make orchestration understandable. |
| 5 — Closing | 01:50–02:00 | Return to the brand and central promise. |

The beat timings below are provisional directing cues. Record the voice first, then align the cues while keeping deliberate reading pauses. The silent version must remain understandable through short headings, prompts, and visible results.

## Scene 0 — Meet e

### Voice

> e.
>
> By Eternalgy.
>
> An AI agent system for company workflows.

### What the viewer sees

| Time | Direction |
| --- | --- |
| 00:00–00:02 | Fade the lowercase **e** wordmark into a clean pale background. Hold it alone. |
| 00:02–00:04 | Reveal **by Eternalgy** underneath, with a gentle upward movement. |
| 00:04–00:08 | Reveal **An AI agent system for company workflows.** Small text chips appear around the mark: **Documents**, **Records**, **Team**. |
| 00:08–00:10 | The chips align into a row. Shift the wordmark toward the position it will occupy in the app header. The row makes room for the next sentence. |

### HTML and animation

Use actual text elements for the wordmark, credit, tagline, and chips. Animate opacity and translateY; use no image logo. Fade in the tagline as one sentence, rather than animating each letter. Give the opening wordmark a stable element ID so a matching wordmark can carry into the app header later.

The scene should feel calm and confident. The pause after “e” is intentional.

## Scene 1 — My work. Our work.

### Voice

> Create an invoice.
>
> Update a quotation.
>
> Build an order form.
>
> Handle purchase orders and expense claims.
>
> Work with e on your own.
>
> Or work with e as a team.

### What the viewer sees

| Time | Direction |
| --- | --- |
| 00:10–00:13 | Show **I — a person**, **We — a team**, and **e — our AI agents** as three clear labels. Emphasize I first. |
| 00:13–00:18 | Build **I can create an invoice.** Keep the sentence structure still while **create** changes to **edit**, then **update**. The object changes to **quotation**, then **order form**. |
| 00:18–00:23 | Each object briefly opens into a small HTML UI card: a draft invoice, a quotation total, and a form with two fields. These cards share app borders and typography. |
| 00:23–00:28 | **I** changes to **We**. Two more initial badges join the first. The same document card remains visible, communicating a shared company record. |
| 00:28–00:33 | Reveal three groups in sequence: **Documents**, **Company work**, **Research**. Keep them arranged, not scattered. |
| 00:33–00:35 | The surrounding cards fold into the app layout. The remaining sentence slides into the chat composer. |

Supporting labels, not a spoken inventory:

| Group | Labels |
| --- | --- |
| Documents | Invoices · Quotations · Forms |
| Company work | Purchasing · Expenses · Calendar · Email |
| Research | Companies · Suppliers · Clients · Advertising |

### HTML and animation

Build the sentence from separate spans with fixed containers for the action and object. Crossfade vertically between words without making the whole sentence jump. Reserve enough width for the longest word; shrink the sentence only as a deliberate camera move.

Use app-style cards with HTML form fields and table rows. Team badges are CSS circles or rounded squares containing initials. The cards transition into the real app shell using matching bounds: either move one persistent DOM element, or crossfade aligned duplicates.

This scene suggests shared work, not simultaneous live document editing. Do not add collaborative cursors or other behaviors that the current app does not implement.

## Scene 2 — How do you work with e?

### Voice

> Ask a question.
>
> Give an instruction.
>
> Share a document.
>
> Explain what you need, in your own words.
>
> Like working with a colleague.

### What the viewer sees

Use the current demo chat header, message styling, composer, attachment chips, and side-panel proportions. Keep the agent identity **e** visible. The app can occupy most of the frame here.

| Time | Direction |
| --- | --- |
| 00:35–00:39 | Type **“What details are missing?”** into the composer and send it. Show a short response: **“The billing address is missing.”** Briefly outline that field in a nearby customer card. |
| 00:39–00:44 | Reveal **“Draft a quotation for this customer.”** A small quotation card appears with status **Draft**. This is a separate example, not a claim that the previous missing field was silently resolved. |
| 00:44–00:50 | Change to the expense example. Attach **receipt.pdf** using the app-style chip. Show **“Help me file this expense claim.”** A small HTML receipt expands into view; its merchant, date, and amount move into a draft claim panel. |
| 00:50–00:53 | Hold the response **“Draft claim prepared. Please review the details.”** Emphasize the draft and review state. |
| 00:53–00:55 | Overlay **Your words. Your work.** The draft card moves forward while the chat recedes. This becomes the next scene's document. |

### HTML and animation

Reproduce typing by revealing text from elapsed timeline time. Sending moves that exact text from the composer into a user bubble; there should be no visibly different rewritten prompt.

Use a controlled assistant response reveal. “Working…” appears briefly before the response. After the response finishes, hold it long enough to read. Do not spend several seconds on a generic loading spinner.

The receipt is a narrow HTML card, for example:

```text
SAMPLE RECEIPT
Acme Supplies
05 Oct 2026
Office supplies
MYR 86.00
```

Draw connector lines from those text fields to matching claim fields. The attachment chip supplies the PDF context; no PDF screenshot or receipt image is required.

For the video, the upload and extraction sequence is driven by the presentation fixture. It does not need to invoke file dialogs or wait for a real model.

## Scene 3 — More than a document

### Voice

> An invoice is more than a file.
>
> It belongs to a customer.
>
> It has a number, a status, and a payment record.
>
> e keeps these connected.
>
> Documents, records, and company rules become part of one workflow.

### What the viewer sees

| Time | Direction |
| --- | --- |
| 00:55–01:00 | Match-cut the previous document card to a clean invoice card. Give it the same app styling. Show **INV-001**, **Acme Studio**, and **MYR 1,200.00**. |
| 01:00–01:06 | Pull back to reveal **Customer → Invoice → Payment record**. Highlight the customer name, invoice number, and amount in sequence. |
| 01:06–01:12 | Reveal the app's invoice table alongside the document. Outline the corresponding row. Change the displayed example from **Issued** to **Paid** only after a payment-record card is shown. |
| 01:12–01:17 | Slide into a second connected row: **Receipt → Expense claim → Review**. A review badge appears, with no automatic approval. |
| 01:17–01:21 | Reveal **Supplier → Purchase order → Goods received** below. Keep this row compact so the viewer understands the pattern without reading a dense table. |
| 01:21–01:24 | The three rows align beneath **Documents + Records + Rules = A working system**. Hold the complete idea briefly. |

### HTML and animation

Use a text-based invoice preview and the existing table styling, including the app's Draft/Issued/Paid status vocabulary. Both surfaces read the same sample fixture so names, amounts, and statuses agree.

Keep connecting lines behind the cards in an inline SVG layer. Animate their visible length as relationships are introduced. Compute line endpoints from stable design coordinates or measured card bounds after layout; do not guess screen coordinates after camera scaling.

The table should be real DOM text, not an image of a table. Limit the visible sample to two or three rows and highlight one row with a soft background change. Match the sample payment amount to the invoice total before showing Paid.

“Rules” can be explained with a small chip such as **Approval required** beside the claim. Do not display PostgreSQL, schemas, tool IDs, or implementation terminology in the film.

## Scene 4 — Agents working together

### Voice

> Some jobs need more than one specialist.
>
> e brings the right agents together.
>
> They work on their parts and pass results to the next step.
>
> You can follow the progress, review the results, and see what needs your attention.

### What the viewer sees

| Time | Direction |
| --- | --- |
| 01:24–01:28 | Return to chat with **“Help prepare a customer quotation.”** Keep the brand header visible. |
| 01:28–01:33 | The request expands into two specialist cards: **Records Clerk** and **Document Agent**. Labels explain their jobs: **Check customer details** and **Prepare draft quotation**. |
| 01:33–01:38 | The first card displays **Working** while the second waits. A small result chip reading **Customer details** passes from the first to the second. Only then does the second show **Working**. |
| 01:38–01:43 | A draft quotation appears. An editorial outcome label reads **Ready for review**. Show the user opening the result, not automatically approving it. |
| 01:43–01:47 | Brief alternate example: **Needs details — customer address missing**. The downstream step waits. Show the short next action **Add the address to continue**. |
| 01:47–01:50 | Resolve back to the overview with the phrase **One request. Clear progress.** Agent cards join the document and record cards from earlier scenes. |

### HTML and animation

Reuse the agent-card style from the app. Lay out two cards with a connector and a small progress area. If the app's job UI provides a suitable real component, reuse it with sample data. Otherwise, use a presentation overlay built from those same UI primitives; do not imply a newly invented workflow canvas is an existing app screen.

Drive the states explicitly: waiting → working → result available. The downstream card cannot begin before the dependency result arrives. The alternative Needs details example is a separate branch of the demonstration; do not mix it into the completed example as an unexplained failure.

This sequence explains orchestration as an illustrative workflow. It is not a recording that certifies the full quotation pipeline on the active production deployment. Preserve draft, review, and missing-input boundaries in the choreography.

## Scene 5 — Closing

### Voice

> e.
>
> Your company's documents, records, and workflows.
>
> Working together.
>
> By Eternalgy.

### What the viewer sees

| Time | Direction |
| --- | --- |
| 01:50–01:54 | The chat, document, record, and agent panels form a tidy composition around the e mark. Stop movement briefly so the whole picture can register. |
| 01:54–01:57 | Fade the panels into the background and return the wordmark to the centre. Reveal **Company work, connected.** |
| 01:57–02:00 | Hold the final frame: **e**, **Company work, connected.**, **by Eternalgy**. No distracting movement. |

### HTML and animation

Use the same wordmark element and proportions as the opening. Animate the surrounding panels with opacity and modest translation; do not send them flying offscreen. The ending can share the opening background to make the film feel complete.

Do not add a URL, launch claim, price, or call to action without supplied copy. The approved closing is the brand and its purpose.

## Reusing the current application

### Source references

These references were checked through Graft and the current source. They are navigation starting points; ask Graft again during implementation because local changes can move spans.

| Source | What to reuse |
| --- | --- |
| `app/demo/page.tsx:322–348` | Login and workspace entry. The normal page performs authentication; a presentation route needs its own fixture-backed entry. |
| `app/demo/page.tsx:544–581` | Demo chat header, user tag, Working/Connected status, messages, activity lines, composer, and attachment chips. |
| `app/demo/page.tsx:583` | Invoice table, Draft/Issued/Paid badges, selected-record details, and CRM/company-person summaries. |
| `app/demo/style.css` | Main demo visual language and chat layout. CSS is not fully represented by the symbol graph; resolve actual declarations before copying. |
| `app/demo/expenses.tsx:98–361`, `app/demo/expenses.css` | Expense panel structure, claim status, filters, and detail presentation. |
| `app/chat-parts.tsx:194–339` | Existing agent-card presentation. |
| `app/chat-parts.tsx:438–635` | Shared chat/conversation and assistant-turn components if useful. The `/demo` chat markup is the primary visual reference. |
| `app/use-studio.ts:42–727` | Live chat controller; understand it before adapting. Do not mount it unchanged simply to display scripted messages. |
| `app/demo/procurement.tsx`, `app/demo/research.tsx`, `app/media-kit.tsx` | Secondary panel references for supporting capability cards, if needed. |

### Recommended implementation

Build a separate local presentation entry that renders the real UI styles and appropriate components inside a video stage. Keep visual reuse and timeline state separate:

```text
VideoStage
  CameraLayer
    BrandWordmark
    AppPresentation
      ChatPanel
      DocumentPreview
      InvoiceTable
      ExpensePanel
      AgentProgress
    ConnectorLayer
  NarrationCaptions

Timeline → sample state → rendered UI
```

Prefer importing presentational components and CSS. Where a component is tightly coupled to fetching or user actions, use a video-only adapter or copy its small display section into the presentation. Match the current markup, spacing, and states. Avoid cloning the entire app or redesigning it for the film.

The presentational adapter supplies messages, users, selected records, attachments, and task states. Its buttons can visibly press and its panels can open, but the state changes come from the timeline. Use a standalone sample user/company and local fixtures rather than the production account or business records.

Replace existing `<img>` logo/avatar slots in the presentation with the lowercase e text mark or initial badges. Reusing the app does not require reusing its image assets. Keep the actual application branding files unchanged.

If running the full application offers better fidelity, run it against a local fixture API with predictable responses. Capture the DOM and its UI behavior. For final rendering, replay prerecorded/sample results with controlled timings instead of waiting on live model calls, notifications, or external services.

The transcript, document preview, invoice table, and progress overlay must derive from the same fixture wherever they describe the same event. Do not hard-code different totals in each component.

### Suggested sample data

| Item | Value |
| --- | --- |
| Company | Acme Studio |
| Operator | Maya; initial badge M |
| Additional team initials | D and A |
| Customer | Acme Studio; sample billing details |
| Invoice | INV-001; MYR 1,200.00 |
| Payment example | MYR 1,200.00 against INV-001 |
| Receipt | receipt.pdf; Acme Supplies; office supplies; MYR 86.00 |
| Claim | Draft; review required |
| Quotation | QT-001; Draft |
| Specialist sequence | Records Clerk → Document Agent |

These are presentation fixtures. Use example-domain addresses if email or websites become visible. Keep the missing-address example separate from the completed-record fixture.

## Building the animation in HTML

### Stage and camera

Create a fixed 1920 × 1080 design stage with overflow hidden. Browser preview may scale that stage to fit the window; export uses the native design size. Keep subtitles outside the animated camera layer.

Animate a camera wrapper's transform for pans and small zooms. Position the app once and bring the relevant panel into view instead of rebuilding the whole scene at every transition. Keep type crisp and zoom modest; rerender layouts at a readable size where necessary.

Use stable IDs for the wordmark, invoice, selected row, attachment, and specialist cards. Persistent DOM elements are preferred for transitions; aligned before/after copies are acceptable when preserving one element would complicate layout.

### One timeline

Every visible state must be determined by one elapsed-time value. A renderer should be able to request any frame directly:

```text
renderAt(timeSeconds)
  → choose active scene and beat
  → derive complete sample UI state
  → set text-reveal progress
  → seek element animations
  → set camera and connector progress
  → render the frame
```

At 30 fps, frame n corresponds to n / 30 seconds. A 120-second export contains 3,600 frames. Seeking to a frame must produce the same image whether playback reaches it naturally, jumps forward, or rewinds.

Use CSS/DOM for layout and a seekable animation timeline. The Web Animations API can work by pausing animations and setting `currentTime`; a timeline library can work if every animation can be sought deterministically. The implementation choice is secondary to reliable seeking.

Avoid using chains of `setTimeout`, uncontrolled CSS loops, random particle systems, wall-clock timers, or real network progress as the source of scene timing. Existing app pulses/spinners and relative timestamps must be controlled by the video clock too.

### Motion cues

| Element | Starting treatment |
| --- | --- |
| Title/label reveal | 300–500 ms fade with 12–20 px upward movement. |
| Card entrance | 400–650 ms ease-out with slight translation. |
| Word substitution | 250–400 ms crossfade inside a reserved-width slot. |
| Chat typing | Around 30–45 characters/second; longer prompts can be shortened or accelerated. |
| Assistant response | Brief Working state, then readable phrase/line reveal; hold after completion. |
| Relationship line | 400–700 ms draw, synchronized with the referenced card. |
| Selected row/field | Soft outline or background emphasis; 150–250 ms fade in. |
| Camera move | 700–1,100 ms, then settle before detailed reading. |
| Final brand frame | Hold at least 3 seconds. |

These are starting values, not rigid rules. Narration and legibility decide the final pace. Shorten copy before speeding every animation up.

### Render preparation

Load the app CSS and locally available font files before exposing a ready signal. Wait for font loading and layout to settle. The no-image version should not need remote image downloads.

After seeking, wait for the React commit, DOM layout, and any controlled animation update before capturing. Fix viewport, browser version, pixel ratio, and font availability for repeatable frames. Freeze sample dates and timestamps.

Keep preview controls outside the captured stage. Useful controls are play/pause, seek, scene jump, and a subtitle toggle. They are production tools, not content in the film.

HTML rendering should capture frames from the browser at exact timeline positions, then assemble them into video with the narration/music track. This brief specifies the behavior; it does not require implementing or exporting the video now.

## Voice, sound, and final checks

Read naturally, with short pauses after the opening e and between the three instructions in Scene 2. Use a calm voice. The word e is spoken as the letter E. Keep background music quiet beneath speech; small send/connection sounds are optional and should not dominate.

Before rendering the final film, verify:

- The narration is the approved script above and the brand is consistently e / by Eternalgy.
- No image files or screenshot slides are needed to understand any scene.
- Chat, invoice, claim, and agent UI visibly resemble the current application.
- Text can be read at normal playback speed, including in a smaller player.
- Tables, documents, and messages agree on sample names, IDs, amounts, and statuses.
- Drafts remain drafts until the depicted workflow actually changes their state; review and missing-information states are visible.
- No proposed workflow overlay is passed off as a screen already present in the app.
- Opening, scene transitions, and closing work without narration as well as with it.
- Seeking forward/backward and rendering the same timestamp twice produces the same frame.

**Deliverable for this stage:** this script and director's brief only. The HTML presentation, narration recording, and video export are the next production steps.
