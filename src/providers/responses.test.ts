import { afterEach, describe, expect, it, vi } from "vitest";
import { providerRequest, sseResponse } from "@/test/providerFixture";
import { ResponsesAdapter, buildResponsesPayload } from "./responses";

afterEach(() => vi.unstubAllGlobals());

describe("Responses adapter", () => {
  it("keeps the stable prefix first and puts one cache breakpoint before dynamic context", () => {
    const request = providerRequest();
    request.settings.capabilities.explicitCaching = true;
    request.settings.capabilities.nativeCompaction = true;
    const payload = buildResponsesPayload(request, true);
    const input = payload.input as Array<Record<string, unknown>>;
    const developer = input[0];
    const content = developer?.content as Array<Record<string, unknown>>;
    expect(developer?.role).toBe("developer");
    expect(content[0]?.prompt_cache_breakpoint).toEqual({ mode: "explicit" });
    expect(JSON.stringify(input.slice(1))).not.toContain("prompt_cache_breakpoint");
    expect(payload.prompt_cache_key).toMatch(/^[a-f0-9]{8}$/u);
    expect(payload.truncation).toBe("disabled");
    expect(payload.context_management).toEqual([
      { type: "compaction", compact_threshold: request.policy.inputSoftLimit },
    ]);
  });

  it("invalidates the cache key when the model changes", () => {
    const first = providerRequest();
    first.settings.capabilities.explicitCaching = true;
    const second = providerRequest();
    second.settings.capabilities.explicitCaching = true;
    second.settings.model = "another-model";
    expect(buildResponsesPayload(first, true).prompt_cache_key).not.toBe(
      buildResponsesPayload(second, true).prompt_cache_key,
    );
  });

  it("preserves opaque output items and function call_id while normalizing usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { type: "response.output_text.delta", delta: "Checking" },
          {
            type: "response.completed",
            response: {
              status: "completed",
              output: [
                { type: "reasoning", id: "reasoning_1", encrypted_content: "opaque" },
                {
                  type: "function_call",
                  id: "item_1",
                  call_id: "call_42",
                  name: "read_page",
                  arguments: '{"tabId":4,"query":"article"}',
                },
              ],
              usage: {
                input_tokens: 200,
                input_tokens_details: { cached_tokens: 100, cache_write_tokens: 25 },
                output_tokens: 30,
                output_tokens_details: { reasoning_tokens: 10 },
                total_tokens: 230,
              },
            },
          },
          "[DONE]",
        ]),
      ),
    );
    const result = await new ResponsesAdapter().stream(providerRequest(), () => undefined);
    expect(result.text).toBe("Checking");
    expect(result.toolCalls[0]?.id).toBe("call_42");
    expect(result.rawResponseOutput?.[0]).toMatchObject({ type: "reasoning", encrypted_content: "opaque" });
    expect(result.usage).toMatchObject({
      input: 200,
      cachedInput: 100,
      cacheWrite: 25,
      output: 30,
      reasoning: 10,
      total: 230,
      estimated: false,
    });
  });

  it("downgrades developer roles to system and retries when a gateway rejects them", async () => {
    const rejection = JSON.stringify({
      error: {
        param: null,
        type: "invalid_request_error",
        message:
          "Error from provider (Console Go): Upstream request failed: [invalid_parameter_error] developer is not one of ['system', 'assistant', 'user', 'tool', 'function']",
      },
    });
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      if (bodies.length === 1) return new Response(rejection, { status: 400 });
      return sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed", output: [], usage: {} } },
        "[DONE]",
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new ResponsesAdapter().stream(providerRequest(), () => undefined);
    expect(result.text).toBe("ok");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('"role":"developer"');
    expect(bodies[1]).not.toContain('"role":"developer"');
    expect(bodies[1]).toContain('"role":"system"');
  });

  it("accepts chat.completion.chunk events and bodies emitted under /responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { object: "chat.completion.chunk", choices: [{ delta: { content: "Relayed " } }] },
          {
            object: "chat.completion.chunk",
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: "call_7", function: { name: "read_page", arguments: "{}" } }],
                },
              },
            ],
          },
          "[DONE]",
        ]),
      ),
    );
    const result = await new ResponsesAdapter().stream(providerRequest(), () => undefined);
    expect(result.text).toBe("Relayed ");
    expect(result.toolCalls).toEqual([{ id: "call_7", name: "read_page", arguments: {} }]);
  });

  it("parses complete non-streaming Responses bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "completed",
              output: [{ type: "message", content: [{ type: "output_text", text: "Complete response" }] }],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            }),
          ),
      ),
    );
    const result = await new ResponsesAdapter().stream(providerRequest(), () => undefined);
    expect(result.text).toBe("Complete response");
    expect(result.usage.total).toBe(15);
  });

  it("preserves tool-call pairing when a Responses endpoint relays Chat output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    tool_calls: [
                      { id: "relayed", function: { name: "read_page", arguments: '{"tabId":1}' } },
                    ],
                  },
                },
              ],
            }),
          ),
      ),
    );
    const result = await new ResponsesAdapter().stream(providerRequest(), () => undefined);
    const request = providerRequest();
    request.steps = [{ ...result, toolResults: [{ callId: "relayed", output: "{}" }] }];
    const input = buildResponsesPayload(request, true).input as unknown[];
    expect(input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "relayed" }));
    expect(input).toContainEqual({ type: "function_call_output", call_id: "relayed", output: "{}" });
  });

  it("detects incomplete and failed Responses events", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([{ type: "response.incomplete", response: { status: "incomplete", output: [] } }]),
      )
      .mockResolvedValueOnce(
        sseResponse([{ type: "response.failed", response: { error: { message: "generation failed" } } }]),
      );
    vi.stubGlobal("fetch", fetchMock);
    expect((await new ResponsesAdapter().stream(providerRequest(), () => undefined)).incomplete).toBe(true);
    await expect(new ResponsesAdapter().stream(providerRequest(), () => undefined)).rejects.toThrow(
      "generation failed",
    );
  });

  it("uses non-strict schemas for optional tool arguments and respects the reserved output budget", () => {
    const request = providerRequest();
    request.policy.outputReserve = 512;
    const payload = buildResponsesPayload(request, true);
    expect(payload.max_output_tokens).toBe(512);
    expect((payload.tools as Array<{ strict: boolean }>).every((tool) => tool.strict === false)).toBe(true);
  });

  it("raises an explicit error when a stream carries an error event instead of content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([{ error: { message: "upstream exploded" } }])),
    );
    await expect(new ResponsesAdapter().stream(providerRequest(), () => undefined)).rejects.toThrow(
      /upstream exploded/u,
    );
  });

  it("uses the exact input-token endpoint when available", async () => {
    const fetchMock = vi.fn(async () => new Response('{"input_tokens":321}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await new ResponsesAdapter().countInput(providerRequest())).toBe(321);
    const call = (fetchMock.mock.calls as unknown[][])[0];
    expect(call?.[0]).toBe("https://provider.example/v1/responses/input_tokens");
    const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;
    expect(body.stream).toBeUndefined();
  });

  it("includes unresolved output items and tool results in compaction input", async () => {
    const fetchMock = vi.fn(async () => new Response('{"output":[{"type":"compaction"}]}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = providerRequest();
    const opaque = { type: "reasoning", id: "reasoning_1", encrypted_content: "opaque" };
    await new ResponsesAdapter().compact({
      settings: request.settings,
      messages: request.baseMessages,
      steps: [
        {
          text: "",
          toolCalls: [{ id: "call_1", name: "read_page", arguments: { tabId: 4, query: "article" } }],
          toolResults: [{ callId: "call_1", output: '{"title":"Article"}' }],
          rawResponseOutput: [opaque],
        },
      ],
      policy: request.policy,
      signal: request.signal,
    });
    const call = (fetchMock.mock.calls as unknown[][])[0];
    const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as { input: unknown[] };
    expect(body.input).toContainEqual(opaque);
    expect(body.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: '{"title":"Article"}',
    });
  });
});
