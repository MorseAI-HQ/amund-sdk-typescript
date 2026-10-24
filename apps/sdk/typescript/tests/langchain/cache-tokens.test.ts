/**
 * MHQ-1414 — LangChain-Anthropic prompt-cache tokens.
 *
 * `@langchain/anthropic` reports `usage_metadata.input_token_details` with
 * `cache_read` and `cache_creation`, both included in `input_tokens`. The
 * handler used to send `cache_read ?? cache_creation` as cached (read) tokens,
 * so a cache WRITE call was priced at the cache READ rate (~12x too cheap) and
 * the write tokens were never reported.
 */
import { describe, expect, it } from "vitest";

import { extractTokenUsage } from "../../src/langchain/callback-handler";

function result(details: Record<string, number>) {
  return {
    generations: [
      [
        {
          text: "ok",
          message: {
            usage_metadata: {
              input_tokens: 7714,
              output_tokens: 20,
              total_tokens: 7734,
              input_token_details: details,
            },
            response_metadata: { model_name: "claude-haiku-4-5-20251001" },
          },
        },
      ],
    ],
  };
}

describe("extractTokenUsage cache tokens (MHQ-1414)", () => {
  it("reports a cache write as cache-write tokens, not cached reads", () => {
    const usage = extractTokenUsage(result({ cache_creation: 7705, cache_read: 0 }) as never);
    expect(usage.inputTokens).toBe(7714);
    expect(usage.cacheWriteTokens).toBe(7705);
    expect(usage.cachedInputTokens ?? 0).toBe(0);
  });

  it("reports a cache read as cached tokens", () => {
    const usage = extractTokenUsage(result({ cache_read: 7705 }) as never);
    expect(usage.cachedInputTokens).toBe(7705);
    expect(usage.cacheWriteTokens).toBeUndefined();
  });

  it("reads the legacy llmOutput.usage shape", () => {
    const usage = extractTokenUsage({
      generations: [],
      llmOutput: {
        usage: {
          input_tokens: 9,
          output_tokens: 3,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 7705,
        },
      },
    } as never);
    expect(usage.cacheWriteTokens).toBe(7705);
  });
});
