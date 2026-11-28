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
  let startBuild!: () => void;
  const building = new Promise<void>((resolve) => { startBuild = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    const path = new URL(request.url ?? "/", "http://fixture.test").pathname.replace("/zones/test/", "");
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
      case "resources": return json(request.method === "POST" ? { id: `resource-${++resourceCount}` } : { items: [] });
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
      runId: "fixture", usage: {}, notes: "",
    });
  `], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: {
      PATH: process.env.PATH,
      CI_KEYCARD_ENDPOINT: endpoint,
      EVAL_ZONE_ID: "test",
      EVAL_ZONE_ISSUER_URL: "https://zone.example.test",
      EVAL_TEST_USER_EMAIL: "test@example.test",
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
  assert.deepEqual(removed, [
    "application-credentials/credential", "applications/app", "resources/resource-1", "resources/resource-2",
  ]);
  assert.equal(await readFile(join(templateDir, "keycard.toml"), "utf8"), toml);
});
