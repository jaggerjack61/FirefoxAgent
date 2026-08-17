import { describe, it, expect } from "vitest";
import { consumeSseStream, extractJson } from "./sse";

describe("extractJson", () => {
  it("parses raw JSON", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it("parses fenced JSON", () => {
    expect(extractJson('```json\n{"a": 2}\n```')).toEqual({ a: 2 });
  });

  it("extracts the first JSON object from prose", () => {
    expect(extractJson('prefix {"a": 3} suffix')).toEqual({ a: 3 });
  });

  it("throws for invalid input", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("consumeSseStream", () => {
  function sseResponse(lines: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(lines.join("\n")));
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }

  it("parses data lines and stops at [DONE]", async () => {
    const events: string[] = [];
    await consumeSseStream(
      sseResponse([
        'data: {"a":1}',
        "",
        'data: {"a":2}',
        "",
        "data: [DONE]",
        "",
        'data: {"ignored": true}',
        "",
      ]),
      (d) => events.push(d),
    );
    expect(events).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("handles multi-line payloads", async () => {
    const events: string[] = [];
    await consumeSseStream(
      sseResponse(['data: {"lines":', 'data:  [1,2]}', ""]),
      (d) => events.push(d),
    );
    expect(events).toEqual(['{"lines":', '[1,2]}']);
  });
});
