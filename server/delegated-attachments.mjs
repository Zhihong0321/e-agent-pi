import { readFile } from "node:fs/promises";
import { materializeAttachments, MAX_DELEGATED_FILES } from "./attachments.mjs";
import { publishFile, readSharedFile, sharedFileLocation } from "./shared-files.mjs";

// Resolve storage references locally in the authenticated host's company. Never
// fetch model-supplied URLs, or let the model select a company or filesystem root.
export async function prepareExpenseDelegation({ message, sourceMessage = "", workspace, sourceWorkspace, root, companyId }) {
  const refs = new Map();
  // Explicit task references select the evidence. Otherwise inherit the latest
  // uploaded document manifest from the owning parent chat, without relying on
  // the Orchestrator model to copy a URL into its task prompt.
  const evidenceMessage = /\/files\/[a-f0-9]{64}\/|\b_inbox\/(?!\.\.\.)/.test(message) ? message : sourceMessage;
  for (const match of String(evidenceMessage).matchAll(/\/files\/[a-f0-9]{64}\/[^\s"'<>`)\]\\]+/g)) {
    const location = sharedFileLocation(match[0].replace(/[.,;:!?]+$/, ""));
    if (location) refs.set(`${location.id}/${location.name}`, location);
  }
  // Older uploads and plans may carry only the original Orchestrator inbox path.
  // publishFile verifies realpath confinement before resolving it in company storage.
  for (const match of String(evidenceMessage).matchAll(/\b_inbox\/[^\s"'<>`)\]\\]+/g)) {
    if (match[0].includes("...")) continue; // Documentation placeholders aren't files.
    if (!sourceWorkspace) throw new Error("Missing source workspace for delegated attachment");
    const file = await publishFile({ root, companyId, workspace: sourceWorkspace, source: match[0].replace(/[.,;:!?]+$/, "") });
    const location = sharedFileLocation(file.url);
    refs.set(`${location.id}/${location.name}`, location);
  }
  if (refs.size > MAX_DELEGATED_FILES) throw new Error(`Attach at most ${MAX_DELEGATED_FILES} delegated evidence files.`);
  const attachments = [];
  for (const location of refs.values()) {
    const { full, file } = await readSharedFile({ root, companyId, ...location });
    if (file.bytes > 8 * 1024 * 1024) throw new Error(`${file.name} is larger than 8 MB.`);
    attachments.push({ name: file.name, data: (await readFile(full)).toString("base64") });
  }
  const packed = await materializeAttachments(workspace, attachments, { complete: true });
  const receipts = packed.files.map(file => `- ${file.name}: ${file.rel}`).join("\n");
  return {
    ...packed,
    message: [packed.prompt, receipts && `Use these clerk-local receipt paths in file_claim receipts; published URLs are provenance only:\n${receipts}`, message].filter(Boolean).join("\n\n"),
  };
}

export function expenseEvidenceModel(catalog, preferred) {
  const entry = catalog.find(model => model.id === preferred);
  if (entry?.available && entry.vision) return preferred;
  const vision = catalog.find(model => model.available && model.vision && model.provider === entry?.provider)
    || catalog.find(model => model.available && model.vision);
  if (!vision) throw new Error("Receipt page images require a configured vision model");
  return vision.id;
}
