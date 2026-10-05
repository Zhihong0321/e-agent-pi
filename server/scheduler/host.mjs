import { readFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "../paths.mjs";
import { ensureSchedulerSchema, setSchedulerPool } from "./store.mjs";
import { setSchedulerCatalog } from './actions.mjs';

export const SCHEDULER_AGENT_ID = "scheduler";

export async function ensureScheduler({ pool, catalog, log = () => {} } = {}) {
  try {
    setSchedulerPool(pool);
    setSchedulerCatalog(catalog);
    await ensureSchedulerSchema(pool);
    const rolePath = path.join(ROOT, "agent", "roles", "scheduler.md");
    const rolePrompt = await readFile(rolePath, "utf8").catch(() => "You are Scheduler AI.");

    if (catalog?.seedSystemAgent) {
      await catalog.seedSystemAgent({
        id: SCHEDULER_AGENT_ID,
        slug: SCHEDULER_AGENT_ID,
        name: "Scheduler AI",
        short: "SA",
        headline: "Schedule AI jobs and reminders",
        description:
          "Creates and manages workspace reminders, email reminders, and one-time or recurring AI jobs. Validates timing, previews occurrences and enforces execution authorization.",
        color: "indigo",
        rolePrompt,
        toolProfile: "assistant",
        thinkingLevel: "low",
        userFacing: true,
      });
    }
    log("info", "Scheduler system agent and storage initialized");
  } catch (error) {
    log("warn", `Scheduler initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
