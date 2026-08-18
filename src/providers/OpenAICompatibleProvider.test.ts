import { afterEach, describe, it, expect, vi } from "vitest";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import type { ProviderConfig } from "@/shared/types";

const config: ProviderConfig = {
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  apiKey: "sk-test-1234567890",
  model: "deepseek-chat",
  reasoningEffort: "medium",
  protocol: "chat_completions",
  customHeaders: {},
  temperature: 0.2,
  maxOutputTokens: 2048,
  contextLimitTokens: 64_000,
  timeoutMs: 30_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAICompatibleProvider.listModels", () => {
  it("lists models from GET /models with the API key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider(config);
    const models = await provider.listModels();

    expect(models).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/models");
    expect(init.method).toBe("GET");
    // The models endpoint requires the API key too.
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-1234567890");
  });

  it("throws a structured error when the key is rejected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider(config);
    await expect(provider.listModels()).rejects.toThrow(/rejected the API key/i);
  });
});

describe("OpenAICompatibleProvider reasoning effort", () => {
  it("sends reasoning_effort to compatible chat-completions models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider({ ...config, model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
    await provider.send({ messages: [{ role: "user", content: "hello" }] });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("xhigh");
  });

  it("sends reasoning.effort through the Responses API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider({
      ...config,
      model: "gpt-5.6-sol",
      protocol: "responses",
      reasoningEffort: "max",
    });
    await provider.send({ messages: [{ role: "user", content: "hello" }] });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { reasoning?: { effort?: string } };
    expect(body.reasoning).toEqual({ effort: "max" });
  });

  it("omits unsupported reasoning fields for DeepSeek", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider({ ...config, model: "deepseek-reasoner", reasoningEffort: "high" });
    await provider.send({ messages: [{ role: "user", content: "hello" }] });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("reasoning");
  });
});

describe("OpenAICompatibleProvider errors and tool history", () => {
  it("includes the provider's safe error message for HTTP failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Missing tool responses for call_2" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ));

    const provider = new OpenAICompatibleProvider(config);
    await expect(provider.send({ messages: [{ role: "user", content: "hello" }] })).rejects.toThrow(
      /HTTP 400.*Missing tool responses for call_2/,
    );
  });

  it("serializes tool results without unsupported name fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider(config);
    await provider.send({
      messages: [
        { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "list_tabs", arguments: {} }] },
        { role: "tool", content: "tabs", toolCallId: "call_1", name: "list_tabs" },
      ],
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { messages: Array<Record<string, unknown>> };
    expect(body.messages[1]).toEqual({ role: "tool", content: "tabs", tool_call_id: "call_1" });
  });

  it("removes orphaned tool results and incomplete calls from trimmed history", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider(config);
    await provider.send({
      messages: [
        { role: "tool", content: "orphaned by compression", toolCallId: "old_call" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            { id: "call_1", name: "list_tabs", arguments: {} },
            { id: "call_2", name: "get_page_snapshot", arguments: {} },
          ],
        },
        { role: "tool", content: "snapshot", toolCallId: "call_2" },
        { role: "tool", content: "unknown", toolCallId: "unknown_call" },
        { role: "user", content: "continue" },
      ],
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { messages: Array<Record<string, unknown>> };
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]).toMatchObject({ role: "assistant" });
    expect(body.messages[0].tool_calls).toEqual([
      { id: "call_2", type: "function", function: { name: "get_page_snapshot", arguments: "{}" } },
    ]);
    expect(body.messages[1]).toEqual({ role: "tool", content: "snapshot", tool_call_id: "call_2" });
    expect(body.messages[2]).toMatchObject({ role: "user", content: "continue" });
  });
});

describe("OpenAICompatibleProvider prompt caching", () => {
  it("sends a cache key and explicit system breakpoint for GPT-5.6 Chat Completions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider({
      ...config,
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6-sol",
    });
    await provider.send({
      messages: [
        { role: "system", content: "Stable system instructions" },
        { role: "user", content: "Hello" },
      ],
      cacheKey: "browser-agent-v1:conv_1",
      cacheStablePrefix: true,
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, any>;
    expect(body.prompt_cache_key).toBe("browser-agent-v1:conv_1");
    expect(body.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" });
    expect(body.messages[0].content[0]).toMatchObject({
      type: "text",
      text: "Stable system instructions",
      prompt_cache_breakpoint: { mode: "explicit" },
    });
  });

  it("uses a developer input block for a Responses API cache breakpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider({
      ...config,
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6-terra",
      protocol: "responses",
    });
    await provider.send({
      messages: [
        { role: "system", content: "Stable system instructions" },
        { role: "user", content: "Hello" },
      ],
      cacheKey: "browser-agent-v1:conv_2",
      cacheStablePrefix: true,
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, any>;
    expect(body.instructions).toBeUndefined();
    expect(body.prompt_cache_key).toBe("browser-agent-v1:conv_2");
    expect(body.input[0]).toMatchObject({
      type: "message",
      role: "developer",
      content: [{
        type: "input_text",
        text: "Stable system instructions",
        prompt_cache_breakpoint: { mode: "explicit" },
      }],
    });
  });

  it("requests streamed usage from DeepSeek without sending OpenAI cache controls", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":2,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const fetchMock = vi.fn().mockResolvedValue(new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider(config);
    const response = await provider.send(
      {
        messages: [{ role: "user", content: "Hello" }],
        cacheKey: "browser-agent-v1:conv_3",
        cacheStablePrefix: true,
      },
      { onStream: vi.fn() },
    );

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body).not.toHaveProperty("prompt_cache_key");
    expect(body).not.toHaveProperty("prompt_cache_options");
    expect(response.usage).toMatchObject({ cachedInputTokens: 80, cacheMissTokens: 20 });
  });
});
