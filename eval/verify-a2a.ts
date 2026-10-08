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

export interface VerifyA2ADelegationOptions {
  callerUrl: string;
  targetUrl: string;
  /** Zone token for the impersonated user, audienced at the caller's resource. */
  userAccessToken: string;
  /** Identifier impersonation minted the token for; the target must report it as sub. */
  userIdentifier: string;
  /** The caller's application identifier; the zone records it as act.sub on exchange. */
  callerApplicationIdentifier: string;
}

interface TargetReport {
  sub?: string;
  act?: { sub?: string; act?: unknown };
  aud?: string | string[];
}

async function sendMessage(agentUrl: string, text: string, bearer?: string): Promise<RpcReply> {
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
      method: "SendMessage",
      params: { message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }] } },
    }),
  });
  const text2 = await resp.text();
  let body: JsonRpcResponse = {};
  try { body = JSON.parse(text2) as JsonRpcResponse; } catch { /* 401 bodies are empty */ }
  return { status: resp.status, challenge: resp.headers.get("www-authenticate"), body, text: text2 };
}

function messageText(r: RpcReply): string {
  if (r.body.error) throw new Error(`JSON-RPC error ${r.body.error.code}: ${r.body.error.message ?? ""}`);
  const result = r.body.result as { message?: { parts?: Array<{ text?: string }> } } | undefined;
  const parts = result?.message?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("");
  if (!text) throw new Error(`Reply carries no message text (status ${r.status}): ${r.text.slice(0, 300)}`);
  return text;
}

async function checkCard(agentUrl: string) {
  const resp = await fetch(`${agentUrl}/.well-known/agent-card.json`);
  if (!resp.ok) throw new Error(`Expected 200, got ${resp.status}`);
  const card = (await resp.json()) as {
    name?: string;
    supportedInterfaces?: Array<{ url?: string; protocolBinding?: string; protocolVersion?: string }>;
  };
  if (!card.name) throw new Error("Card has no name");
  const jsonrpc = (card.supportedInterfaces ?? []).find((i) => /jsonrpc/i.test(i.protocolBinding ?? ""));
  if (!jsonrpc?.url) throw new Error(`Card has no JSONRPC interface: ${JSON.stringify(card.supportedInterfaces)}`);
  if (jsonrpc.protocolVersion !== "1.0") {
    throw new Error(`JSONRPC interface is protocol ${JSON.stringify(jsonrpc.protocolVersion)}, expected "1.0"`);
  }
}

/**
 * Verify the two-agent delegation template: one message goes through the
 * caller, and the target's reply carries the claims of the exchanged token it
 * verified. keycardai-a2a answers auth failures the way the TS template does
 * since #35, as HTTP 401 with an RFC 6750 challenge from keycard_on_error, so
 * every refusal is asserted on status and challenge, not on a JSON-RPC code.
 */
export async function verifyA2ADelegation(opts: VerifyA2ADelegationOptions): Promise<VerifyResult> {
  const checks: VerifyResult["checks"] = [];
  const callerUrl = opts.callerUrl.replace(/\/$/, "");
  const targetUrl = opts.targetUrl.replace(/\/$/, "");
  let report: TargetReport | undefined;

  await check("both agent cards advertise an A2A 1.0 JSON-RPC interface", async () => {
    await checkCard(callerUrl);
    await checkCard(targetUrl);
  }, checks);

  await check("SendMessage without a bearer: 401 with a Bearer challenge on both agents", async () => {
    expectChallenge("caller, no bearer", await sendMessage(callerUrl, "hello"));
    expectChallenge("target, no bearer", await sendMessage(targetUrl, "hello"));
  }, checks);

  await check("direct call to the target with the user's caller-audienced token: 401 invalid_token", async () => {
    expectChallenge("target, user token", await sendMessage(targetUrl, "hello", opts.userAccessToken), "invalid_token");
  }, checks);

  await check("one message through the caller reaches the target and comes back", async () => {
    const text = messageText(await sendMessage(callerUrl, "who am I?", opts.userAccessToken));
    const json = text.slice(text.indexOf("{"));
    try { report = JSON.parse(json) as TargetReport; } catch { throw new Error(`Target report is not JSON: ${text}`); }
    console.log(`   Target report: ${json}`);
  }, checks);

  await check("the target saw sub equal to the impersonated user", async () => {
    if (!report) throw new Error("no target report");
    if (report.sub !== opts.userIdentifier) throw new Error(`sub ${JSON.stringify(report.sub)}, expected ${opts.userIdentifier}`);
  }, checks);

  await check("the target saw an act chain naming the caller's application", async () => {
    if (!report) throw new Error("no target report");
    if (report.act?.sub !== opts.callerApplicationIdentifier) {
      throw new Error(`act ${JSON.stringify(report.act)}, expected act.sub ${opts.callerApplicationIdentifier}`);
    }
  }, checks);

  await check("the token the target received is audienced to the target only", async () => {
    if (!report) throw new Error("no target report");
    const aud = Array.isArray(report.aud) ? report.aud : report.aud ? [report.aud] : [];
    if (aud.length !== 1 || aud[0] !== targetUrl) throw new Error(`aud ${JSON.stringify(report.aud)}, expected ["${targetUrl}"]`);
  }, checks);

  return { passed: checks.every((c) => c.passed), checks };
}
