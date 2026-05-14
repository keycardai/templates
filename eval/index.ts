/**
 * Keycard template eval harness.
 *
 * Usage:
 *   npm run eval -- --template mcp-server-typescript-express
 *   npm run eval -- --template mcp-brokered-credentials-python
 *
 * Required in .env.eval (see .env.eval.example):
 *   CI_KEYCARD_CLIENT_ID, CI_KEYCARD_CLIENT_SECRET, CI_KEYCARD_ENDPOINT
 *   EVAL_ORG_ID
 *   EVAL_TEST_USER_EMAIL, EVAL_TEST_USER_PASSWORD, ANTHROPIC_API_KEY
 *
 * Two eval modes are selected automatically based on template structure:
 *   Basic (express, python-mcp): harness pre-provisions resources, agent verifies config + builds.
 *   Brokered (brokered-credentials-*): agent provisions ALL primitives from SPEC.md end-to-end,
 *     mirroring the keycard-template-app skill flow documented at
 *     https://docs.keycard.ai/guides/access-apis-on-behalf-of-users.md
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getOrCreateEvalZone, deleteZone } from "./zone.js";
import { provision, cleanupStaleProvisonings, teardownProvisioning } from "./provision.js";
import { runBuildAgent, runProvisioningAgent } from "./agent.js";
import { authenticateViaOAuth } from "./browser.js";
import { verifyServer, verifyBrokeredTools } from "./verify.js";

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

// Detect template language
const isPython = await fs.access(path.join(TEMPLATE_DIR, "pyproject.toml")).then(() => true).catch(() => false);
const language: "python" | "typescript" = isPython ? "python" : "typescript";

// Detect brokered-credentials template: they ship provision-credentials.sh which
// the agent runs as part of full SPEC.md provisioning (basic templates don't have it).
const isBrokered = await fs.access(path.join(TEMPLATE_DIR, "scripts", "provision-credentials.sh")).then(() => true).catch(() => false);

console.log(`\n=== Keycard Template Eval ===`);
console.log(`Template: ${templateArg}`);
console.log(`Language: ${language}`);
console.log(`Mode:     ${isBrokered ? "brokered (agent provisions from SPEC.md)" : "basic (harness pre-provisions)"}`);
console.log(`Run ID:   ${RUN_ID}\n`);

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

// 1. Create / reuse eval zone
console.log("1. Resolving eval zone...");
const { zone, token, ephemeral } = await getOrCreateEvalZone(RUN_ID);
zoneId = zone.id;
console.log(`   Zone: ${zone.id} (${zone.issuerUrl})`);

// 2. Provision / configure
await execFileAsync("bash", ["-c", "lsof -ti :8000 | xargs kill -9 2>/dev/null; true"]);

let evalCredsFile: string | undefined;

if (isBrokered) {
  console.log("\n2. Running provisioning agent (full SPEC.md flow)...");
  const orgId = required("EVAL_ORG_ID");
  const endpoint = required("CI_KEYCARD_ENDPOINT");
  const clientId = required("CI_KEYCARD_CLIENT_ID");
  const clientSecret = required("CI_KEYCARD_CLIENT_SECRET");

  // Delete stale vault resources from previous runs so provision-credentials.sh
  // always issues fresh credentials (the password field is unretrievable after creation).
  const templateName = path.basename(TEMPLATE_DIR);
  const staleUrns = [
    `urn:${templateName}:client_id`,
    `urn:${templateName}:client_secret`,
  ];
  try {
    const tokenResp = await fetch(`${endpoint}/service-account-token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    });
    const { access_token: cleanupToken } = await tokenResp.json() as { access_token: string };
    const resResp = await fetch(`${endpoint}/zones/${zone.id}/resources`, {
      headers: { Authorization: `Bearer ${cleanupToken}` },
    });
    const { items } = await resResp.json() as { items: Array<{ id: string; identifier: string }> };
    for (const item of items.filter((r) => staleUrns.includes(r.identifier))) {
      await fetch(`${endpoint}/zones/${zone.id}/resources/${item.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cleanupToken}` },
      });
      console.log(`   Deleted stale vault resource: ${item.identifier}`);
    }
  } catch (e) {
    console.warn(`   Warning: stale vault resource cleanup failed: ${e}`);
  }

  const agentResult = await runProvisioningAgent({
    templateDir: TEMPLATE_DIR,
    zoneId: zone.id,
    zoneIssuerUrl: zone.issuerUrl,
    orgId,
    language,
    keycardEndpoint: required("CI_KEYCARD_ENDPOINT"),
    keycardClientId: required("CI_KEYCARD_CLIENT_ID"),
    keycardClientSecret: required("CI_KEYCARD_CLIENT_SECRET"),
  });

  evalCredsFile = agentResult.evalCredsFile;

  if (!agentResult.success) {
    console.error("\n   Provisioning agent failed");
    await cleanup();
    process.exit(1);
  }
  console.log("\n   Provisioning complete");
} else {
  // Harness pre-provisions basic app + resource, agent verifies config + builds
  console.log("\n2. Provisioning resources...");
  await cleanupStaleProvisonings(zone.id, token);
  provisioned = await provision({
    zoneId: zone.id,
    zoneIssuerUrl: zone.issuerUrl,
    runId: RUN_ID,
    token,
    templateDir: TEMPLATE_DIR,
  });

  console.log("\n3. Running build agent (verify config + build)...");
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
}

// 3. Start server
console.log("\n3. Starting server...");
await execFileAsync("bash", ["-c", "lsof -ti :8000 | xargs kill -9 2>/dev/null; true"]);
await new Promise((r) => setTimeout(r, 500));

const serverCmd = language === "python" ? "uv" : "node";
const serverArgs = language === "python"
  ? ["run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
  : ["--env-file-if-exists=.env", "dist/server.js"];

// For brokered templates, provision-credentials.sh wrote the proxy application's
// client_id/secret to evalCredsFile. Inject those directly — we can't use a nested
// `keycard run` since we're already inside one.
let proxyCreds: { client_id: string; client_secret: string } | undefined;
if (evalCredsFile) {
  try {
    proxyCreds = JSON.parse(await fs.readFile(evalCredsFile, "utf8"));
    await fs.unlink(evalCredsFile).catch(() => {});
    console.log("   Loaded proxy credentials from provisioning step");
  } catch {
    console.warn("   Warning: could not read proxy creds file, falling back to service account");
  }
}

const serverEnv = {
  ...process.env,
  KEYCARD_CLIENT_ID: proxyCreds?.client_id ?? process.env.CI_KEYCARD_CLIENT_ID ?? "",
  KEYCARD_CLIENT_SECRET: proxyCreds?.client_secret ?? process.env.CI_KEYCARD_CLIENT_SECRET ?? "",
};

serverProcess = execFile(serverCmd, serverArgs, {
  cwd: TEMPLATE_DIR,
  env: serverEnv,
  detached: true,
});
serverProcess.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
serverProcess.stdout?.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));
serverProcess.unref();

for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const resp = await fetch(`${SERVER_URL}/healthz`);
    if (resp.ok) { console.log("   Server ready"); break; }
  } catch { /* not yet */ }
  if (i === 14) throw new Error("Server did not start in time");
}

// 4. DCR: register a public client for the browser OAuth flow
console.log("\n4. Registering user agent via DCR...");
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

// Determine the resource identifier for the browser OAuth request.
// Basic templates: use what provision.ts set. Brokered: read from .env.
const resourceIdentifier = provisioned?.resourceIdentifier ?? (() => {
  const envRaw = fs.readFile(path.join(TEMPLATE_DIR, ".env"), "utf8").then((c) => {
    const match = c.match(/^KEYCARD_RESOURCE_ID=(.+)$/m);
    return match?.[1] ?? `http://localhost:8000/mcp`;
  }).catch(() => `http://localhost:8000/mcp`);
  return envRaw;
})();

const resolvedResourceIdentifier = typeof resourceIdentifier === "string"
  ? resourceIdentifier
  : await resourceIdentifier;

// 5. Browser OAuth flow (includes Linear consent for brokered templates)
console.log("\n5. Running browser OAuth flow...");
const auth = await authenticateViaOAuth({
  zoneIssuerUrl: zone.issuerUrl,
  resourceIdentifier: resolvedResourceIdentifier,
  clientId,
  testUserEmail: required("EVAL_TEST_USER_EMAIL"),
  testUserPassword: required("EVAL_TEST_USER_PASSWORD"),
  headless: process.env.EVAL_HEADLESS !== "false",
});
console.log("   OAuth complete");

// 6. Verify
console.log("\n6. Verifying server...");
const verifyOpts = { serverUrl: SERVER_URL, accessToken: auth.accessToken };
const result = isBrokered
  ? await verifyBrokeredTools(verifyOpts)
  : await verifyServer(verifyOpts);

console.log("\n=== Results ===");
for (const c of result.checks) {
  console.log(`  ${c.passed ? "✓" : "✗"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
}

await cleanup();
console.log(result.passed ? "\n✓ PASS\n" : "\n✗ FAIL\n");
process.exit(result.passed ? 0 : 1);
