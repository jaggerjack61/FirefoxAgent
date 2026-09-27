import { afterEach, describe, expect, it, vi } from "vitest";
import { providerRequest, sseResponse } from "@/test/providerFixture";
import { ChatCompletionsAdapter, buildChatPayload } from "./chat";

afterEach(() => vi.unstubAllGlobals());

describe("Chat Completions adapter", () => {
  it("serializes stable instructions before dynamic messages and disables parallel ambiguity", () => {
    const request = providerRequest("chat_completions");
    const payload = buildChatPayload(request);
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.role).toBe("system");
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "Summarize the active article." });
    expect(payload.stream_options).toEqual({ include_usage: true });
    expect(payload.max_tokens).toBe(2_048);
  });

  it("maps developer-role context messages to system", () => {
    const request = providerRequest("chat_completions");
    expect(request.baseMessages.some((message) => message.role === "developer")).toBe(true);
    const messages = buildChatPayload(request).messages as Array<Record<string, unknown>>;
    expect(messages.every((message) => message.role !== "developer")).toBe(true);
    expect(messages.filter((message) => message.role === "system").length).toBeGreaterThan(1);
  });

  it("assembles streamed tool-call fragments and usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { choices: [{ delta: { content: "I will read. " } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_", function: { name: "read_", arguments: '{"tabId":' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "9", function: { name: "page", arguments: '4,"query":"title"}' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [],
            usage: {
              prompt_tokens: 120,
              prompt_tokens_details: { cached_tokens: 80 },
              completion_tokens: 15,
              total_tokens: 135,
            },
          },
          "[DONE]",
        ]),
      ),
    );
    const deltas: string[] = [];
    const result = await new ChatCompletionsAdapter().stream(providerRequest("chat_completions"), (event) => {
      if (event.type === "text_delta") deltas.push(event.text);
    });
    expect(deltas.join("")).toBe("I will read. ");
    expect(result.toolCalls).toEqual([
      { id: "call_9", name: "read_page", arguments: { tabId: 4, query: "title" } },
    ]);
    expect(result.usage).toMatchObject({
      input: 120,
      cachedInput: 80,
      output: 15,
      total: 135,
      estimated: false,
    });
  });

  it("answers with reasoning only when the provider returned nothing else", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { choices: [{ delta: { reasoning: "Only thoughts" }, finish_reason: "stop" }] },
          "[DONE]",
        ]),
      ),
    );
    const result = await new ChatCompletionsAdapter().stream(
      providerRequest("chat_completions"),
      () => undefined,
    );
    expect(result).toMatchObject({ text: "Only thoughts", reasoning: "Only thoughts" });
  });

  it("never sends an empty tool_calls array for a text-only step", () => {
    const request = providerRequest("chat_completions");
    const payload = buildChatPayload({
      ...request,
      steps: [{ text: "Checked", toolCalls: [], toolResults: [] }],
    });
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages.at(-1)).toEqual({ role: "assistant", content: "Checked" });
  });

  it("surfaces reasoning_content and falls back to a non-streaming JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { choices: [{ delta: { reasoning_content: "Thinking hard… " } }] },
          { choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] },
          "[DONE]",
        ]),
      ),
    );
    const deltas: string[] = [];
    const result = await new ChatCompletionsAdapter().stream(providerRequest("chat_completions"), (event) => {
      if (event.type === "text_delta") deltas.push(event.text);
    });
    expect(deltas.join("")).toBe("Thinking hard… Done.");
    // Reasoning is display-only: it must not be replayed to the model or become the answer.
    expect(result.text).toBe("Done.");
    expect(result.reasoning).toBe("Thinking hard… ");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                { message: { role: "assistant", content: "Full body answer" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const fallback = await new ChatCompletionsAdapter().stream(
      providerRequest("chat_completions"),
      () => undefined,
    );
    expect(fallback.text).toBe("Full body answer");
    expect(fallback.usage).toMatchObject({ input: 10, output: 4, estimated: false });
  });

  it("retries an explicit max_tokens rejection using max_completion_tokens without changing the budget", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message:
                "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(sseResponse([{ choices: [{ delta: { content: "OK" } }] }, "[DONE]"]));
    vi.stubGlobal("fetch", fetchMock);
    const request = providerRequest("chat_completions");
    const result = await new ChatCompletionsAdapter().stream(request, () => undefined);
    expect(result.text).toBe("OK");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(String(fetchMock.mock.calls[1]?.[1].body));
    expect(payload.max_completion_tokens).toBe(request.policy.outputReserve);
    expect(payload.max_tokens).toBeUndefined();
  });

  it.each([400, 401, 429, 500])("does not retry unrelated HTTP %s errors", async (status) => {
    const fetchMock = vi.fn(async () => new Response("Request rejected", { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new ChatCompletionsAdapter().stream(providerRequest("chat_completions"), () => undefined),
    ).rejects.toThrow("Request rejected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["<html>Sign in</html>", "null", "{}", '{"choices":[]}'])(
    "rejects invalid or empty completion bodies: %s",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body)),
      );
      await expect(
        new ChatCompletionsAdapter().stream(providerRequest("chat_completions"), () => undefined),
      ).rejects.toThrow(/no text or tool calls.*base URL/);
    },
  );

  it("rejects empty SSE streams instead of reporting a successful connection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(["[DONE]"])),
    );
    await expect(
      new ChatCompletionsAdapter().stream(providerRequest("chat_completions"), () => undefined),
    ).rejects.toThrow("no text or tool calls");
  });

  it("preserves output-limit failures even when no text was produced", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([{ choices: [{ delta: {}, finish_reason: "length" }] }, "[DONE]"])),
    );
    const result = await new ChatCompletionsAdapter().stream(
      providerRequest("chat_completions"),
      () => undefined,
    );
    expect(result.incomplete).toBe(true);
  });

  it("omits tool controls when no tools are supplied", () => {
    const request = providerRequest("chat_completions");
    request.tools = [];
    const payload = buildChatPayload(request);
    expect(payload.tools).toBeUndefined();
    expect(payload.tool_choice).toBeUndefined();
    expect(payload.parallel_tool_calls).toBeUndefined();
  });

  it("compacts into the strict configured JSON request", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"goal":"finish"}' } }],
            usage: { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = providerRequest("chat_completions");
    const result = await new ChatCompletionsAdapter().compact({
      settings: request.settings,
      messages: request.baseMessages,
      policy: request.policy,
      signal: request.signal,
    });
    expect(result.content).toBe('{"goal":"finish"}');
    const call = (fetchMock.mock.calls as unknown[][])[0];
    const payload = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as Record<
      string,
      unknown
    >;
    expect(payload.response_format).toEqual({ type: "json_object" });
    expect(payload.max_tokens).toBe(700);
  });
});
