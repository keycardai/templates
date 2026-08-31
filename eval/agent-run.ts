/**
 * Eval flow for an outbound-auth agent template.
 *
 * The server flow in index.ts proves an inbound-auth server: a browser signs a
 * user in, and the server accepts that token and rejects its absence. None of
 * that shape fits an agent, which authenticates outward rather than inward, so
 * this flow replaces the two steps that assume a server (browser sign-in and
 * verifyServer) and keeps everything else:
 *
 * - Identity comes from impersonation, so the run is headless. See
 *   impersonate.ts.
 * - The resource the agent calls is a local stub, so no Google account is
 *   involved, and the stub verifies the credential it receives against the
 *   ephemeral zone's JWKS. See calendar-stub.ts.
 * - Verification asserts on what arrived at the stub. See verify-agent.ts.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { getOrCreateEvalZone, deleteZone } from "./zone.js";
import { cleanupStaleProvisonings } from "./provision.js";
import { provisionAgent, teardownAgentProvisioning, type ProvisionedAgent } from "./provision-agent.js";
import { runBuildAgent } from "./agent.js";
import { startCalendarStub, type CalendarStub } from "./calendar-stub.js";
import { impersonateUser, resolveZoneUserIdentifier } from "./impersonate.js";
import { verifyAgent } from "./verify-agent.js";

const execFileAsync = promisify(execFile);

const BUILD_NOTES = [
  "The calendar resource is a local stub, not Google, and it is already provisioned.",
  "Do not install any catalog package and do not create Keycard resources.",
  "Do not edit .env: KEYCARD_RESOURCE deliberately points at the local stub, and",
  "KEYCARD_SUBJECT_TOKEN is added by the harness after this step.",
  "Verify the graph imports (uv run python -c \"import calendar_agent.agent\") rather than importing main.",
].join("\n");

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var ${name} is not set`);
  return val;
}

export async function runAgentEval(opts: {
  templateDir: string;
  templateName: string;
  runId: string;
}): Promise<boolean> {
  const agentPort = Number(process.env.EVAL_AGENT_PORT ?? 2024);
  const stubPort = Number(process.env.EVAL_STUB_PORT ?? 8901);
  const agentUrl = `http://localhost:${agentPort}`;
  const impersonatedUser = required("EVAL_TEST_USER_EMAIL");
  const anthropicApiKey = required("ANTHROPIC_API_KEY");
  const anthropicModel = process.env.EVAL_AGENT_MODEL ?? "claude-sonnet-4-6";

  let zoneId: string | undefined;
  let ephemeral = false;
  let token: string | undefined;
  let provisioned: ProvisionedAgent | undefined;
  let stub: CalendarStub | undefined;
  let agentProcess: ReturnType<typeof spawn> | undefined;

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (agentProcess?.pid) {
      try { process.kill(-agentProcess.pid); } catch { /* already dead */ }
    }
    await stub?.close().catch(() => undefined);
    if (provisioned && !ephemeral && token) {
      await teardownAgentProvisioning(provisioned, token)
        .catch((e) => console.error("Resource cleanup failed:", e));
      console.log("   Cleaned up app + resources");
    }
    if (zoneId && ephemeral) {
      console.log(`\nCleaning up zone ${zoneId}...`);
      await deleteZone(zoneId).catch((e) => console.error("Zone cleanup failed:", e));
    }
    // The harness wrote a real client secret and a live user token into the
    // template working tree; do not leave them behind.
    await fs.rm(path.join(opts.templateDir, ".env"), { force: true }).catch(() => undefined);
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
        "The agent template needs the persistent eval zone: impersonation targets " +
          "EVAL_TEST_USER_EMAIL, which must already exist as a zone user, and a fresh " +
          "ephemeral zone has no users. Set EVAL_ZONE_ID and EVAL_ZONE_ISSUER_URL.",
      );
    }

    console.log("\n2. Starting local calendar stub...");
    await execFileAsync("bash", ["-c", `lsof -ti :${stubPort} :${agentPort} | xargs kill -9 2>/dev/null; true`]);
    stub = await startCalendarStub({
      port: stubPort,
      zoneIssuerUrl: evalZone.zone.issuerUrl,
      resourceIdentifier: `http://localhost:${stubPort}`,
    });
    console.log(`   Stub calendar: ${stub.url} (verifying against the zone JWKS)`);

    console.log("\n3. Provisioning resources...");
    await cleanupStaleProvisonings(evalZone.zone.id, token);
    provisioned = await provisionAgent({
      zoneId: evalZone.zone.id,
      zoneIssuerUrl: evalZone.zone.issuerUrl,
      runId: opts.runId,
      token,
      templateDir: opts.templateDir,
      calendarResourceIdentifier: stub.url,
      agentResourceIdentifier: agentUrl,
      anthropicApiKey,
      anthropicModel,
    });

    // The langgraph dependency tree takes minutes to resolve on a cold uv
    // cache, which starves the build agent's per-command timeout and turn
    // budget. Warm it deterministically first; the agent's own uv commands
    // then hit the cache and finish in seconds.
    console.log("\n4. Pre-warming the template's uv environment...");
    await execFileAsync("uv", ["sync"], {
      cwd: opts.templateDir,
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    console.log("   uv sync complete");

    console.log("\n5. Running agent (verify config + build)...");
    const build = await runBuildAgent({
      templateDir: opts.templateDir,
      zoneIssuerUrl: evalZone.zone.issuerUrl,
      resourceIdentifier: provisioned.resourceIdentifier,
      language: "python",
      notes: BUILD_NOTES,
    });
    console.log(build.output.split("\n").slice(-5).join("\n"));
    if (!build.success) throw new Error("Build failed: the agent could not build the template");
    console.log("   Build succeeded");

    // Sign the user in without a browser. signin.py would write this same
    // variable after an interactive flow; impersonation mints the equivalent
    // token directly, authorized by the application credential and the zone's
    // impersonation policy.
    console.log("\n6. Minting a user token by impersonation (no browser)...");
    const userIdentifier = await resolveZoneUserIdentifier(
      evalZone.zone.id,
      impersonatedUser,
      token,
    );
    const identity = await impersonateUser({
      zoneIssuerUrl: evalZone.zone.issuerUrl,
      clientId: provisioned.applicationClientId,
      clientSecret: provisioned.applicationClientSecret,
      userIdentifier,
      resource: provisioned.agentResourceIdentifier,
    });
    console.log(`   Subject: ${String(identity.claims.sub)} (aud ${JSON.stringify(identity.claims.aud)})`);
    await fs.appendFile(
      path.join(opts.templateDir, ".env"),
      `KEYCARD_SUBJECT_TOKEN=${identity.accessToken}\n`,
      "utf8",
    );

    console.log("\n7. Starting the agent server...");
    agentProcess = spawn(
      "uv",
      ["run", "langgraph", "dev", "--port", String(agentPort), "--no-browser"],
      {
        cwd: opts.templateDir,
        env: { ...process.env, PORT: String(agentPort) },
        detached: true,
      },
    );
    agentProcess.stderr?.on("data", (d: Buffer) => process.stderr.write(`[agent] ${d}`));
    agentProcess.stdout?.on("data", (d: Buffer) => process.stdout.write(`[agent] ${d}`));
    agentProcess.unref();

    let ready = false;
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        if ((await fetch(`${agentUrl}/ok`)).ok) { ready = true; break; }
      } catch { /* not yet */ }
    }
    if (!ready) throw new Error("langgraph dev did not become ready in time");
    console.log("   Agent ready");

    console.log("\n8. Verifying the agent...");
    const result = await verifyAgent({
      agentUrl,
      stub,
      resourceIdentifier: provisioned.resourceIdentifier,
      expectedSubject: String(identity.claims.sub),
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
