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

/** A2A 1.0 JSON-RPC code for TaskNotFoundError. */
const TASK_NOT_FOUND = -32001;

interface JsonRpcResponse {
  error?: { code: number; message?: string };
  result?: unknown;
}

interface RpcReply {
  status: number;
  challenge: string | null;
  body: JsonRpcResponse;
  text: string;
}

async function getTask(agentUrl: string, bearer?: string): Promise<RpcReply> {
  const resp = await fetch(`${agentUrl}/a2a/jsonrpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "A2A-Version": "1.0",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "GetTask",
      params: { id: `eval-missing-${crypto.randomUUID()}` },
    }),
  });
  const text = await resp.text();
  let body: JsonRpcResponse = {};
  try { body = JSON.parse(text) as JsonRpcResponse; } catch { /* 401 bodies are empty */ }
  return { status: resp.status, challenge: resp.headers.get("www-authenticate"), body, text };
}

function expectChallenge(label: string, r: RpcReply, wantError?: string) {
  if (r.status !== 401) {
    throw new Error(`${label}: expected HTTP 401, got ${r.status} ${r.text.slice(0, 200)}`);
  }
  if (!r.challenge || !/^Bearer\b/i.test(r.challenge)) {
    throw new Error(`${label}: expected a WWW-Authenticate Bearer challenge, got ${JSON.stringify(r.challenge)}`);
  }
  if (wantError && !r.challenge.includes(`error="${wantError}"`)) {
    throw new Error(`${label}: expected error="${wantError}" in the challenge, got ${r.challenge}`);
  }
}

function expectRpcError(label: string, r: RpcReply, code: number) {
  if (r.status === 401) {
    throw new Error(`${label}: auth was refused (401 ${r.challenge ?? ""})`);
  }
  if (!r.body.error) {
    throw new Error(`${label}: expected JSON-RPC error ${code}, got ${r.status} ${r.text.slice(0, 200)}`);
  }
  if (r.body.error.code !== code) {
    throw new Error(`${label}: expected JSON-RPC error ${code}, got ${r.body.error.code} (${r.body.error.message ?? ""})`);
  }
}

export async function verifyA2AAgent(opts: VerifyA2AOptions): Promise<VerifyResult> {
  const checks: VerifyResult["checks"] = [];
  const agentUrl = opts.agentUrl.replace(/\/$/, "");

  await check("agent card advertises an A2A 1.0 JSON-RPC interface", async () => {
    const resp = await fetch(`${agentUrl}/.well-known/agent-card.json`);
    if (!resp.ok) throw new Error(`Expected 200, got ${resp.status}`);
    const card = (await resp.json()) as {
      name?: string;
      supportedInterfaces?: Array<{ url?: string; protocolBinding?: string; protocolVersion?: string }>;
    };
    if (!card.name) throw new Error("Card has no name");
    const jsonrpc = (card.supportedInterfaces ?? []).find((i) => /jsonrpc/i.test(i.protocolBinding ?? ""));
    if (!jsonrpc) {
      throw new Error(`Card has no JSONRPC interface in supportedInterfaces: ${JSON.stringify(card.supportedInterfaces)}`);
    }
    if (jsonrpc.protocolVersion !== "1.0") {
      throw new Error(`JSONRPC interface is protocol ${JSON.stringify(jsonrpc.protocolVersion)}, expected "1.0"`);
    }
    if (!jsonrpc.url) throw new Error("JSONRPC interface has no url");
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

  await check("GetTask without a bearer: 401 with a Bearer challenge", async () => {
    expectChallenge("no bearer", await getTask(agentUrl));
  }, checks);

  await check("GetTask with a zone token for the agent passes auth (TaskNotFound -32001)", async () => {
    expectRpcError("agent token", await getTask(agentUrl, opts.accessToken), TASK_NOT_FOUND);
  }, checks);

  await check("GetTask with a zone token for another resource: 401 invalid_token", async () => {
    expectChallenge("foreign token", await getTask(agentUrl, opts.foreignAccessToken), "invalid_token");
  }, checks);

  return { passed: checks.every((c) => c.passed), checks };
}
