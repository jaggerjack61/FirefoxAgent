import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkedFetch,
  listProviderModels,
  parseSse,
  providerEndpoint,
  providerHeaders,
  providerOriginPattern,
  safeJson,
} from "./http";
import { providerRequest } from "@/test/providerFixture";

afterEach(() => vi.unstubAllGlobals());

describe("provider HTTP primitives", () => {
  it("allows HTTPS and loopback HTTP only", () => {
    const settings = providerRequest().settings;
    expect(providerEndpoint(settings, "/responses")).toBe("https://provider.example/v1/responses");
    expect(providerEndpoint({ ...settings, baseUrl: "http://localhost:9000/v1/" }, "models")).toBe(
      "http://localhost:9000/v1/models",
    );
    expect(() => providerEndpoint({ ...settings, baseUrl: "http://provider.example/v1" }, "models")).toThrow(
      "HTTPS",
    );
  });

  it("rejects credential-bearing or ambiguous base URLs and does not follow redirects", async () => {
    const settings = providerRequest().settings;
    for (const baseUrl of [
      "https://user:pass@example.test/v1",
      "https://example.test/v1?key=secret",
      "https://example.test/v1#hash",
    ]) {
      expect(() => providerEndpoint({ ...settings, baseUrl }, "models")).toThrow("base URL");
    }
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await checkedFetch("https://example.test/v1/models", { method: "GET" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "error", credentials: "omit", cache: "no-store" }),
    );
  });

  it("adds the bearer key only when configured", () => {
    expect(providerHeaders(providerRequest().settings).get("Authorization")).toBe("Bearer secret");
    expect(providerHeaders({ ...providerRequest().settings, apiKey: "" }).has("Authorization")).toBe(false);
  });

  it("builds permission patterns without provider ports or paths", () => {
    expect(providerOriginPattern("https://api.example.test/v1")).toBe("https://api.example.test/*");
    expect(providerOriginPattern("http://localhost:11434/v1")).toBe("http://localhost/*");
  });

  it("lists, normalizes, and sorts OpenAI-compatible models", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const settings = providerRequest().settings;
    await expect(listProviderModels(settings)).resolves.toEqual(["a-model", "z-model"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("parses split SSE events and safe JSON", async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: delta\ndata: {"a":'));
          controller.enqueue(encoder.encode("1}\n\ndata: [DONE]\n\n"));
          controller.close();
        },
      }),
    );
    const events: Array<[string, string | undefined]> = [];
    await parseSse(response, (data, name) => events.push([data, name]));
    expect(events).toEqual([
      ['{"a":1}', "delta"],
      ["[DONE]", undefined],
    ]);
    expect(safeJson('{"ok":true}')).toEqual({ ok: true });
    expect(safeJson("bad")).toEqual({});
  });
});
