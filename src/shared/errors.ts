/**
 * Structured error codes shared by tools, the agent runtime and the
 * content script. `suggestedAction` gives the agent (or user) a recovery
 * path so failures can be handled without human intervention.
 */

export type ErrorCode =
  | "ELEMENT_NOT_FOUND"
  | "ELEMENT_STALE"
  | "ELEMENT_NOT_INTERACTABLE"
  | "TAB_NOT_FOUND"
  | "TAB_CLOSED"
  | "NAVIGATION_TIMEOUT"
  | "CONTENT_SCRIPT_UNAVAILABLE"
  | "PERMISSION_REQUIRED"
  | "PERMISSION_DENIED"
  | "TOOL_NOT_FOUND"
  | "INVALID_TOOL_ARGUMENTS"
  | "MODEL_MALFORMED_OUTPUT"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "REQUEST_TIMEOUT"
  | "TASK_TIMEOUT"
  | "MAX_ITERATIONS"
  | "TOKEN_LIMIT_EXCEEDED"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_TIMEOUT"
  | "CONFIRMATION_DENIED"
  | "ACTION_NOT_ALLOWED"
  | "AGENT_STOPPED"
  | "PRIVACY_BLOCKED"
  | "INTERNAL_ERROR"
  | "NOT_IMPLEMENTED";

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly suggestedAction?: string;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { suggestedAction?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.suggestedAction = opts.suggestedAction;
    this.retryable = opts.retryable ?? false;
  }

  toJSON(): { success: false; error: ErrorCode; message: string; suggestedAction?: string } {
    return {
      success: false,
      error: this.code,
      message: this.message,
      ...(this.suggestedAction ? { suggestedAction: this.suggestedAction } : {}),
    };
  }
}

export function isToolError(err: unknown): err is ToolError {
  return err instanceof ToolError;
}

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
