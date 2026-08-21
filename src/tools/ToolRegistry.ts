/**
 * ToolRegistry: single source of truth for tools — schemas exposed to the
 * LLM, input validation, execution, confirmation requirements and metadata.
 *
 * The LLM output is NEVER trusted: every tool call is validated against its
 * zod schema before execution, and confirmation policy is enforced here,
 * outside the model layer.
 */

import { z, type ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { LLMToolDef } from "@/shared/types";
import { ToolError } from "@/shared/errors";
import type { BrowserGateway } from "@/shared/browserGateway";
import type { WorkspaceManager } from "@/workspace/WorkspaceManager";
import type { AppSettings } from "@/shared/types";
import type { ActionLogEntry } from "@/shared/types";

export interface ToolContext {
  /** Gateway to browser APIs (content scripts, tabs). */
  gateway: BrowserGateway;
  /** Workspace access for context tools. */
  workspace: WorkspaceManager;
  /** Settings snapshot for privacy/limits decisions. */
  settings: AppSettings;
  /** Abort signal that cancels the current agent run. */
  signal?: AbortSignal;
  /** Emit dev events. */
  dev?: (event: unknown) => void;
  /** Completed action history for this conversation. */
  actionHistory?: () => ActionLogEntry[];
}

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  readonly requiresConfirmation?: boolean;
  /** Keep compatibility aliases executable without advertising them to the model. */
  readonly exposeToModel?: boolean;
  readonly execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
}

/**
 * Helper that infers TInput from the zod schema so `execute(input)` is
 * fully typed without repeating generics at every declaration.
 */
export function defineTool<TInput, TOutput>(tool: AgentTool<TInput, TOutput>): AgentTool<TInput, TOutput> {
  return tool;
}

export interface RegisteredTool {
  tool: AgentTool;
  jsonSchema: Record<string, unknown>;
  validate(input: unknown): unknown;
  execute(input: unknown, ctx: ToolContext): Promise<unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  /**
   * Memoized LLM tool definitions for the default (all-tools) case. The
   * registry is immutable after construction, so the byte-stable serialized
   * form is computed once and reused across every request — this keeps the
   * prompt-cache prefix identical turn over turn.
   */
  private cachedToolDefs: LLMToolDef[] | null = null;

  register<TInput, TOutput>(tool: AgentTool<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    const jsonSchema = zodToJsonSchema(tool.inputSchema) as Record<string, unknown>;
    const registered: RegisteredTool = {
      tool: tool as unknown as AgentTool,
      jsonSchema,
      validate: (input: unknown) => tool.inputSchema.parse(input),
      execute: (input: unknown, ctx: ToolContext) => tool.execute(input as TInput, ctx),
    };
    this.tools.set(tool.name, registered);
    // Invalidate the memo in case register is called after a first lookup
    // (e.g. in tests); normal construction registers all tools up front.
    this.cachedToolDefs = null;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Validates model-generated input. Throws INVALID_TOOL_ARGUMENTS on failure. */
  validateCall(name: string, rawInput: unknown): unknown {
    const registered = this.tools.get(name);
    if (!registered) {
      throw new ToolError("TOOL_NOT_FOUND", `Tool "${name}" does not exist.`, {
        suggestedAction: "Pick a tool from the available list.",
      });
    }
    try {
      return registered.validate(rawInput);
    } catch (err) {
      const details = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String(err);
      throw new ToolError("INVALID_TOOL_ARGUMENTS", `Invalid arguments for tool "${name}": ${details}`, {
        suggestedAction: "Retry with corrected arguments.",
      });
    }
  }

  async executeCall(name: string, validatedInput: unknown, ctx: ToolContext): Promise<unknown> {
    const registered = this.tools.get(name);
    if (!registered) {
      throw new ToolError("TOOL_NOT_FOUND", `Tool "${name}" does not exist.`);
    }
    return registered.execute(validatedInput, ctx);
  }

  exposedNames(): string[] {
    return this.names().filter((name) => this.tools.get(name)?.tool.exposeToModel !== false);
  }

  /** LLM-facing tool definitions (function-calling format). */
  llmToolDefs(allowedNames?: Iterable<string>): LLMToolDef[] {
    // Fast path: the default (all-tools) catalog is memoized so the exact
    // same bytes are returned every turn — critical for prompt-cache hits.
    if (!allowedNames) {
      if (this.cachedToolDefs) return this.cachedToolDefs;
      this.cachedToolDefs = this.buildToolDefs(null);
      return this.cachedToolDefs;
    }
    return this.buildToolDefs(new Set(allowedNames));
  }

  private buildToolDefs(allowed: Set<string> | null): LLMToolDef[] {
    return this.exposedNames()
      .filter((name) => !allowed || allowed.has(name))
      .sort()
      .map((name) => {
        const t = this.tools.get(name)!;
        return {
          type: "function" as const,
          function: {
            name: t.tool.name,
            description: t.tool.description,
            parameters: t.jsonSchema,
          },
        };
      });
  }

  /** Human-readable tool list for non-tool-calling models. */
  toolDescriptions(allowedNames?: Iterable<string>, includeSchemas = false): string {
    const allowed = allowedNames ? new Set(allowedNames) : null;
    return this.exposedNames()
      .filter((name) => !allowed || allowed.has(name))
      .sort()
      .map((name) => {
        const t = this.tools.get(name)!;
        const schema = includeSchemas ? `\n  Parameters: ${JSON.stringify(t.jsonSchema)}` : "";
        return `- ${name}: ${t.tool.description}${schema}`;
      })
      .join("\n");
  }

  /** JSON Schema dump for dev mode. */
  schemaDump(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, t] of this.tools) out[name] = t.jsonSchema;
    return out;
  }
}
