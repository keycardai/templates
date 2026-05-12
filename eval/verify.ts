/**
 * Verify the running template server behaves correctly:
 * - /healthz returns 200
 * - .well-known endpoints return valid JSON
 * - An authenticated request (Bearer token) returns 200
 * - An unauthenticated request returns 401
 */

export interface VerifyResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
}

async function check(
  name: string,
  fn: () => Promise<void>,
  results: VerifyResult["checks"],
): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({ name, passed: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

export async function verifyServer(opts: {
  serverUrl: string;
  accessToken: string;
}): Promise<VerifyResult> {
  const base = opts.serverUrl.replace(/\/$/, "");
  const checks: VerifyResult["checks"] = [];

  await check("healthz returns 200", async () => {
    const resp = await fetch(`${base}/healthz`);
    if (!resp.ok) throw new Error(`Expected 200, got ${resp.status}`);
  }, checks);

  await check(".well-known/oauth-protected-resource returns JSON", async () => {
    const resp = await fetch(`${base}/.well-known/oauth-protected-resource`);
    if (!resp.ok) throw new Error(`Expected 200, got ${resp.status}`);
    const body = await resp.json();
    if (!body.resource) throw new Error(`Missing 'resource' field in response`);
  }, checks);

  await check(".well-known/oauth-authorization-server returns JSON", async () => {
    const resp = await fetch(`${base}/.well-known/oauth-authorization-server`);
    if (!resp.ok) throw new Error(`Expected 200, got ${resp.status}`);
    const body = await resp.json();
    if (!body.issuer) throw new Error(`Missing 'issuer' field in response`);
  }, checks);

  await check("unauthenticated POST /mcp returns 401", async () => {
    const resp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (resp.status !== 401) throw new Error(`Expected 401, got ${resp.status}`);
    const wwwAuth = resp.headers.get("www-authenticate");
    if (!wwwAuth?.includes("resource_metadata")) {
      throw new Error(`Missing resource_metadata in WWW-Authenticate: ${wwwAuth}`);
    }
  }, checks);

  await check("authenticated POST /mcp is accepted (not 401)", async () => {
    const resp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (resp.status === 401) throw new Error(`Token was rejected (got 401)`);
    // Any non-401 means auth passed. 400 (bad JSON-RPC) is acceptable.
  }, checks);

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}
