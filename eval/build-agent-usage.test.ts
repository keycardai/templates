import assert from "node:assert/strict";
import { test } from "node:test";
import { addBuildAgentUsage, emptyBuildAgentUsage, estimateBuildAgentCostUsd } from "./build-agent-usage.js";

test("build agent usage adds each response and prices the four token categories", () => {
  const total = emptyBuildAgentUsage();
  assert.equal(estimateBuildAgentCostUsd(total), 0);

  addBuildAgentUsage(total, {
    input_tokens: 1_000,
    output_tokens: 200,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: 3_000,
  });
  addBuildAgentUsage(total, {
    input_tokens: 300,
    output_tokens: 500,
    cache_read_input_tokens: 10_000,
  });
  addBuildAgentUsage(total, {
    input_tokens: 10,
    output_tokens: 10,
    cache_read_input_tokens: 250,
    cache_creation_input_tokens: 100,
  });

  assert.deepEqual(total, {
    input_tokens: 1_310,
    output_tokens: 710,
    cache_read_input_tokens: 10_250,
    cache_creation_input_tokens: 3_100,
  });
  assert.equal(estimateBuildAgentCostUsd(total), 0.02928);
});
