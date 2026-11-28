export const BUILD_AGENT_MODEL = "claude-sonnet-4-6";

// Anthropic standard API pricing: https://platform.claude.com/docs/en/about-claude/pricing
// The build agent does not request a custom cache TTL. Use the default 5-minute write rate.
const CLAUDE_SONNET_4_6_PRICE_USD_PER_MILLION_TOKENS = {
  input: 3,
  output: 15,
  cacheRead: 0.30,
  cacheWrite: 3.75,
} as const;

export interface BuildAgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

type ResponseUsage = Pick<BuildAgentUsage, "input_tokens" | "output_tokens"> & {
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export function emptyBuildAgentUsage(): BuildAgentUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

export function addBuildAgentUsage(total: BuildAgentUsage, usage: ResponseUsage): void {
  total.input_tokens += usage.input_tokens;
  total.output_tokens += usage.output_tokens;
  total.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
  total.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
}

export function estimateBuildAgentCostUsd(usage: BuildAgentUsage): number {
  const prices = CLAUDE_SONNET_4_6_PRICE_USD_PER_MILLION_TOKENS;
  return (
    usage.input_tokens * prices.input +
    usage.output_tokens * prices.output +
    usage.cache_read_input_tokens * prices.cacheRead +
    usage.cache_creation_input_tokens * prices.cacheWrite
  ) / 1_000_000;
}

export function formatBuildAgentUsage(usage: BuildAgentUsage): string {
  const estimatedCost = estimateBuildAgentCostUsd(usage).toFixed(6);
  return `Input tokens: ${usage.input_tokens} | Output tokens: ${usage.output_tokens} | ` +
    `Cache read tokens: ${usage.cache_read_input_tokens} | Cache write tokens: ${usage.cache_creation_input_tokens} | ` +
    `Estimated cost: $${estimatedCost} USD`;
}
