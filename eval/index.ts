/**
 * Keycard template eval harness.
 *
 * Usage:
 *   npm run eval -- --template mcp-server-typescript-express
 *
 * Required in .env.eval (see .env.eval.example):
 *   CI_KEYCARD_CLIENT_ID, CI_KEYCARD_CLIENT_SECRET, CI_KEYCARD_ENDPOINT
 *   EVAL_TEST_USER_EMAIL, EVAL_TEST_USER_PASSWORD, ANTHROPIC_API_KEY
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getOrCreateEvalZone, deleteZone } from "./zone.js";
import { provision, cleanupStaleProvisonings, teardownProvisioning } from "./provision.js";
import { runBuildAgent } from "./agent.js";
import { authenticateViaOAuth } from "./browser.js";
import { verifyServer } from "./verify.js";

const execFileAsync = promisify(execFile);

try {
  const envContent = await fs.readFile(new URL(".env.eval", import.meta.url), "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
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

// Detect template language from the presence of package.json vs pyproject.toml
const isPython = await fs.access(path.join(TEMPLATE_DIR, "pyproject.toml")).then(() => true).catch(() => false);
const language: "python" | "typescript" = isPython ? "python" : "typescript";
console.log(`Language: ${language}`);

let zoneId: string | undefined;
let serverProcess: ReturnType<typeof execFile> | undefined;

let provisioned: Awaited<ReturnType<typeof provision>> | undefined;

async function cleanup() {
  if (serverProcess) {
    try { process.kill(-(serverProcess.pid!)); } catch { /* already dead */ }
  }
  if (provisioned && !ephemeral) {
    await teardownProvisioning(provisioned, token).catch((e) => console.error("Resource cleanup failed:", e));
    console.log("   Cleaned up app + resource");
  }
  if (zoneId && ephemeral) {
    console.log(`\nCleaning up zone ${zoneId}...`);
    await deleteZone(zoneId).catch((e) => console.error("Zone cleanup failed:", e));
  }
}

process.on("SIGINT", async () => { await cleanup(); process.exit(1); });

console.log(`\n=== Keycard Template Eval ===`);
console.log(`Template: ${templateArg}\nRun ID:   ${RUN_ID}\n`);

// 1. Create eval zone
console.log("1. Creating eval zone...");
const { zone, token, ephemeral } = await getOrCreateEvalZone(RUN_ID);
zoneId = zone.id;
console.log(`   Zone: ${zone.id} (${zone.issuerUrl})`);

// 2. Provision resources + write config files
console.log("\n2. Provisioning resources...");
await cleanupStaleProvisonings(zone.id, token);
provisioned = await provision({
  zoneId: zone.id,
  zoneIssuerUrl: zone.issuerUrl,
  runId: RUN_ID,
  token,
  templateDir: TEMPLATE_DIR,
});

// Kill any stale server on port 8000 before the agent's smoke tests run
await execFileAsync("bash", ["-c", "lsof -ti :8000 | xargs kill -9 2>/dev/null; true"]);

// 3. Agent: verify config + install + build
console.log("\n3. Running agent (verify config + build)...");
const agentResult = await runBuildAgent({
  templateDir: TEMPLATE_DIR,
  zoneIssuerUrl: zone.issuerUrl,
  resourceIdentifier: provisioned.resourceIdentifier,
  language,
});

console.log(agentResult.output.split("\n").slice(-5).join("\n"));

if (!agentResult.success) {
  console.error("   Build failed");
  await cleanup();
  process.exit(1);
}
console.log("   Build succeeded");

// 4. Start server — kill any stale process on port 8000 first
console.log("\n4. Starting server...");
await execFileAsync("bash", ["-c", "lsof -ti :8000 | xargs kill -9 2>/dev/null; true"]);
await new Promise((r) => setTimeout(r, 500));

const [serverCmd, serverArgs] = language === "python"
  ? ["uv", ["run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]]
  : ["node", ["--env-file-if-exists=.env", "dist/server.js"]];

// Inject service account credentials so brokered-credentials templates can start.
// discoverApplicationCredential picks these up; templates that don't need them ignore them.
const serverEnv = {
  ...process.env,
  KEYCARD_CLIENT_ID: process.env.CI_KEYCARD_CLIENT_ID ?? "",
  KEYCARD_CLIENT_SECRET: process.env.CI_KEYCARD_CLIENT_SECRET ?? "",
};

serverProcess = execFile(serverCmd, serverArgs, {
  cwd: TEMPLATE_DIR,
  env: serverEnv,
  detached: true,
});
serverProcess.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
serverProcess.stdout?.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));
serverProcess.unref();

// Wait for server ready
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const resp = await fetch(`${SERVER_URL}/healthz`);
    if (resp.ok) { console.log("   Server ready"); break; }
  } catch { /* not yet */ }
  if (i === 9) throw new Error("Server did not start in time");
}

// 5. Register user agent via DCR
console.log("\n5. Registering user agent via DCR...");
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

// 6. Browser OAuth
console.log("\n6. Running browser OAuth flow...");
const auth = await authenticateViaOAuth({
  zoneIssuerUrl: zone.issuerUrl,
  resourceIdentifier: provisioned.resourceIdentifier,
  clientId,
  testUserEmail: required("EVAL_TEST_USER_EMAIL"),
  testUserPassword: required("EVAL_TEST_USER_PASSWORD"),
  headless: process.env.EVAL_HEADLESS !== "false",
});
console.log("   OAuth complete");

// 7. Verify
console.log("\n7. Verifying server...");
const result = await verifyServer({ serverUrl: SERVER_URL, accessToken: auth.accessToken });

console.log("\n=== Results ===");
for (const c of result.checks) {
  console.log(`  ${c.passed ? "✓" : "✗"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
}

await cleanup();
console.log(result.passed ? "\n✓ PASS\n" : "\n✗ FAIL\n");
process.exit(result.passed ? 0 : 1);
