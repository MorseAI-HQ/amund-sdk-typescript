/**
 * LLM model pricing table and cost calculation.
 *
 * Mirrors `apps/sdk/python/src/morse_ai/pricing.py` field-for-field —
 * the bundled `data/pricing.json` table is a byte-for-byte copy of the
 * Python SDK's table. Keep both sides in lockstep.
 */

import pricingTable from "../data/pricing.json";

export interface ModelPricing {
  input_per_mtok: number;
  output_per_mtok: number;
  cached_per_mtok?: number;
  cache_write_per_mtok?: number;
}

type PricingTable = Record<string, ModelPricing>;

const PRICING = pricingTable as PricingTable;

// Region/vendor prefixes stripped from routed model ids (LiteLLM/OpenRouter/Bedrock).
const REGION_PREFIXES = ["us.", "eu.", "apac.", "global."] as const;
const VENDOR_PREFIXES = [
  "anthropic.",
  "meta.",
  "mistral.",
  "cohere.",
  "amazon.",
  "ai21.",
  "deepseek.",
  "openai.",
  "google.",
  "qwen.",
] as const;

/**
 * Canonical-key candidates for a (possibly provider-prefixed) model id.
 *
 * Mirrors the server cost_engine normalizer: handles "openai/gpt-4o",
 * "openrouter/openai/gpt-4o", "vertex_ai/gemini-2.5-pro", and Bedrock
 * "us.anthropic.claude-3-5-sonnet-20241022-v2:0". Most-specific first.
 */
function normalizeCandidates(model: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const add = (x: string): void => {
    if (x && !seen.has(x)) {
      seen.add(x);
      candidates.push(x);
    }
  };

  add(model);
  if (model.includes("/")) {
    const parts = model.split("/");
    for (let i = 1; i < parts.length; i++) {
      add(parts.slice(i).join("/"));
    }
  }

  let base = candidates[candidates.length - 1] ?? model;
  for (const region of REGION_PREFIXES) {
    if (base.startsWith(region)) {
      base = base.slice(region.length);
      add(base);
      break;
    }
  }
  for (const vendor of VENDOR_PREFIXES) {
    if (base.startsWith(vendor)) {
      base = base.slice(vendor.length);
      add(base);
      break;
    }
  }
  if (base.includes(":")) {
    add(base.split(":", 1)[0] as string);
  }

  return candidates;
}

const TIER_WORDS = new Set([
  "mini",
  "nano",
  "micro",
  "lite",
  "pro",
  "max",
  "turbo",
  "flash",
  "plus",
  "ultra",
  "large",
  "small",
]);

// A prefix stands in for a dated/versioned/aliased ID ("-20260205", "-latest",
// "-v1:0"), never for a different size tier: "gpt-5-nano" must not be billed
// as "gpt-5" (25x over, MHQ-1264). Unpriced beats wrongly priced.
function isVersionSuffix(rest: string): boolean {
  if (rest === "") return true;
  const word =
    rest
      .replace(/^[-@:._/]+/, "")
      .split("-", 1)[0]
      ?.toLowerCase() ?? "";
  return !TIER_WORDS.has(word);
}

function matchOne(table: PricingTable, model: string): ModelPricing | undefined {
  // Exact match
  if (Object.prototype.hasOwnProperty.call(table, model)) {
    return table[model];
  }
  // Prefix match: "claude-opus-4-6-20260205" matches "claude-opus-4-6"
  let bestKey: string | undefined;
  for (const key of Object.keys(table)) {
    if (
      model.startsWith(key) &&
      isVersionSuffix(model.slice(key.length)) &&
      (bestKey === undefined || key.length > bestKey.length)
    ) {
      bestKey = key;
    }
  }
  if (bestKey !== undefined) {
    return table[bestKey];
  }
  // Reverse: alias "claude-opus-4-6" matches "claude-opus-4-6-20260205"
  for (const key of Object.keys(table)) {
    if (key.startsWith(model)) {
      return table[key];
    }
  }
  return undefined;
}

/**
 * Look up pricing for a model ID.
 *
 * Handles full IDs (claude-opus-4-6-20260205), aliases (claude-opus-4-6), and
 * provider-routed ids from LangGraph/LiteLLM/OpenRouter/Bedrock/Vertex
 * (e.g. "openai/gpt-4o", "us.anthropic.claude-3-5-sonnet-20241022-v2:0") via
 * exact, longest-prefix, and provider-prefix normalization.
 */
export function getModelPricing(model: string): ModelPricing | undefined {
  for (const candidate of normalizeCandidates(model)) {
    const hit = matchOne(PRICING, candidate);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export interface CalculateCostOptions {
  inputTokens: number;
  outputTokens: number;
  model: string;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Calculate total cost in USD for a model invocation.
 *
 * Returns `undefined` if the model is not in the pricing table.
 */
export function calculateCost(options: CalculateCostOptions): number | undefined {
  const { inputTokens, outputTokens, model, cachedInputTokens = 0, cacheWriteTokens = 0 } = options;

  const pricing = getModelPricing(model);
  if (pricing === undefined) return undefined;

  const inputPerMtok = pricing.input_per_mtok ?? 0;
  const outputPerMtok = pricing.output_per_mtok ?? 0;
  const cachedPerMtok = pricing.cached_per_mtok ?? inputPerMtok;
  const cacheWritePerMtok = pricing.cache_write_per_mtok ?? 0;

  const standardInput = Math.max(0, inputTokens - cachedInputTokens);
  const inputCost = (standardInput / 1_000_000) * inputPerMtok;
  const cachedCost = (cachedInputTokens / 1_000_000) * cachedPerMtok;
  const writeCost = (cacheWriteTokens / 1_000_000) * cacheWritePerMtok;
  const outputCost = (outputTokens / 1_000_000) * outputPerMtok;

  return inputCost + cachedCost + writeCost + outputCost;
}
