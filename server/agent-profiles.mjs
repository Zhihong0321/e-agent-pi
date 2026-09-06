/**
 * Per-agent tool profiles and thinking levels. These trade Pi's default
 * coding-assistant prompt and built-in tool set for a smaller footprint on
 * agents that only answer questions through MCP tools or read-only
 * shell/API calls — see pi-agent-diet-plan.md.
 */

/** Under 60 words: who's reading, answer first, use MCP tools, never claim edits. */
export const NON_CODING_SYSTEM_PROMPT =
  "You're a data/ops assistant, often read from a phone by a non-technical operator. " +
  "Answer first, in plain language — no code, no file paths. Prefer your MCP tools; fall " +
  "back to the documented API/SQL only when no tool covers the question. You have not " +
  "edited any files — never claim to. Route website/repo requests to the agent handling them.";

/**
 * `coding` — Pi's default coding prompt + built-in read/bash/edit/write (website, proposal, newpages).
 * `ops` — non-coding prompt + read/bash only, no edit/write (settings, package, afa-rate).
 * `assistant` — non-coding prompt + no built-in tools at all, MCP only (sales, once curl fallbacks move to a skill).
 */
export const TOOL_PROFILES = {
  coding: { systemPrompt: null, tools: null, noBuiltinTools: false },
  ops: { systemPrompt: NON_CODING_SYSTEM_PROMPT, tools: ["read", "bash"], noBuiltinTools: false },
  assistant: { systemPrompt: NON_CODING_SYSTEM_PROMPT, tools: null, noBuiltinTools: true },
};

export const DEFAULT_TOOL_PROFILE = "coding";

export function normalizeToolProfile(value) {
  return Object.prototype.hasOwnProperty.call(TOOL_PROFILES, value) ? value : DEFAULT_TOOL_PROFILE;
}

/** Pi's built-in tool set when a profile doesn't restrict it (see `pi --help`). */
export const DEFAULT_BUILTIN_TOOLS = ["read", "bash", "edit", "write"];

/** The tool names actually available under a resolved profile, for reporting/diagnostics. */
export function toolsForProfile(value) {
  const profile = TOOL_PROFILES[normalizeToolProfile(value)];
  if (profile.noBuiltinTools) return [];
  return profile.tools || DEFAULT_BUILTIN_TOOLS;
}

/** Pi's own `--thinking <level>` values (see `pi --help`). Empty/null means "don't pass the flag". */
export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function normalizeThinkingLevel(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return VALID_THINKING_LEVELS.includes(text) ? text : null;
}

/**
 * A skill whose body tells the agent to shell out (host CLI wrappers or raw curl) needs
 * `bash` even under the `assistant` profile. Matched against the skill's SKILL.md text.
 */
const BASH_NEEDING_PATTERN = /\$CLOUD_PI_(?:CATALOG|IMAGEN|SITES|PDF|PACKAGE_SHEET)\b|(?:^|[^\w$])curl[ \t]/m;

export function skillMarkdownNeedsBash(markdown) {
  return BASH_NEEDING_PATTERN.test(String(markdown || ""));
}
