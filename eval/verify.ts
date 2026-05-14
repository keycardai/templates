/**
 * Verify the running template server behaves correctly:
 * - /healthz returns 200
 * - .well-known endpoints return valid JSON
 * - An unauthenticated POST /mcp returns 401 with WWW-Authenticate
 * - An authenticated POST /mcp returns non-401 (auth passed)
 *
 * For brokered-credentials templates, also verifies:
 * - The `search` tool returns results from the upstream (Linear) via brokered token exchange
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

/**
 * Extended verification for brokered-credentials templates: opens an MCP
 * session with the user's access token and calls the `search` tool. If the
 * brokered Linear token exchange and upstream proxy are working, `search`
 * should return at least one matching Linear tool.
 */
export async function verifyBrokeredTools(opts: VerifyOptions): Promise<VerifyResult> {
  const base = opts.serverUrl.replace(/\/$/, "");
  const checks: VerifyResult["checks"] = [];

  // Run the base checks first
  const base_result = await verifyServer(opts);
  checks.push(...base_result.checks);
  if (!base_result.passed) return { passed: false, checks };

  await check("search tool returns Linear results via brokered token", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${opts.accessToken}` },
      },
    });

    const client = new Client(
      { name: "keycard-eval", version: "0.1.0" },
      { capabilities: {} },
    );

    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "search", arguments: { pattern: "issue" } });

      if (!result.content || result.content.length === 0) {
        throw new Error("search returned empty content");
      }

      // Tool returns JSON: { matches: [...] }
      const text = (result.content[0] as { text?: string }).text ?? "";
      let parsed: { matches?: unknown[] };
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`search result is not valid JSON: ${text.slice(0, 200)}`);
      }

      if (!Array.isArray(parsed.matches) || parsed.matches.length === 0) {
        throw new Error(
          `search for 'issue' returned no matches — brokered Linear token exchange may have failed. Raw: ${text.slice(0, 300)}`,
        );
      }
    } finally {
      await client.close().catch(() => {});
    }
  }, checks);

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}
