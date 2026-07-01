/**
 * Verify the running template server behaves correctly:
 * - /healthz returns 200
 * - .well-known endpoints return valid JSON
 * - An unauthenticated POST /mcp returns 401 with WWW-Authenticate
 * - An authenticated POST /mcp returns non-401 (auth passed)
 * - If the template exposes /broker, it brokers a delegated token (token exchange)
 */

export interface VerifyResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
}

export interface VerifyOptions {
  serverUrl: string;
  accessToken: string;
  expectedIssuer?: string;
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

export async function verifyServer(opts: VerifyOptions): Promise<VerifyResult> {
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
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
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
    if (resp.status === 401) {
      const wwwAuth = resp.headers.get("www-authenticate") ?? "(none)";
      throw new Error(`Token was rejected (got 401). WWW-Authenticate: ${wwwAuth}`);
    }
    // Any non-401 means auth passed. 400 (bad JSON-RPC) is acceptable.
  }, checks);

  // Templates that broker delegated access expose /broker: bearer auth verifies the user,
  // then the server exchanges that token for a resource-scoped one via its application
  // credential. Skipped for templates without the endpoint (404/405), so this is a no-op
  // for the base server template.
  await check("broker exchanges the user's token for a delegated token", async () => {
    const resp = await fetch(`${base}/broker`, {
      headers: { Authorization: `Bearer ${opts.accessToken}` },
    });
    if (resp.status === 404 || resp.status === 405) return; // template does not broker; skip
    if (resp.status === 401) throw new Error(`Broker rejected the token (401)`);
    if (!resp.ok) throw new Error(`Broker returned ${resp.status}`);
    const body = await resp.json();
    if (body.brokered !== true) {
      throw new Error(`Token exchange did not succeed: ${JSON.stringify(body)}`);
    }
  }, checks);

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}
