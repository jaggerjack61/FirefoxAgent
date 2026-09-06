import {
  actionIntentSchema,
  type ActionClassification,
  type ActionIntent,
  type SafetyMode,
  type ToolName,
} from "@/shared/schema";
import { createId } from "@/shared/token";

export interface TargetDescriptor {
  name?: string;
  role?: string;
  tag?: string;
  href?: string;
  kind?: "navigation" | "control" | "unknown";
}

const READ_TOOLS = new Set<ToolName>(["list_tabs", "list_frames", "read_page", "wait_for"]);
const NAVIGATION_TOOLS = new Set<ToolName>(["open_tab", "activate_tab", "navigate", "go_back", "reload"]);
const REVERSIBLE_TOOLS = new Set<ToolName>(["fill", "select", "set_checked"]);

export function classifyAction(tool: ToolName, target?: TargetDescriptor): ActionClassification {
  if (READ_TOOLS.has(tool)) return "read";
  if (NAVIGATION_TOOLS.has(tool)) return "navigation";
  if (REVERSIBLE_TOOLS.has(tool)) return "reversible";
  if (tool === "submit") return "submission";
  if (tool === "close_tab") return "destructive";
  if (tool === "click") {
    return target?.kind === "navigation"
      ? "navigation"
      : target?.kind === "control"
        ? "submission"
        : "unknown";
  }
  return "unknown";
}

export function requiresConfirmation(mode: SafetyMode, classification: ActionClassification): boolean {
  if (mode === "yolo" || classification === "read") return false;
  if (mode === "interactive") return true;
  return classification === "submission" || classification === "destructive" || classification === "unknown";
}

export function makeActionIntent(
  runId: string,
  tool: ToolName,
  input: Record<string, unknown>,
  target?: TargetDescriptor,
): ActionIntent {
  const handle =
    input.handle && typeof input.handle === "object" ? (input.handle as Record<string, unknown>) : undefined;
  return actionIntentSchema.parse({
    id: createId("action"),
    runId,
    tool,
    classification: classifyAction(tool, target),
    tabId:
      typeof input.tabId === "number"
        ? input.tabId
        : typeof handle?.tabId === "number"
          ? handle.tabId
          : undefined,
    frameId: typeof handle?.frameId === "number" ? handle.frameId : undefined,
    target: target?.name || target?.role || target?.tag,
    redactedArgs: redactActionInput(input),
  });
}

export function redactActionInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (["value", "text", "password", "apiKey", "token"].includes(key)) return [key, "[redacted]"];
      return [key, value];
    }),
  );
}

export function assertWebUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) pages can be controlled");
  }
  return url.toString();
}
