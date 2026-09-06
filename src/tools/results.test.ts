import { describe, expect, it } from "vitest";
import { estimateTokens } from "@/shared/token";
import { serializeToolResult } from "./results";

describe("structured tool results", () => {
  it("keeps small outputs intact", () => {
    expect(JSON.parse(serializeToolResult({ status: "succeeded" }, 120))).toEqual({ status: "succeeded" });
  });
  it.each(["tabs", "frames"])("bounds large %s lists without broken JSON", (key) => {
    const output = {
      [key]: Array.from({ length: 50 }, (_, index) => ({ id: index, title: "Title".repeat(20) })),
    };
    const result = serializeToolResult(output, 600);
    expect(estimateTokens(result)).toBeLessThanOrEqual(600);
    const parsed = JSON.parse(result);
    expect(parsed.omitted + parsed[key].length).toBe(50);
  });
  it("marks escaped previews as incomplete and keeps them in budget", () => {
    const result = serializeToolResult({ message: '"\\\n中文'.repeat(1000) }, 120);
    expect(JSON.parse(result).truncated).toBe(true);
    expect(estimateTokens(result)).toBeLessThanOrEqual(120);
  });
});
