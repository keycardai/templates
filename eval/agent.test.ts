import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runBuildAgent } from "./agent.js";
import { emptyBuildAgentUsage } from "./build-agent-usage.js";

test("build agent requests keep static cache breakpoints and move the message breakpoint", async (t) => {
  const templateDir = await mkdtemp(join(tmpdir(), "build-agent-test-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  await writeFile(join(templateDir, "SPEC.md"), "Fixture template spec");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "fixture-key";
  t.after(() => {
    if (apiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = apiKey;
  });

  const requests: Anthropic.MessageCreateParams[] = [];
  t.mock.method(globalThis, "fetch", async (_input: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const turn = requests.length;
    return Response.json({
      stop_reason: turn < 5 ? "tool_use" : "end_turn",
      content: turn < 5
        ? [0, 1].map((i) => ({ type: "tool_use", id: `tool_${turn}_${i}`, name: "bash", input: { command: "printf ok" } }))
        : [{ type: "text", text: "BUILD_COMPLETE:SUCCESS" }],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });

  const result = await runBuildAgent({
    templateDir,
    zoneIssuerUrl: "https://zone.example.test",
    resourceIdentifier: "https://resource.example.test",
    usage: emptyBuildAgentUsage(),
  });

  assert.equal(result.success, true);
  assert.equal(requests.length, 5);
  for (const [turn, { tools, system, messages }] of requests.entries()) {
    assert.ok(tools && Array.isArray(system));
    const controls = (blocks: object[]) => blocks.flatMap((block, index) =>
      "cache_control" in block ? [[index, block.cache_control]] : []);
    assert.deepEqual(controls(tools), [[tools.length - 1, { type: "ephemeral" }]]);
    assert.deepEqual(controls(system), [[0, { type: "ephemeral" }]]);
    assert.equal(messages.length, 1 + turn * 2);
    const messageControls = messages.flatMap(({ content }, index) =>
      Array.isArray(content) ? controls(content).map((control) => [index, ...control]) : []);
    assert.deepEqual(messageControls, [[messages.length - 1, turn === 0 ? 0 : 1, { type: "ephemeral" }]]);
    assert.ok(controls(tools).length + controls(system).length + messageControls.length <= 4);
  }
});
