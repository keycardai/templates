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
import { runAgentEval } from "./agent-run.js";
import { runA2AEval } from "./a2a-run.js";

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
const RUN_ID = `${Date.now()}`;

// Harness constraints handed to the build agent for templates whose
// provisioning deliberately differs from SPEC.md. Without them the agent
// spends its turns "fixing" config that is correct as provisioned.
const BROKERED_NOTES = [
  "This eval provisions a zone-native resource backed by the zone provider, not the brokered external-provider setup SPEC.md describes.",
  "The provisioned .env and keycard.toml are correct as written. Do not restructure them toward the SPEC's brokered configuration.",
  "Verify the zone URL, client credentials, and resource identifier are present, then install and build.",
].join("\n");
// The Ruby SPEC tells the agent to provision through `keycard agent api` and
// to abort without a zone-bound keycard.toml, neither of which applies once
// the harness has provisioned.
const RUBY_NOTES = [
  "Provisioning is complete.",
  "Do not run keycard CLI commands and do not look for a parent keycard.toml.",
  "Install with bundle install, then confirm config.ru loads.",
].join("\n");
const AGENT_NOTES: Record<string, string> = {
  "mcp-brokered-credentials-python": BROKERED_NOTES,
  "mcp-brokered-credentials-typescript": BROKERED_NOTES,
  "mcp-server-ruby": RUBY_NOTES,
};

// Detect template language from the presence of its build manifest
const isPython = await fs.access(path.join(TEMPLATE_DIR, "pyproject.toml")).then(() => true).catch(() => false);
const isGo = await fs.access(path.join(TEMPLATE_DIR, "go.mod")).then(() => true).catch(() => false);
const isRuby = await fs.access(path.join(TEMPLATE_DIR, "Gemfile")).then(() => true).catch(() => false);
const language: "python" | "typescript" | "go" | "ruby" = isPython ? "python" : isGo ? "go" : isRuby ? "ruby" : "typescript";
console.log(`Language: ${language}`);

// How the server flow starts a template: a default per language, and an
// optional per-template override keyed by directory name, like AGENT_NOTES
// and eval-skip.txt. An override can replace the command, the port, and the
// health path; SERVER_URL, the stale-port cleanup, and the readiness probe
// all follow it.
interface ServerStart {
  command: [string, string[]];
  port: number;
  healthPath: string;
}
const DEFAULT_PORT = 8000;
const DEFAULT_HEALTH_PATH = "/healthz";
const SERVER_DEFAULTS: Record<typeof language, (port: number) => [string, string[]]> = {
  python: (port) => ["uv", ["run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", String(port)]],
  go: () => ["go", ["run", "."]],
  ruby: (port) => ["bundle", ["exec", "rackup", "--host", "0.0.0.0", "--port", String(port)]],
  typescript: () => ["node", ["--env-file-if-exists=.env", "dist/server.js"]],
};
// No template needs an override today; the map is here for the next one that does.
const SERVER_OVERRIDES: Record<string, Partial<ServerStart>> = {};
const override = SERVER_OVERRIDES[templateArg] ?? {};
const SERVER_PORT = override.port ?? DEFAULT_PORT;
const SERVER_START: ServerStart = {
  command: override.command ?? SERVER_DEFAULTS[language](SERVER_PORT),
  port: SERVER_PORT,
  healthPath: override.healthPath ?? DEFAULT_HEALTH_PATH,
};
const SERVER_URL = `http://localhost:${SERVER_START.port}`;

async function killStaleServer(): Promise<void> {
  await execFileAsync("bash", ["-c", `lsof -ti :${SERVER_START.port} | xargs kill -9 2>/dev/null; true`]);
}

// Agent templates are outbound-auth: langgraph serves the graph and the
// interesting assertion is on the call the agent makes, not on a request made
// to it. langgraph.json is what distinguishes them from the inbound-auth server
// templates the flow below handles.
const isAgent = await fs.access(path.join(TEMPLATE_DIR, "langgraph.json")).then(() => true).catch(() => false);
if (isAgent) {
  const agentPassed = await runAgentEval({ templateDir: TEMPLATE_DIR, templateName: templateArg, runId: RUN_ID });
  console.log(agentPassed ? "\n\u2713 PASS\n" : "\n\u2717 FAIL\n");
  process.exit(agentPassed ? 0 : 1);
}

// A2A agent templates are inbound-auth like the servers, but speak A2A: they
// serve /.well-known/agent-card.json and /a2a/jsonrpc through @keycardai/a2a
// rather than /mcp, so that dependency in package.json is what identifies them.
const isA2AAgent = await fs.readFile(path.join(TEMPLATE_DIR, "package.json"), "utf8")
  .then((raw) => {
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    return Boolean(pkg.dependencies?.["@keycardai/a2a"]);
  })
  .catch(() => false);
// A Python A2A template declares keycardai-a2a in pyproject.toml the same way.
const isPythonA2AAgent = await fs.readFile(path.join(TEMPLATE_DIR, "pyproject.toml"), "utf8")
  .then((raw) => /^\s*"keycardai-a2a[\s>=<~!\[]/m.test(raw))
  .catch(() => false);
if (isA2AAgent || isPythonA2AAgent) {
  const a2aPassed = await runA2AEval({
    templateDir: TEMPLATE_DIR,
    templateName: templateArg,
    runId: RUN_ID,
    language: isPythonA2AAgent ? "python" : "typescript",
  });
  console.log(a2aPassed ? "\n\u2713 PASS\n" : "\n\u2717 FAIL\n");
  process.exit(a2aPassed ? 0 : 1);
}

let zoneId: string | undefined;
let serverProcess: ReturnType<typeof execFile> | undefined;
let provisioned: Awaited<ReturnType<typeof provision>> | undefined;
let token: string | undefined;
let ephemeral = false;

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (serverProcess) {
    try { process.kill(-(serverProcess.pid!)); } catch { /* already dead */ }
  }
  if (provisioned && !ephemeral && token) {
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

// The whole flow runs inside try/finally so cleanup() always tears down what was
// provisioned, including an ephemeral zone, no matter where the run fails.
let passed = false;
try {
  // 1. Create eval zone
  console.log("1. Creating eval zone...");
  const evalZone = await getOrCreateEvalZone(RUN_ID);
  token = evalZone.token;
  ephemeral = evalZone.ephemeral;
  const zone = evalZone.zone;
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
    serverPort: SERVER_START.port,
  });

  // Kill any stale server before the agent's smoke tests run
  await killStaleServer();

  // 3. Agent: verify config + install + build
  console.log("\n3. Running agent (verify config + build)...");
  const agentResult = await runBuildAgent({
    templateDir: TEMPLATE_DIR,
    zoneIssuerUrl: zone.issuerUrl,
    resourceIdentifier: provisioned.resourceIdentifier,
    language,
    notes: AGENT_NOTES[templateArg],
  });

  console.log(agentResult.output.split("\n").slice(-5).join("\n"));

  if (!agentResult.success) {
    throw new Error("Build failed: the agent could not build the template");
  }
  console.log("   Build succeeded");

  // 4. Start server, killing any stale process on its port first
  console.log("\n4. Starting server...");
  await killStaleServer();
  await new Promise((r) => setTimeout(r, 500));

  const [serverCmd, serverArgs] = SERVER_START.command;

  // Inject service account credentials so brokered-credentials templates can start.
  // discoverApplicationCredential picks these up; templates that don't need them ignore them.
  // The node and python servers read the provisioned .env; the Go and Ruby servers have no
  // .env loader, so the provisioned config is passed through the process environment for parity.
  const serverEnv = {
    ...process.env,
    // The application credential minted for the provisioned app, so a broker template
    // authenticates its token exchange as the application that owns the resource (not the
    // CI service account, which the zone rejects as invalid_client for that exchange).
    KEYCARD_CLIENT_ID: provisioned.applicationClientId,
    KEYCARD_CLIENT_SECRET: provisioned.applicationClientSecret,
    KEYCARD_URL: zone.issuerUrl,
    KEYCARD_RESOURCE_ID: provisioned.resourceIdentifier,
    PORT: String(SERVER_START.port),
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
      const resp = await fetch(`${SERVER_URL}${SERVER_START.healthPath}`);
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
  passed = result.passed;
} catch (err) {
  console.error("\nEval failed:", err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  await cleanup();
}

console.log(passed ? "\n✓ PASS\n" : "\n✗ FAIL\n");
process.exit(passed ? 0 : 1);
