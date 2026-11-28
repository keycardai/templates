import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EVAL_IMPERSONATION_POLICY_NAME } from "./policy.js";

test("SIGTERM cleans up provisioned objects without waiting for the build agent", { timeout: 10_000 }, async (t) => {
  const templateDir = await mkdtemp(join(tmpdir(), "cloudflare-eval-test-"));
  t.after(() => rm(templateDir, { recursive: true, force: true }));
  const toml = '[org]\nid = "<org-id>"\n[zone]\nid = "<zone-id>"\n[credentials]\n';
  await writeFile(join(templateDir, "keycard.toml"), toml);
  await writeFile(join(templateDir, "SPEC.md"), "Test fixture");

  const removed: string[] = [];
  let resourceCount = 0;
  const registeredResources: string[] = [];
  const runId = "delegated-access-typescript-cloudflare--123-1";
  let startBuild!: () => void;
  const building = new Promise<void>((resolve) => { startBuild = resolve; });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.test");
    const path = url.pathname.replace("/zones/test/", "");
    if (path !== "resources" || request.method !== "POST") request.resume();
    const json = (value: unknown) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (path === "/v1/messages") { startBuild(); return; }
    if (request.method === "DELETE") {
      removed.push(path);
      response.writeHead(204).end();
      return;
    }
    if (request.method === "PUT") { response.writeHead(204).end(); return; }
    switch (path) {
      case "/service-account-token": return json({ access_token: "fixture" });
      case "applications": return json(request.method === "POST" ? { id: "app" } : { items: [] });
      case "resources":
        if (request.method === "POST") {
          let body = "";
          request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          request.on("end", () => {
            registeredResources.push(JSON.parse(body).identifier);
            json({ id: `resource-${++resourceCount}` });
          });
          return;
        }
        if (url.searchParams.get("query[name]") !== "eval-resource-") {
          return response.writeHead(400).end();
        }
        return json({ items: [
          { id: "abandoned-run", name: "eval-resource-worker-delegated-access-typescript-cloudflare--121-1",
            created_at: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString() },
          { id: "active-run", name: "eval-resource-worker-delegated-access-typescript-cloudflare--122-1",
            created_at: new Date().toISOString() },
        ] });
      case "providers": return json({ items: [{ id: "sts", type: "keycard-sts" }] });
      case "users": return json({ items: [{ identifier: "fixture-user" }] });
      case "application-credentials": return json({ id: "credential", identifier: "fixture-id", password: "fixture-password" });
      case "policy-sets": return json({ items: [{ id: "policy-set" }] });
      case "policy-sets/policy-set/versions": return json({ items: [{ id: "version", active: true }] });
      case "policies": return json({ items: [{ id: "permit", name: EVAL_IMPERSONATION_POLICY_NAME, latest_version_id: "permit-version" }] });
      case "policy-sets/policy-set/versions/version":
        return json({ schema_version: "99", manifest: { entries: [{ policy_id: "permit" }] } });
      default:
        response.writeHead(404).end();
    }
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const moduleUrl = new URL("./cloudflare-run.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { runCloudflareEval } from ${JSON.stringify(moduleUrl)};
    await runCloudflareEval({
      templateDir: ${JSON.stringify(templateDir)}, wranglerConfig: "wrangler.jsonc",
      runId: ${JSON.stringify(runId)}, usage: {}, notes: "",
    });
  `], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: {
      PATH: process.env.PATH,
      CI_KEYCARD_ENDPOINT: endpoint,
      EVAL_ZONE_ID: "test",
      EVAL_ZONE_ISSUER_URL: "https://zone.example.test",
      EVAL_TEST_USER_EMAIL: "test@example.test",
      EVAL_WORKER_PORT: "8787",
      EVAL_STUB_PORT: "8901",
      ANTHROPIC_BASE_URL: endpoint,
      ANTHROPIC_API_KEY: "fixture",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exit = once(child, "exit");
  await Promise.race([building, exit.then(() => assert.fail(stderr || "Exited before build started"))]);
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [1, null]);
  assert.match(stderr, /Cloudflare eval interrupted; cleaning up/);
  assert.deepEqual(registeredResources, [
    "http://delegated-access-typescript-cloudflare.123-1.localhost:8787/call",
    "http://delegated-access-typescript-cloudflare.123-1.localhost:8901/calendars/primary/events",
  ]);
  assert.deepEqual(removed, [
    "resources/abandoned-run",
    "application-credentials/credential", "applications/app", "resources/resource-1", "resources/resource-2",
  ]);
  assert.equal(await readFile(join(templateDir, "keycard.toml"), "utf8"), toml);
});
