import { spawn } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runBuildAgent } from "./agent.js";
import type { BuildAgentUsage } from "./build-agent-usage.js";
import { startCalendarStub, type CalendarStub } from "./calendar-stub.js";
import { impersonateUser, resolveZoneUserIdentifier } from "./impersonate.js";
import { writeKeycardToml } from "./keycard-toml.js";
import { cloudflareProvisioning } from "./provision-cloudflare.js";
import { cleanupStaleProvisonings } from "./provision.js";
import { stopProcessGroup } from "./stop.js";
import {
  matchesPublicKey, readQuickTunnelUrl, redactProcessOutput, verifyClientAssertion, verifyWorker, type Check, type WorkerEnv,
} from "./verify-cloudflare.js";
import { deleteZone, getOrCreateEvalZone } from "./zone.js";

async function waitFor<T>(label: string, probe: () => Promise<T | undefined>, signal: AbortSignal): Promise<T> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await probe();
    if (result !== undefined) return result;
    await delay(1000, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function start(command: string, args: string[], cwd: string) {
  let failure: string | undefined;
  let output = "";
  let truncated = false;
  const child = spawn(command, args, {
    cwd,
    detached: true,
    // Do not pass management, test-user, or build-agent secrets to either process.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", (err: NodeJS.ErrnoException) => { failure = err.code ?? "spawn failed"; });
  const capture = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 8_192) {
      truncated = true;
      output = output.slice(-8_192);
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return {
    child,
    output() { return output; },
    reportTail(label: string) {
      const firstLineEnd = truncated ? output.indexOf("\n") : -1;
      const tail = truncated && firstLineEnd < 0 ? "" : output.slice(firstLineEnd + 1);
      const safeTail = redactProcessOutput(tail).trim();
      if (safeTail) {
        console.error(`${label} output (redacted tail):\n${safeTail.split(/\r?\n/).map((line) => `  | ${line}`).join("\n")}`);
      }
    },
    checkRunning(label: string) {
      if (failure || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`${label} stopped (${failure ?? child.signalCode ?? child.exitCode})`);
      }
    },
  };
}

function readPort(name: string, fallback: number): number {
  const port = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid ${name}`);
  return port;
}

export async function runCloudflareEval(opts: {
  templateDir: string;
  wranglerConfig: string;
  runId: string;
  usage: BuildAgentUsage;
  notes: string;
}): Promise<boolean> {
  const { templateDir, runId } = opts;
  const checks: Check[] = [];
  const abort = new AbortController();
  let provisioning: ReturnType<typeof cloudflareProvisioning> | undefined;
  let ephemeralZoneId: string | undefined;
  let wrangler: ReturnType<typeof start> | undefined;
  let tunnel: ReturnType<typeof start> | undefined;
  let stub: CalendarStub | undefined;
  const varsPath = join(templateDir, ".dev.vars");
  const tomlPath = join(templateDir, "keycard.toml");
  let varsCreated = false;
  let originalToml: string | undefined;
  let completed = false;
  let pendingSetup: Promise<unknown> | undefined;
  let cleanupPromise: Promise<boolean> | undefined;

  function trackSetup<T>(operation: Promise<T>): Promise<T> {
    pendingSetup = operation;
    return operation;
  }

  function cleanup(): Promise<boolean> {
    return cleanupPromise ??= (async () => {
      // Include anything created by a setup operation already in progress.
      await pendingSetup?.catch(() => undefined);
      const results = await Promise.allSettled([
        stopProcessGroup(tunnel?.child),
        stopProcessGroup(wrangler?.child),
        provisioning?.cleanup(),
        ephemeralZoneId ? deleteZone(ephemeralZoneId) : undefined,
        varsCreated ? fs.rm(varsPath, { force: true }) : undefined,
        originalToml !== undefined ? fs.writeFile(tomlPath, originalToml) : undefined,
      ]);
      results.push(...await Promise.allSettled([stub?.close()]));
      return results.every((result) => result.status === "fulfilled" && result.value !== false);
    })();
  }

  function interrupt() {
    if (abort.signal.aborted) return;
    abort.abort(new Error("Cloudflare eval interrupted"));
    console.error("Cloudflare eval interrupted; cleaning up");
    void cleanup().then((clean) => {
      if (!clean) console.error("Cloudflare eval cleanup failed");
      process.exit(1);
    });
  }
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  try {
    const email = process.env.EVAL_TEST_USER_EMAIL;
    if (!email) throw new Error("EVAL_TEST_USER_EMAIL is required for Cloudflare eval");
    const port = readPort("EVAL_WORKER_PORT", 8787);
    const stubPort = readPort("EVAL_STUB_PORT", 8901);
    const base = `http://127.0.0.1:${port}`;
    const workerResource = `${base}/call`;
    const downstreamResource = `http://127.0.0.1:${stubPort}/calendars/primary/events`;
    const clientId = `eval-cf-${runId}`;
    console.log("1. Selecting the eval zone and removing stale runs...");
    const { zone, token, ephemeral } = await trackSetup(getOrCreateEvalZone(runId).then((result) => {
      if (result.ephemeral) ephemeralZoneId = result.zone.id;
      return result;
    }));
    abort.signal.throwIfAborted();
    if (ephemeral) {
      throw new Error("Cloudflare eval needs the persistent eval zone and an existing test user");
    }
    await cleanupStaleProvisonings(zone.id, token);
    const userIdentifier = await resolveZoneUserIdentifier(zone.id, email, token);
    abort.signal.throwIfAborted();

    console.log("2. Provisioning the application and resources...");
    provisioning = cloudflareProvisioning(zone.id, token);
    const app = await trackSetup(provisioning.provision({ runId, workerResource, downstreamResource }));
    abort.signal.throwIfAborted();
    originalToml = await fs.readFile(tomlPath, "utf8");
    abort.signal.throwIfAborted();
    await trackSetup(writeKeycardToml(templateDir, zone.id));
    abort.signal.throwIfAborted();

    console.log("3. Building the template from SPEC.md...");
    const build = await runBuildAgent({
      templateDir,
      zoneIssuerUrl: zone.issuerUrl,
      resourceIdentifier: workerResource,
      usage: opts.usage,
      notes: opts.notes,
    });
    checks.push({ label: "Build agent completed the template build", ok: build.success });
    if (!build.success) throw new Error("Cloudflare template build failed");
    abort.signal.throwIfAborted();

    console.log("4. Starting the stub, local Worker, and anonymous tunnel...");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const publicKey = createPublicKey(privateKey).export({ format: "jwk" });
    const env: WorkerEnv = {
      KEYCARD_ISSUER: zone.issuerUrl,
      KEYCARD_PRIVATE_KEY: privateKey,
      KEYCARD_CLIENT_ID: clientId,
      KEYCARD_WORKER_RESOURCE: workerResource,
      KEYCARD_RESOURCE_URL: downstreamResource,
    };
    await trackSetup((async () => {
      const vars = await fs.open(varsPath, "wx", 0o600);
      varsCreated = true;
      try {
        await vars.writeFile(Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}\n`).join(""));
      } finally {
        await vars.close();
      }
    })());
    abort.signal.throwIfAborted();
    const calendar = await trackSetup(startCalendarStub({
      port: stubPort, zoneIssuerUrl: zone.issuerUrl, resourceIdentifier: downstreamResource,
    }).then((calendar) => (stub = calendar)));
    abort.signal.throwIfAborted();
    const workerProcess = wrangler = start("./node_modules/.bin/wrangler", [
      "dev", "--local", "--config", opts.wranglerConfig, "--ip", "127.0.0.1", "--port", String(port),
    ], templateDir);
    await waitFor("Worker /healthz", async () => {
      workerProcess.checkRunning("Wrangler");
      try {
        const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2_000) });
        return response.status === 200 && await response.text() === "ok" ? true : undefined;
      } catch { return undefined; }
    }, abort.signal);
    checks.push({ label: "Worker /healthz", ok: true });

    const tunnelProcess = tunnel = start("cloudflared", ["tunnel", "--no-autoupdate", "--url", base], templateDir);
    const tunnelUrl = await waitFor("cloudflared quick tunnel URL", async () => {
      tunnelProcess.checkRunning("cloudflared");
      return readQuickTunnelUrl(tunnelProcess.output());
    }, abort.signal);
    const jwksUri = `${tunnelUrl}/.well-known/jwks.json`;
    await waitFor("the tunnel to serve the Worker's public key", async () => {
      tunnelProcess.checkRunning("cloudflared");
      workerProcess.checkRunning("Wrangler");
      return await matchesPublicKey(jwksUri, publicKey).catch(() => false) ? true : undefined;
    }, abort.signal);
    checks.push({ label: "Tunnel JWKS matches the generated RS256 public key", ok: true });
    abort.signal.throwIfAborted();

    console.log("5. Registering the public-key credential and minting the user token...");
    await trackSetup(provisioning.registerPublicKey(app.applicationId, clientId, jwksUri));
    abort.signal.throwIfAborted();
    checks.push({ label: "Zone registered the public-key credential", ok: true });
    const user = await impersonateUser({
      zoneIssuerUrl: zone.issuerUrl,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      userIdentifier,
      resource: workerResource,
    });
    abort.signal.throwIfAborted();

    console.log("6. Verifying delegated access and capturing the SDK assertion in Node...");
    checks.push(...await verifyWorker({
      workerResource, downstreamResource, userToken: user.accessToken, userIdentifier, clientId, requests: calendar.requests,
    }));
    checks.push(...await verifyClientAssertion(templateDir, env));
    abort.signal.throwIfAborted();
    completed = true;
  } catch (err) {
    console.error(err instanceof Error ? redactProcessOutput(err.message) : "Cloudflare eval failed");
    checks.push({ label: "Cloudflare eval completed", ok: false });
  } finally {
    const clean = await cleanup();
    checks.push({ label: "Cleaned up Cloudflare eval processes, provisioning, and local vars", ok: clean });
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }

  const passed = completed && !abort.signal.aborted && checks.every((check) => check.ok);
  if (!passed) {
    wrangler?.reportTail("Wrangler");
    tunnel?.reportTail("cloudflared");
  }
  console.log("\n=== Results ===");
  for (const { label, ok } of checks) console.log(`   ${ok ? "✓" : "✗"} ${label}`);
  return passed;
}
