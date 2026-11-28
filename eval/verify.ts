/**
 * Verify the running template server behaves correctly:
 * - /healthz returns 200
 * - .well-known endpoints return valid JSON
 * - An unauthenticated POST /mcp returns 401 with WWW-Authenticate
 * - An authenticated POST /mcp returns non-401 (auth passed)
 * - If the template exposes /broker, it brokers a delegated token (token exchange)
 */

import { decodeJwtPayload } from "./impersonate.js";

export interface VerifyResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
}

export interface VerifyOptions {
  serverUrl: string;
  resourceIdentifier: string;
  accessToken: string;
  expectedIssuer?: string;
  downstreamResourceIdentifier?: string;
}

export async function check(
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

  let resourceMetadataUrl = `${base}/.well-known/oauth-protected-resource`;

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
    const match = wwwAuth?.match(/resource_metadata="([^"]+)"/i);
    if (!match) {
      throw new Error(`Missing resource_metadata in WWW-Authenticate: ${wwwAuth}`);
    }
    const advertised = new URL(match[1]);
    const local = new URL(base);
    local.pathname = advertised.pathname;
    local.search = advertised.search;
    resourceMetadataUrl = local.toString();
  }, checks);

  await check(".well-known/oauth-protected-resource returns JSON", async () => {
    const resp = await fetch(resourceMetadataUrl);
    if (!resp.ok) throw new Error(`Expected 200 from ${resourceMetadataUrl}, got ${resp.status}`);
    const body = await resp.json();
    if (body.resource !== opts.resourceIdentifier) {
      throw new Error(`Expected resource ${opts.resourceIdentifier}, got ${body.resource}`);
    }
  }, checks);

  await check(".well-known/oauth-authorization-server returns JSON", async () => {
    const resp = await fetch(`${base}/.well-known/oauth-authorization-server`);
    if (!resp.ok) throw new Error(`Expected 200, got ${resp.status}`);
    const body = await resp.json();
    if (!body.issuer) throw new Error(`Missing 'issuer' field in response`);
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
    if (!opts.downstreamResourceIdentifier && (resp.status === 404 || resp.status === 405)) return;
    if (resp.status === 401) throw new Error(`Broker rejected the token (401)`);
    if (!resp.ok) throw new Error(`Broker returned ${resp.status}`);
    const body = await resp.json();
    if (body.brokered !== true) {
      throw new Error(`Token exchange did not succeed: ${JSON.stringify(body)}`);
    }
    if (opts.downstreamResourceIdentifier && body.resource !== opts.downstreamResourceIdentifier) {
      throw new Error("Broker did not exchange for the registered downstream resource");
    }
  }, checks);

  if (opts.downstreamResourceIdentifier) {
    await check("the inbound MCP token cannot access the downstream API directly", async () => {
      const resp = await fetch(`${base}/profile`, {
        headers: { Authorization: `Bearer ${opts.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      await resp.body?.cancel();
      if (resp.status !== 401) throw new Error(`Expected 401 from the downstream API, got ${resp.status}`);
    }, checks);

    await check("get_profile calls the downstream API as the signed-in user", async () => {
      const subject = decodeJwtPayload(opts.accessToken).sub;
      if (typeof subject !== "string" || !subject) throw new Error("MCP token has no subject");

      // The stateless Streamable HTTP transport accepts this tool call without a session.
      const resp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.accessToken}`,
          "Accept": "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_profile", arguments: {} },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) throw new Error(`MCP tool call returned HTTP ${resp.status}`);
      const body = resp.headers.get("content-type")?.includes("text/event-stream")
        ? (await resp.text()).split(/\r?\n/).filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6))).find((message) => message.id === 1)
        : await resp.json();
      if (body?.result?.isError || body?.result?.structuredContent?.subject !== subject) {
        throw new Error("get_profile did not return the signed-in user's subject");
      }
    }, checks);
  }

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}
