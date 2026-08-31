/**
 * Verification for an outbound-auth agent template.
 *
 * The server templates are inbound-auth: verify.ts asserts they accept an
 * authenticated request and reject an unauthenticated one. An agent has no
 * inbound surface to protect. What matters here is the outbound leg: the agent
 * takes the signed-in user's identity, brokers a per-tool-call credential for
 * the resource it was provisioned against, and the resource receives a token it
 * can verify. So the assertions live at the far end, on the stub the tool calls.
 */

import { type CalendarStub } from "./calendar-stub.js";
import { check, type VerifyResult } from "./verify.js";

export interface VerifyAgentOptions {
  /** Base URL of `langgraph dev`. */
  agentUrl: string;
  stub: CalendarStub;
  /** Resource identifier the brokered token must be audienced at. */
  resourceIdentifier: string;
  /** The impersonated user the delegated token must name as its subject. */
  expectedSubject: string;
  /** Assistant (graph) id to run. */
  assistantId?: string;
  prompt?: string;
  runTimeoutMs?: number;
}

const DEFAULT_PROMPT =
  "Call the list_calendar_events tool for today, then reply with the tool result verbatim.";

interface RunOutcome {
  interrupt?: string;
  toolMessages: string[];
}

/** Send one run through the graph and wait for it to settle. */
async function runAgent(opts: {
  agentUrl: string;
  assistantId: string;
  prompt: string;
  timeoutMs: number;
}): Promise<RunOutcome> {
  const resp = await fetch(`${opts.agentUrl}/runs/wait`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      assistant_id: opts.assistantId,
      input: { messages: [{ role: "user", content: opts.prompt }] },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!resp.ok) throw new Error(`Run failed: ${resp.status} ${await resp.text()}`);

  const state = (await resp.json()) as {
    __interrupt__?: unknown;
    messages?: Array<{ type?: string; role?: string; content?: unknown }>;
  };

  const toolMessages = (state.messages ?? [])
    .filter((m) => m.type === "tool" || m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

  return {
    interrupt: state.__interrupt__ ? JSON.stringify(state.__interrupt__).slice(0, 500) : undefined,
    toolMessages,
  };
}

export async function verifyAgent(opts: VerifyAgentOptions): Promise<VerifyResult> {
  const checks: VerifyResult["checks"] = [];
  const agentUrl = opts.agentUrl.replace(/\/$/, "");
  const assistantId = opts.assistantId ?? "agent";

  await check("agent server /ok returns ok", async () => {
    const resp = await fetch(`${agentUrl}/ok`);
    if (!resp.ok) throw new Error(`Expected 200, got ${resp.status}`);
    const body = (await resp.json()) as { ok?: boolean };
    if (body.ok !== true) throw new Error(`Expected {"ok":true}, got ${JSON.stringify(body)}`);
  }, checks);

  // The negative control for the outbound leg: the resource the agent calls
  // only accepts zone-issued tokens, so an unauthenticated call must fail.
  await check("stub calendar rejects an unauthenticated call", async () => {
    const resp = await fetch(`${opts.stub.url}/calendars/primary/events`);
    if (resp.status !== 401) throw new Error(`Expected 401, got ${resp.status}`);
    const wwwAuth = resp.headers.get("www-authenticate");
    if (!wwwAuth?.startsWith("Bearer")) {
      throw new Error(`Missing Bearer challenge, got ${String(wwwAuth)}`);
    }
  }, checks);

  const before = opts.stub.requests.length;
  let outcome: RunOutcome | undefined;

  await check("agent run reaches the calendar tool", async () => {
    outcome = await runAgent({
      agentUrl,
      assistantId,
      prompt: opts.prompt ?? DEFAULT_PROMPT,
      timeoutMs: opts.runTimeoutMs ?? 180_000,
    });
    if (outcome.interrupt) {
      throw new Error(
        `Run paused instead of calling the tool. Interrupt: ${outcome.interrupt}. ` +
        "A sign_in_required interrupt means the impersonated token did not reach the agent; " +
        "authorization_required means the exchange for the calendar resource was refused.",
      );
    }
    if (!outcome.toolMessages.length) throw new Error("The model turn produced no tool call");
    const errors = outcome.toolMessages.filter((m) => /error|authorization required|cannot call/i.test(m));
    if (errors.length) throw new Error(`Tool reported: ${errors[0].slice(0, 300)}`);
  }, checks);

  // The load-bearing assertion: the call the agent actually made carried a
  // token that verifies against the ephemeral zone's JWKS, with this stub as
  // the audience and the impersonated user as the subject.
  await check("tool call arrives with a zone-verified delegated token", async () => {
    const during = opts.stub.requests.slice(before);
    const authenticated = during.filter((r) => r.claims);
    if (!authenticated.length) {
      const rejections = during.map((r) => `${r.method} ${r.path}: ${r.rejection ?? "none"}`);
      throw new Error(
        `No verified call reached the stub. Requests during the run: ` +
        `${rejections.length ? rejections.join("; ") : "(none)"}`,
      );
    }
    const claims = authenticated[0].claims!;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(opts.resourceIdentifier)) {
      throw new Error(`Token audience ${JSON.stringify(claims.aud)} excludes ${opts.resourceIdentifier}`);
    }
    if (claims.sub !== opts.expectedSubject) {
      throw new Error(`Token subject is ${String(claims.sub)}, expected ${opts.expectedSubject}`);
    }
  }, checks);

  return { passed: checks.every((c) => c.passed), checks };
}
