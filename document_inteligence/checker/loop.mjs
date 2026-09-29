// Worker -> checker -> (fail + reason) -> same worker, same session. Capped, then honest.
import { feedbackMessage } from "./index.mjs";

/**
 * @param {{
 *   checker: ReturnType<import("./index.mjs").createChecker>,
 *   run: (message: string) => Promise<{ reply: string }>,   one worker turn in the SAME session
 *   callsThisTurn: () => any[],                                every tool call since the user message
 *   agent: string, input: string, earlier?: string[], maxRetries?: number,
 * }} opts
 */
export async function runChecked({ checker, run, callsThisTurn, agent, input, earlier = [], maxRetries = 2 }) {
  const attempts = [];
  let message = input;
  for (;;) {
    const turn = await run(message);
    const verdict = await checker.checkReply({ agent, input, earlier, toolCalls: callsThisTurn(), reply: turn.reply });
    attempts.push({ message, reply: turn.reply, verdict });
    if (verdict.pass || attempts.length > maxRetries) break;
    message = feedbackMessage(verdict.problems);
  }
  const last = attempts.at(-1);
  const passed = last.verdict.pass;
  const reply = passed ? last.reply : `${last.reply}\n\n> Checker could not confirm this reply: ${last.verdict.problems.join(" ")}`;
  return { reply, passed, attempts };
}
