import { CORE_INSTRUCTIONS, PROMPT_VERSION, TOOL_SCHEMA_VERSION } from "../src/context/compiler";
import { STABLE_TOOL_JSON, TOOL_DEFINITION_TOKENS } from "../src/tools/definitions";
import { contentHash, estimateTokens } from "../src/shared/token";

const stable = `${CORE_INSTRUCTIONS}\nTOOLS:${STABLE_TOOL_JSON}`;
console.log(
  JSON.stringify(
    {
      promptVersion: PROMPT_VERSION,
      toolSchemaVersion: TOOL_SCHEMA_VERSION,
      instructions: { hash: contentHash(CORE_INSTRUCTIONS), tokens: estimateTokens(CORE_INSTRUCTIONS) },
      tools: { hash: contentHash(STABLE_TOOL_JSON), tokens: TOOL_DEFINITION_TOKENS },
      stable: { hash: contentHash(stable), tokens: estimateTokens(stable) },
    },
    null,
    2,
  ),
);
