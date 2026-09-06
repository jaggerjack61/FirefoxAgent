import { describe, expect, it } from "vitest";
import { agentEventSchema, makeTokenPolicy, providerSettingsSchema, uiCommandSchema } from "./schema";

describe("public schemas", () => {
  it("derives all token-policy limits from the configured context", () => {
    expect(makeTokenPolicy(32_000, 2_048)).toEqual({
      contextWindow: 32_000,
      outputReserve: 2_048,
      inputSoftLimit: 22_400,
      inputHardLimit: 26_752,
      runLimit: 128_000,
    });
    expect(makeTokenPolicy(1_000, 99_000).contextWindow).toBe(8_000);
  });

  it("validates versioned commands and monotonic-event fields", () => {
    const command = uiCommandSchema.parse({
      version: 1,
      requestId: "r",
      type: "send_message",
      text: "hello",
    });
    expect(command.type).toBe("send_message");
    if (command.type !== "send_message") throw new Error("Unexpected command variant");
    expect(command.text).toBe("hello");
    expect(() => uiCommandSchema.parse({ version: 2, requestId: "r", type: "get_state" })).toThrow();
    expect(
      agentEventSchema.parse({ version: 1, eventId: "e", sequence: 3, type: "stream_reset", payload: {} })
        .sequence,
    ).toBe(3);
  });

  it("requires explicit provider protocol and minimum context", () => {
    const base = {
      protocol: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "",
      model: "m",
      contextWindow: 8_000,
      maxOutputTokens: 2_048,
      capabilities: {},
    };
    const parsed = providerSettingsSchema.parse(base);
    expect(parsed.capabilities.exactCounting).toBe(false);
    expect(parsed.availableModels).toEqual([]);
    expect(() => providerSettingsSchema.parse({ ...base, contextWindow: 7_999 })).toThrow();
  });

  it("validates model discovery and new-chat commands", () => {
    expect(
      uiCommandSchema.parse({
        version: 1,
        requestId: "models",
        type: "list_provider_models",
        provider: { baseUrl: "https://provider.example/v1", apiKey: "secret" },
      }).type,
    ).toBe("list_provider_models");
    expect(
      uiCommandSchema.parse({
        version: 1,
        requestId: "model",
        type: "set_model",
        model: "gpt-4o",
      }).type,
    ).toBe("set_model");
    expect(uiCommandSchema.parse({ version: 1, requestId: "new", type: "new_chat" }).type).toBe("new_chat");
  });
});
