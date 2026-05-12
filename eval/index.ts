/**
 * Keycard template eval harness.
 *
 * Usage:
 *   npm run eval -- --template mcp-server-typescript-express
 *
 * Required env vars (put in eval/.env.eval, see .env.eval.example):
 *   CI_KEYCARD_CLIENT_ID, CI_KEYCARD_CLIENT_SECRET, CI_KEYCARD_ENDPOINT
 *   EVAL_TEST_USER_EMAIL, EVAL_TEST_USER_PASSWORD, ANTHROPIC_API_KEY
 *
 * One-time setup:
 *   1. Copy .env.eval.example to .env.eval and fill in values
 *   2. Run once with EVAL_HEADLESS=false to create and verify the test user account
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createEvalZone, deleteZone } from "./zone.js";
import { runSpecAgent } from "./agent.js";
import { authenticateViaOAuth } from "./browser.js";
import { verifyServer } from "./verify.js";

try {
  const envContent = await fs.readFile(new URL(".env.eval", import.meta.url), "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1).replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = val;
  }
} catch { /* .env.eval optional */ }

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var ${name} is not set`);
  return val;
}

const args = process.argv.slice(2);
const templateIdx = args.indexOf("--template");
const templateArg = templateIdx >= 0 ? args[templateIdx + 1] : undefined;
if (!templateArg) {
  console.error("Usage: npm run eval -- --template <template-name>");
  process.exit(1);
}

const TEMPLATE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", templateArg);
const SERVER_URL = "http://localhost:8000";
const RUN_ID = `${Date.now()}`;

let zoneId: string | undefined;

async function cleanup() {
  if (zoneId) {
    console.log(`\nCleaning up zone ${zoneId}...`);
    await deleteZone(zoneId).catch((e) => console.error("Zone cleanup failed:", e));
  }
}

process.on("SIGINT", async () => { await cleanup(); process.exit(1); });

console.log(`\n=== Keycard Template Eval ===`);
console.log(`Template: ${templateArg}\nRun ID:   ${RUN_ID}\n`);

// 1. Create eval zone
console.log("1. Creating eval zone...");
const { zone, token } = await createEvalZone(RUN_ID);
zoneId = zone.id;
console.log(`   Zone: ${zone.id} (${zone.issuerUrl})`);

// 2. Run Claude agent against SPEC.md
console.log("\n2. Running agent against SPEC.md...");
const agentResult = await runSpecAgent({
  templateDir: TEMPLATE_DIR,
  zoneId: zone.id,
  zoneIssuerUrl: zone.issuerUrl,
  managementToken: token,
  endpoint: required("CI_KEYCARD_ENDPOINT"),
});

if (!agentResult.success) {
  console.error("   Agent failed:\n", agentResult.output);
  await cleanup();
  process.exit(1);
}
console.log("   Agent completed SPEC successfully");

// 3. Register user agent via DCR to get client_id for OAuth flow
console.log("\n3. Registering user agent via DCR...");
const dcrResp = await fetch(`${zone.issuerUrl}/oauth/2/registration`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: `eval-ua-${RUN_ID}`,
    redirect_uris: ["http://localhost:8888/callback"],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});
if (!dcrResp.ok) throw new Error(`DCR failed: ${dcrResp.status} ${await dcrResp.text()}`);
const { client_id: clientId } = await dcrResp.json() as { client_id: string };
console.log(`   Client ID: ${clientId}`);

// 4. Browser OAuth flow
console.log("\n4. Running browser OAuth flow...");
const auth = await authenticateViaOAuth({
  zoneIssuerUrl: zone.issuerUrl,
  resourceIdentifier: `${SERVER_URL}/mcp`,
  clientId,
  testUserEmail: required("EVAL_TEST_USER_EMAIL"),
  testUserPassword: required("EVAL_TEST_USER_PASSWORD"),
  headless: process.env.EVAL_HEADLESS !== "false",
});
console.log("   OAuth complete");

// 5. Verify server
console.log("\n5. Verifying server...");
const result = await verifyServer({ serverUrl: SERVER_URL, accessToken: auth.accessToken });

console.log("\n=== Results ===");
for (const c of result.checks) {
  console.log(`  ${c.passed ? "✓" : "✗"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
}

await cleanup();
console.log(result.passed ? "\n✓ PASS\n" : "\n✗ FAIL\n");
process.exit(result.passed ? 0 : 1);
