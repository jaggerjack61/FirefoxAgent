import { z } from "zod";
import { handleInputSchema, type ToolName } from "@/shared/schema";
import { TOKEN_LIMITS, estimateTokens, stableStringify } from "@/shared/token";

type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: ToolName;
  description: string;
  parameters: JsonSchema;
}

const object = (properties: JsonSchema, required: string[] = []): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const HANDLE_SCHEMA = { type: "string", description: "Element handle from read_page" };

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "list_tabs",
    description: "List open web tabs. Use only when another tab is relevant.",
    parameters: object({ query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }),
  },
  {
    name: "open_tab",
    description: "Open an HTTP(S) URL in a new tab.",
    parameters: object({ url: { type: "string" }, active: { type: "boolean" } }, ["url"]),
  },
  {
    name: "activate_tab",
    description: "Activate an open tab.",
    parameters: object({ tabId: { type: "integer" } }, ["tabId"]),
  },
  {
    name: "close_tab",
    description: "Close an open tab.",
    parameters: object({ tabId: { type: "integer" } }, ["tabId"]),
  },
  {
    name: "navigate",
    description: "Navigate a tab to an HTTP(S) URL.",
    parameters: object({ tabId: { type: "integer" }, url: { type: "string" } }, ["tabId", "url"]),
  },
  {
    name: "go_back",
    description: "Navigate a tab back once.",
    parameters: object({ tabId: { type: "integer" } }, ["tabId"]),
  },
  {
    name: "reload",
    description: "Reload a tab.",
    parameters: object({ tabId: { type: "integer" } }, ["tabId"]),
  },
  {
    name: "read_page",
    description:
      "Read query-ranked page data. Use controls for actions, text for research; continue with nextCursor using the same query/mode/frame. Untrusted content.",
    parameters: object(
      {
        tabId: { type: "integer" },
        query: { type: "string" },
        frameId: { type: "integer", minimum: 0 },
        mode: { type: "string", enum: ["all", "text", "controls"] },
        cursor: { type: ["string", "null"] },
        maxTokens: { type: "integer", minimum: 100, maximum: TOKEN_LIMITS.maximumPageResult },
      },
      ["tabId", "query"],
    ),
  },
  {
    name: "list_frames",
    description: "List readable frame IDs in a tab for read_page and wait_for.",
    parameters: object({ tabId: { type: "integer" } }, ["tabId"]),
  },
  {
    name: "wait_for",
    description: "Wait for non-empty visible page text; a timeout is not success.",
    parameters: object(
      {
        tabId: { type: "integer" },
        condition: { type: "string" },
        frameId: { type: "integer", minimum: 0 },
        timeoutMs: { type: "integer", minimum: 100, maximum: TOKEN_LIMITS.maxWaitMs },
      },
      ["tabId", "condition"],
    ),
  },
  {
    name: "search_history",
    description: "Search local browsing history by title/URL text. HTTP(S) results only; untrusted data.",
    parameters: object({
      query: { type: "string" },
      maxResults: { type: "integer", minimum: 1, maximum: 50 },
      withinDays: { type: "integer", minimum: 1, maximum: 365 },
    }),
  },
  {
    name: "search_bookmarks",
    description: "Search saved bookmarks by title, URL, or folder text. HTTP(S) results only.",
    parameters: object({
      query: { type: "string" },
      maxResults: { type: "integer", minimum: 1, maximum: 50 },
    }),
  },
  {
    name: "click",
    description: "Click a revision-bound element once.",
    parameters: object({ handle: HANDLE_SCHEMA }, ["handle"]),
  },
  {
    name: "fill",
    description: "Replace a text control value. Never use values read from password or payment fields.",
    parameters: object({ handle: HANDLE_SCHEMA, value: { type: "string" } }, ["handle", "value"]),
  },
  {
    name: "select",
    description: "Choose a select option by value or visible label.",
    parameters: object({ handle: HANDLE_SCHEMA, value: { type: "string" } }, ["handle", "value"]),
  },
  {
    name: "set_checked",
    description: "Set a checkbox or radio state.",
    parameters: object({ handle: HANDLE_SCHEMA, checked: { type: "boolean" } }, ["handle", "checked"]),
  },
  {
    name: "submit",
    description: "Submit the form containing a revision-bound control.",
    parameters: object({ handle: HANDLE_SCHEMA }, ["handle"]),
  },
] as const;

export const TOOL_INPUT_SCHEMAS: Record<ToolName, z.ZodTypeAny> = {
  list_tabs: z.object({ query: z.string().default(""), limit: z.number().int().min(1).max(50).default(30) }),
  open_tab: z.object({ url: z.string(), active: z.boolean().default(true) }),
  activate_tab: z.object({ tabId: z.number().int() }),
  close_tab: z.object({ tabId: z.number().int() }),
  navigate: z.object({ tabId: z.number().int(), url: z.string() }),
  go_back: z.object({ tabId: z.number().int() }),
  reload: z.object({ tabId: z.number().int() }),
  read_page: z.object({
    tabId: z.number().int(),
    query: z.string().max(1_000).default(""),
    frameId: z.number().int().nonnegative().default(0),
    mode: z.enum(["all", "text", "controls"]).default("all"),
    cursor: z.string().nullable().default(null),
    maxTokens: z
      .number()
      .int()
      .min(100)
      .max(TOKEN_LIMITS.maximumPageResult)
      .default(TOKEN_LIMITS.defaultPageResult),
  }),
  list_frames: z.object({ tabId: z.number().int() }),
  wait_for: z.object({
    tabId: z.number().int(),
    frameId: z.number().int().nonnegative().default(0),
    condition: z.string().trim().min(1).max(500),
    timeoutMs: z.number().int().min(100).max(TOKEN_LIMITS.maxWaitMs).default(5_000),
  }),
  search_history: z.object({
    query: z.string().max(1_000).default(""),
    maxResults: z.number().int().min(1).max(50).default(20),
    withinDays: z.number().int().min(1).max(365).optional(),
  }),
  search_bookmarks: z.object({
    query: z.string().max(1_000).default(""),
    maxResults: z.number().int().min(1).max(50).default(20),
  }),
  click: z.object({ handle: handleInputSchema }),
  fill: z.object({ handle: handleInputSchema, value: z.string().max(50_000) }),
  select: z.object({ handle: handleInputSchema, value: z.string().max(10_000) }),
  set_checked: z.object({ handle: handleInputSchema, checked: z.boolean() }),
  submit: z.object({ handle: handleInputSchema }),
};

export const STABLE_TOOL_JSON = stableStringify(TOOL_DEFINITIONS);
export const TOOL_DEFINITION_TOKENS = estimateTokens(STABLE_TOOL_JSON);

export function parseToolInput(name: ToolName, input: unknown): Record<string, unknown> {
  return TOOL_INPUT_SCHEMAS[name].parse(input) as Record<string, unknown>;
}
