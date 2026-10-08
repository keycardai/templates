/**
 * Verification for an inbound-auth A2A agent template.
 *
 * The agent is a server other agents call, so the assertions are the server
 * flow's (verify.ts) shaped for A2A: discovery documents are served, and the
 * JSON-RPC endpoint accepts a zone token audienced at the agent while refusing
 * a missing one and one minted for another resource. None of it runs the
 * model or Snowflake: `tasks/get` for a task that does not exist is answered
 * from the request handler's task store, so auth is the only thing between
 * the request and a task-not-found error.
 */

import { check, type VerifyResult } from "./verify.js";

export interface VerifyA2AOptions {
  /** Base URL the agent serves on (AGENT_BASE_URL). */
  agentUrl: string;
  /** Zone token audienced at the agent's own resource. */
  accessToken: string;
  /** Zone token audienced at a resource the agent does not serve. */
  foreignAccessToken: string;
}

/**
 * What the auth gate and the task store answer with, for the `@keycardai/a2a`
 * the template pins (0.2.x). That release raises the A2A unauthorized code
 * -32001 for a missing or rejected bearer, the same code `@a2a-js/sdk` uses
 * for TaskNotFoundError, so the message is what tells the two apart.
 * `@keycardai/a2a` 0.4 (A2A 1.0) moved auth failures to -32000; when the
 * template moves to it, UNAUTHENTICATED becomes { code: -32000 } alone.
 */
const UNAUTHENTICATED = { code: -32001, message: /Missing or invalid Authorization header|Invalid or expired token/ };
const TASK_NOT_FOUND = { code: -32001, message: /^Task not found/ };

interface JsonRpcResponse {
  error?: { code: number; message?: string };
  result?: unknown;
}

async function getTask(agentUrl: string, bearer?: string): Promise<{ status: number; body: JsonRpcResponse }> {
  const resp = await fetch(`${agentUrl}/a2a/jsonrpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tasks/get",
      params: { id: `eval-missing-${crypto.randomUUID()}` },
    }),
  });
  const text = await resp.text();
  let body: JsonRpcResponse = {};
  try { body = JSON.parse(text) as JsonRpcResponse; } catch {
    throw new Error(`Non-JSON response (${resp.status}): ${text.slice(0, 200)}`);
  }
  return { status: resp.status, body };
}

function expectError(
  label: string,
  r: { status: number; body: JsonRpcResponse },
  want: { code: number; message: RegExp },
) {
  if (!r.body.error) {
    throw new Error(`${label}: expected JSON-RPC error ${want.code}, got result ${JSON.stringify(r.body.result).slice(0, 200)}`);
  }
  const got = `${r.body.error.code} (${r.body.error.message ?? ""})`;
  if (r.body.error.code !== want.code || !want.message.test(r.body.error.message ?? "")) {
    throw new Error(`${label}: expected JSON-RPC error ${want.code} matching ${want.message}, got ${got}`);
  }
}

export async function verifyA2AAgent(opts: VerifyA2AOptions): Promise<VerifyResult> {
  const checks: VerifyResult["checks"] = [];
  const agentUrl = opts.agentUrl.replace(/\/$/, "");

  await check("agent card names a JSON-RPC interface", async () => {
    const resp = await fetch(`${agentUrl}/.well-known/agent-card.json`);
    if (!resp.ok) throw new Error(`Expected 200, got ${resp.status}`);
    const card = (await resp.json()) as {
      name?: string;
      url?: string;
      preferredTransport?: string;
      additionalInterfaces?: Array<{ transport?: string; url?: string }>;
    };
    if (!card.name) throw new Error("Card has no name");
    const transports = [card.preferredTransport, ...(card.additionalInterfaces ?? []).map((i) => i.transport)]
      .filter((t): t is string => typeof t === "string");
    // A2A 0.3 cards default preferredTransport to JSONRPC when omitted.
    if (transports.length && !transports.some((t) => /jsonrpc/i.test(t))) {
      throw new Error(`Card advertises ${JSON.stringify(transports)}, no JSON-RPC interface`);
    }
    if (!card.url) throw new Error("Card has no url");
  }, checks);

  await check("JWKS and OAuth client metadata are served", async () => {
    const jwks = await fetch(`${agentUrl}/.well-known/jwks.json`);
    if (!jwks.ok) throw new Error(`jwks.json: expected 200, got ${jwks.status}`);
    const { keys } = (await jwks.json()) as { keys?: unknown[] };
    if (!keys?.length) throw new Error("jwks.json has no keys");
    const meta = await fetch(`${agentUrl}/.well-known/oauth-client-metadata`);
    if (!meta.ok) throw new Error(`oauth-client-metadata: expected 200, got ${meta.status}`);
    const { client_id: clientId } = (await meta.json()) as { client_id?: string };
    if (!clientId) throw new Error("oauth-client-metadata has no client_id");
  }, checks);

  await check("/healthz reports degraded for the missing Snowflake config", async () => {
    const resp = await fetch(`${agentUrl}/healthz`);
    if (!resp.ok) throw new Error(`Expected 200, got ${resp.status}`);
    const body = (await resp.json()) as { status?: string; reason?: string };
    if (body.status !== "degraded") throw new Error(`Expected status "degraded", got ${JSON.stringify(body)}`);
    if (!/snowflake/i.test(body.reason ?? "")) throw new Error(`Reason does not name Snowflake: ${JSON.stringify(body)}`);
  }, checks);

  await check("JSON-RPC without a bearer fails unauthenticated", async () => {
    expectError("no bearer", await getTask(agentUrl), UNAUTHENTICATED);
  }, checks);

  await check("JSON-RPC with a zone token for the agent passes auth (task not found, not unauthenticated)", async () => {
    expectError("agent token", await getTask(agentUrl, opts.accessToken), TASK_NOT_FOUND);
  }, checks);

  await check("JSON-RPC with a zone token for another resource is refused", async () => {
    expectError("foreign token", await getTask(agentUrl, opts.foreignAccessToken), UNAUTHENTICATED);
  }, checks);

  return { passed: checks.every((c) => c.passed), checks };
}
