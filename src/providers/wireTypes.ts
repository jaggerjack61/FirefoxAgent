/**
 * Provider protocol types: the wire-level shapes for OpenAI-compatible
 * endpoints (chat completions + responses API), kept separate from the
 * provider-agnostic types in shared/types.ts.
 */

export interface ChatCompletionsToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionsMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: "text"; text: string }> | null;
  tool_calls?: ChatCompletionsToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatCompletionsRequest {
  model: string;
  reasoning_effort?: "low" | "medium" | "high" | "xhigh" | "max";
  messages: ChatCompletionsMessage[];
  tools?: { type: "function"; function: { name: string; description: string; parameters: unknown } }[];
  tool_choice?: "auto" | "none" | "required";
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  response_format?: { type: "json_object" } | { type: "json_schema"; json_schema: unknown };
  stop?: string[];
}

export interface ChatCompletionsChunk {
  choices?: {
    delta: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface ChatCompletionsResponse {
  choices: {
    message: ChatCompletionsMessage;
    finish_reason: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// ---------------------------------------------------------------------------
// Responses API (OpenAI native protocol)
// ---------------------------------------------------------------------------

export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters: unknown;
  strict?: boolean;
}

export interface ResponsesMessageInput {
  type: "message";
  role: "system" | "user" | "assistant";
  content: Array<{ type: "output_text"; text: string } | { type: "input_text"; text: string }>;
}

export interface ResponsesFunctionCallOutputInput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponsesInputItem = ResponsesMessageInput | ResponsesFunctionCallOutputInput;

export interface ResponsesRequest {
  model: string;
  reasoning?: { effort: "low" | "medium" | "high" | "xhigh" | "max" };
  instructions?: string;
  input: ResponsesInputItem[];
  tools?: ResponsesFunctionTool[];
  temperature?: number;
  max_output_tokens?: number;
  stream?: boolean;
}

export interface ResponsesFunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status: "completed";
}

export interface ResponsesMessage {
  type: "message";
  role: "assistant";
  content: Array<{ type: "output_text"; text: string }>;
}

export type ResponsesOutputItem = ResponsesFunctionCall | ResponsesMessage;

export interface ResponsesResponse {
  output: ResponsesOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface ResponsesStreamEvent {
  type: string;
  item_id?: string;
  output_index?: number;
  delta?: string;
  response?: { status?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  call_id?: string;
  name?: string;
  arguments?: string;
}
