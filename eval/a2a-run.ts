/**
 * Eval flow for an inbound-auth A2A agent template.
 *
 * The server flow in index.ts assumes an MCP server: it starts dist/server.js,
 * probes POST /mcp, and signs a user in through a browser. An A2A agent serves
 * /.well-known/agent-card.json and /a2a/jsonrpc instead, needs AGENT_BASE_URL
 * before it will boot, and is called by other agents rather than by a browser
 * session. So this flow keeps the shape (zone, provision, build agent, start,
 * verify) and swaps the pieces:
 *
 * - Provisioning registers the agent itself as a resource, so a token can be
 *   minted for it, plus a second resource as the audience negative control.
 *   See provision-a2a.ts.
 * - Identity comes from impersonation, so the run is headless. See
 *   impersonate.ts.
 * - Verification is inbound: discovery documents and the JSON-RPC auth gate.
 *   See verify-a2a.ts.
 *
 * Built to be shared by the two-agent delegation template (ECO-102).
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { getOrCreateEvalZone, deleteZone } from "./zone.js";
import { cleanupStaleProvisonings } from "./provision.js";
import { provisionA2AAgent, teardownA2AProvisioning, type ProvisionedA2AAgent } from "./provision-a2a.js";
import { runBuildAgent } from "./agent.js";
import { impersonateUser, resolveZoneUserIdentifier } from "./impersonate.js";
import { verifyA2AAgent } from "./verify-a2a.js";

const execFileAsync = promisify(execFile);

const BUILD_NOTES = [
  "Provisioning is complete and .env is final: do not verify it against the zone",
  "and do not change it. AGENT_BASE_URL deliberately points at localhost and",
  "SNOWFLAKE_* are deliberately unset: the agent boots in degraded mode by design.",
  "SPEC.md describes Snowflake, Tailscale Funnel, Fly.io, a public-key credential,",
  "and keycard CLI provisioning: those belong to a production deployment, not to",
  "this run, and none of them is your job. Do not run keycard CLI commands, do",
  "not call the zone or any HTTP endpoint, and do not start the agent.",
  "Your entire job is two commands: npm install, then npm run build. Then print",
  "the marker.",
].join("\n");

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var ${name} is not set`);
  return val;
}

export async function runA2AEval(opts: {
  templateDir: string;
  templateName: string;
  runId: string;
}): Promise<boolean> {
  const port = Number(process.env.EVAL_A2A_PORT ?? 9000);
  const agentUrl = `http://localhost:${port}`;
  const impersonatedUser = required("EVAL_TEST_USER_EMAIL");

  let zoneId: string | undefined;
  let ephemeral = false;
  let token: string | undefined;
  let provisioned: ProvisionedA2AAgent | undefined;
  let agentProcess: ReturnType<typeof spawn> | undefined;

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (agentProcess?.pid) {
      try { process.kill(-agentProcess.pid); } catch { /* already dead */ }
    }
    if (provisioned && !ephemeral && token) {
      await teardownA2AProvisioning(provisioned, token)
        .catch((e) => console.error("Resource cleanup failed:", e));
      console.log("   Cleaned up app + resources");
    }
    if (zoneId && ephemeral) {
      console.log(`\nCleaning up zone ${zoneId}...`);
      await deleteZone(zoneId).catch((e) => console.error("Zone cleanup failed:", e));
    }
    // The agent generated a keypair into the working tree; the .env points at
    // the eval zone. Leave neither behind.
    await fs.rm(path.join(opts.templateDir, ".env"), { force: true }).catch(() => undefined);
    await fs.rm(path.join(opts.templateDir, "agent_keys"), { recursive: true, force: true }).catch(() => undefined);
  };
  process.on("SIGINT", async () => { await cleanup(); process.exit(1); });

  let passed = false;
  try {
    console.log("1. Creating eval zone...");
    const evalZone = await getOrCreateEvalZone(opts.runId);
    token = evalZone.token;
    ephemeral = evalZone.ephemeral;
    zoneId = evalZone.zone.id;
    console.log(`   Zone: ${evalZone.zone.id} (${evalZone.zone.issuerUrl})`);
    if (ephemeral) {
      throw new Error(
        "The A2A template needs the persistent eval zone: impersonation targets " +
          "EVAL_TEST_USER_EMAIL, which must already exist as a zone user, and a fresh " +
          "ephemeral zone has no users. Set EVAL_ZONE_ID and EVAL_ZONE_ISSUER_URL.",
      );
    }

    console.log("\n2. Provisioning resources...");
    await execFileAsync("bash", ["-c", `lsof -ti :${port} | xargs kill -9 2>/dev/null; true`]);
    await cleanupStaleProvisonings(evalZone.zone.id, token);
    provisioned = await provisionA2AAgent({
      zoneId: evalZone.zone.id,
      zoneIssuerUrl: evalZone.zone.issuerUrl,
      runId: opts.runId,
      token,
      templateDir: opts.templateDir,
      agentBaseUrl: agentUrl,
      port,
    });

    console.log("\n3. Running agent (verify config + build)...");
    const buildOptions = {
      templateDir: opts.templateDir,
      zoneIssuerUrl: evalZone.zone.issuerUrl,
      resourceIdentifier: provisioned.agentResourceIdentifier,
      language: "typescript" as const,
      notes: BUILD_NOTES,
    };
    let build = await runBuildAgent(buildOptions);
    if (!build.success) {
      console.log("   First build attempt failed; retrying once...");
      build = await runBuildAgent(buildOptions);
    }
    console.log(build.output.split("\n").slice(-5).join("\n"));
    if (!build.success) {
      console.error("--- build agent output tail ---");
      console.error(build.output.split("\n").slice(-60).join("\n"));
      throw new Error("Build failed: the agent could not build the template");
    }
    console.log("   Build succeeded");

    console.log("\n4. Minting user tokens by impersonation (no browser)...");
    const userIdentifier = await resolveZoneUserIdentifier(evalZone.zone.id, impersonatedUser, token);
    const mint = (resource: string) => impersonateUser({
      zoneIssuerUrl: evalZone.zone.issuerUrl,
      clientId: provisioned!.applicationClientId,
      clientSecret: provisioned!.applicationClientSecret,
      userIdentifier,
      resource,
    });
    const identity = await mint(provisioned.agentResourceIdentifier);
    console.log(`   Agent token: sub ${String(identity.claims.sub)}, aud ${JSON.stringify(identity.claims.aud)}`);
    const foreign = await mint(provisioned.otherResourceIdentifier);
    console.log(`   Foreign token: aud ${JSON.stringify(foreign.claims.aud)}`);

    console.log("\n5. Starting the agent...");
    agentProcess = spawn("node", ["--env-file-if-exists=.env", "dist/index.js"], {
      cwd: opts.templateDir,
      env: { ...process.env, PORT: String(port) },
      detached: true,
    });
    agentProcess.stderr?.on("data", (d: Buffer) => process.stderr.write(`[agent] ${d}`));
    agentProcess.stdout?.on("data", (d: Buffer) => process.stdout.write(`[agent] ${d}`));
    agentProcess.unref();

    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        if ((await fetch(`${agentUrl}/.well-known/jwks.json`)).ok) { ready = true; break; }
      } catch { /* not yet */ }
    }
    if (!ready) throw new Error("The agent did not serve /.well-known/jwks.json in time");
    console.log("   Agent ready");

    console.log("\n6. Verifying the agent...");
    const result = await verifyA2AAgent({
      agentUrl,
      accessToken: identity.accessToken,
      foreignAccessToken: foreign.accessToken,
    });

    console.log("\n=== Results ===");
    for (const c of result.checks) {
      console.log(`  ${c.passed ? "\u2713" : "\u2717"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    }
    passed = result.passed;
  } catch (err) {
    console.error("\nEval failed:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  } finally {
    await cleanup();
  }
  return passed;
}
