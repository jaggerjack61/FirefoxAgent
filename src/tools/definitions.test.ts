import { describe, expect, it } from "vitest";
import fixture from "@/test/fixtures/stable-budget.json";
import { CORE_INSTRUCTIONS, PROMPT_VERSION, TOOL_SCHEMA_VERSION } from "@/context/compiler";
import { TOKEN_LIMITS, contentHash, estimateTokens } from "@/shared/token";
import { STABLE_TOOL_JSON, TOOL_DEFINITIONS, TOOL_DEFINITION_TOKENS, parseToolInput } from "./definitions";

describe("stable prompt and tool surface", () => {
  it("keeps exactly 15 deterministic tools within budget", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(15);
    expect(new Set(TOOL_DEFINITIONS.map((tool) => tool.name)).size).toBe(15);
    expect(TOOL_DEFINITION_TOKENS).toBeLessThanOrEqual(TOKEN_LIMITS.toolDefinitions);
    expect(estimateTokens(CORE_INSTRUCTIONS)).toBeLessThanOrEqual(TOKEN_LIMITS.developerPrompt);
  });

  it("matches the reviewed byte-stable fixture and growth ceiling", () => {
    const stable = `${CORE_INSTRUCTIONS}\nTOOLS:${STABLE_TOOL_JSON}`;
    expect(PROMPT_VERSION).toBe(fixture.promptVersion);
    expect(TOOL_SCHEMA_VERSION).toBe(fixture.toolSchemaVersion);
    expect(contentHash(CORE_INSTRUCTIONS)).toBe(fixture.instructions.hash);
    expect(contentHash(STABLE_TOOL_JSON)).toBe(fixture.tools.hash);
    expect(contentHash(stable)).toBe(fixture.stable.hash);
    expect(TOOL_DEFINITION_TOKENS).toBeLessThanOrEqual(Math.floor(fixture.tools.tokens * 1.1));
    expect(estimateTokens(stable)).toBeLessThanOrEqual(Math.floor(fixture.stable.tokens * 1.1));
  });

  it("applies result and wait ceilings at validation time", () => {
    expect(parseToolInput("read_page", { tabId: 1, query: "price" }).maxTokens).toBe(900);
    expect(() => parseToolInput("read_page", { tabId: 1, query: "price", maxTokens: 2_001 })).toThrow();
    expect(() => parseToolInput("wait_for", { tabId: 1, condition: "ready", timeoutMs: 15_001 })).toThrow();
  });
});
