/** Local timing tools. These deliberately do not touch the browser or provider. */

import { z } from "zod";
import { ToolError } from "@/shared/errors";
import { sleep } from "@/shared/id";
import { defineTool } from "./ToolRegistry";

export const MAX_WAIT_SECONDS = 300;

export const waitTool = defineTool({
  name: "wait",
  description:
    "Wait locally for the requested number of seconds before continuing. Use this for page countdowns, delayed downloads, or other timers. No LLM request is made during the wait; continue with the next tool only after it completes.",
  inputSchema: z.object({
    seconds: z.number().finite().min(0.1).max(MAX_WAIT_SECONDS).describe("How many seconds to wait (0.1 to 300)"),
    reason: z.string().trim().max(200).optional().describe("Short reason for the wait, such as a page countdown"),
  }),
  async execute(input, ctx) {
    const startedAt = Date.now();
    await sleepWithAbort(Math.round(input.seconds * 1000), ctx.signal);
    return {
      waitedSeconds: input.seconds,
      elapsedMs: Date.now() - startedAt,
      ...(input.reason ? { reason: input.reason } : {}),
    };
  },
});

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(new ToolError("AGENT_STOPPED", "Wait cancelled because the agent was stopped."));

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new ToolError("AGENT_STOPPED", "Wait cancelled because the agent was stopped."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
