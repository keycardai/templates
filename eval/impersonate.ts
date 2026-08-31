/**
 * Headless user identity for the eval: impersonation instead of a browser.
 *
 * A substitute-user token exchange (RFC 8693 with a Keycard-specific subject
 * token type) mints a real zone-issued user token with no login page. The
 * unsigned subject token carries only the user identifier; the zone derives
 * the acting party from client authentication, so the mint is authorized by
 * the application credential plus the zone's impersonation policy. This is the
 * same flow ruby-sdk's examples/mcp-server/bin/live-e2e uses to run its live
 * rows headlessly.
 *
 * The issued token is a normal zone access token: the agent under test can
 * exchange it for resource credentials exactly as it would a token produced by
 * the sign-in page.
 */

import { keycardEndpoint } from "./provision.js";

const SUBSTITUTE_USER_TOKEN_TYPE = "urn:keycard:params:oauth:token-type:substitute-user";

/**
 * A zone user's `identifier` defaults to their Keycard ID, not their email
 * (the email is the identifier only when the provider sets
 * user_identifier_claim), and the substitute-user exchange resolves its
 * subject against `identifier` exactly. Resolve the email to the real
 * identifier through the management API before minting.
 */
export async function resolveZoneUserIdentifier(
  zoneId: string,
  email: string,
  managementToken: string,
): Promise<string> {
  const url = `${keycardEndpoint()}/zones/${zoneId}/users?filter[email]=${encodeURIComponent(email)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${managementToken}` } });
  if (!resp.ok) {
    throw new Error(`List zone users failed: ${resp.status} ${await resp.text()}`);
  }
  const { items } = (await resp.json()) as { items: Array<{ identifier: string; email: string }> };
  const user = items[0];
  if (!user) {
    throw new Error(
      `No user with email ${email} exists in the eval zone. Sign the test user up once ` +
        "(EVAL_HEADLESS=false with a server template) before running agent evals.",
    );
  }
  return user.identifier;
}

export interface ImpersonationResult {
  accessToken: string;
  /** Decoded payload of the issued token, for logging and assertions. */
  claims: Record<string, unknown>;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** The unsigned container the zone reads the target user identifier from. */
function substituteUserToken(userIdentifier: string): string {
  const header = base64url(JSON.stringify({ typ: "vnd.kc.su+jwt", alg: "none" }));
  const payload = base64url(JSON.stringify({ sub: userIdentifier }));
  return `${header}.${payload}.`;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("Token has no payload segment");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

/**
 * Mint a zone-issued token whose subject is `userIdentifier`.
 *
 * `resource` must be a resource the impersonating application owns: the zone
 * only lets an application exchange a subject token whose first audience is
 * its own resource, so the agent's own resource is what a later delegated
 * exchange needs to see here.
 */
export async function impersonateUser(opts: {
  zoneIssuerUrl: string;
  clientId: string;
  clientSecret: string;
  userIdentifier: string;
  resource: string;
  scope?: string;
}): Promise<ImpersonationResult> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: substituteUserToken(opts.userIdentifier),
    subject_token_type: SUBSTITUTE_USER_TOKEN_TYPE,
    resource: opts.resource,
  });
  if (opts.scope) body.set("scope", opts.scope);

  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`, "utf8").toString("base64");
  const resp = await fetch(`${opts.zoneIssuerUrl.replace(/\/$/, "")}/oauth/2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!resp.ok) {
    throw new Error(
      `Impersonation failed for ${opts.userIdentifier} on ${opts.resource}: ` +
      `${resp.status} ${await resp.text()}`,
    );
  }

  const { access_token: accessToken } = (await resp.json()) as { access_token?: string };
  if (!accessToken) throw new Error("Impersonation response carried no access_token");

  const claims = decodeJwtPayload(accessToken);
  if (claims.sub !== opts.userIdentifier) {
    throw new Error(`Impersonated token sub is ${String(claims.sub)}, expected ${opts.userIdentifier}`);
  }
  return { accessToken, claims };
}
