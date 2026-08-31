/**
 * A local stand-in for the Google Calendar API.
 *
 * The langchain agent template calls whatever base URL `KEYCARD_RESOURCE`
 * names, so the eval registers this server as the zone resource the agent
 * brokers a credential for and points the template at it. That keeps the whole
 * chain real (provisioning, grant, mint, outbound call) with no Google account
 * and no network egress: the only thing replaced is the API on the other end.
 *
 * The stub is the assertion point. Every request is recorded with the outcome
 * of verifying its bearer token against the ephemeral zone's JWKS, so the eval
 * can prove the agent's tool call arrived carrying a zone-issued token with the
 * expected issuer, audience and subject, and that an unauthenticated request is
 * rejected.
 */

import * as http from "node:http";
import * as crypto from "node:crypto";

export interface StubRequestRecord {
  method: string;
  path: string;
  status: number;
  /** Verified token claims, when the request carried a token that verified. */
  claims?: Record<string, unknown>;
  /** Why the request was rejected, when it was. */
  rejection?: string;
}

export interface CalendarStub {
  /** Base URL the template's KEYCARD_RESOURCE points at. */
  url: string;
  requests: StubRequestRecord[];
  close: () => Promise<void>;
}

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  [key: string]: unknown;
}

const ALGORITHMS: Record<string, { hash: string; dsaEncoding?: "ieee-p1363" }> = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  ES256: { hash: "sha256", dsaEncoding: "ieee-p1363" },
  ES384: { hash: "sha384", dsaEncoding: "ieee-p1363" },
};

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Resolve the zone's JWKS through its authorization server metadata. */
async function fetchJwks(issuer: string): Promise<Jwk[]> {
  const base = issuer.replace(/\/$/, "");
  const metaResp = await fetch(`${base}/.well-known/oauth-authorization-server`);
  if (!metaResp.ok) {
    throw new Error(`Authorization server metadata fetch failed: ${metaResp.status}`);
  }
  const { jwks_uri: jwksUri } = (await metaResp.json()) as { jwks_uri?: string };
  if (!jwksUri) throw new Error("Authorization server metadata carries no jwks_uri");

  const jwksResp = await fetch(jwksUri);
  if (!jwksResp.ok) throw new Error(`JWKS fetch failed: ${jwksResp.status}`);
  const { keys } = (await jwksResp.json()) as { keys?: Jwk[] };
  if (!keys?.length) throw new Error(`JWKS at ${jwksUri} carries no keys`);
  return keys;
}

function audiences(claim: unknown): string[] {
  if (typeof claim === "string") return [claim];
  if (Array.isArray(claim)) return claim.filter((a): a is string => typeof a === "string");
  return [];
}

/**
 * Verify a bearer token as the resource server would: real signature check
 * against the zone's published keys, then issuer, audience and expiry.
 */
function verifyToken(
  token: string,
  opts: { issuer: string; audience: string; keys: Jwk[] },
): Record<string, unknown> {
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart) throw new Error("Malformed JWT");

  const header = decodeSegment(headerPart) as { alg?: string; kid?: string };
  const algorithm = ALGORITHMS[header.alg ?? ""];
  if (!algorithm) throw new Error(`Unsupported token algorithm ${String(header.alg)}`);

  const key = opts.keys.find((k) => !header.kid || k.kid === header.kid);
  if (!key) throw new Error(`No JWKS key matches kid ${String(header.kid)}`);

  const publicKey = crypto.createPublicKey({ key: key as crypto.JsonWebKey, format: "jwk" });
  const verified = crypto.verify(
    algorithm.hash,
    Buffer.from(`${headerPart}.${payloadPart}`, "utf8"),
    { key: publicKey, dsaEncoding: algorithm.dsaEncoding },
    Buffer.from(signaturePart, "base64url"),
  );
  if (!verified) throw new Error("Token signature does not verify against the zone JWKS");

  const claims = decodeSegment(payloadPart);
  const issuer = typeof claims.iss === "string" ? claims.iss.replace(/\/$/, "") : "";
  if (issuer !== opts.issuer.replace(/\/$/, "")) {
    throw new Error(`Token issuer is ${issuer || "(absent)"}, expected ${opts.issuer}`);
  }
  if (!audiences(claims.aud).includes(opts.audience)) {
    throw new Error(`Token audience ${JSON.stringify(claims.aud)} does not include ${opts.audience}`);
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) {
    throw new Error("Token is expired");
  }
  return claims;
}

/** A fixed event, so an assertion on the agent's answer is deterministic. */
function stubEvents(): unknown[] {
  const start = new Date();
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return [
    {
      id: "eval-event-1",
      summary: "Keycard eval standup",
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: [],
    },
  ];
}

export async function startCalendarStub(opts: {
  port: number;
  /** The ephemeral zone issuer whose JWKS signs acceptable tokens. */
  zoneIssuerUrl: string;
  /** The resource identifier the token must be audienced at (this stub). */
  resourceIdentifier: string;
}): Promise<CalendarStub> {
  const keys = await fetchJwks(opts.zoneIssuerUrl);
  const requests: StubRequestRecord[] = [];

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const record: StubRequestRecord = { method: req.method ?? "GET", path, status: 200 };
    requests.push(record);

    const respond = (status: number, body: unknown) => {
      record.status = status;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const header = req.headers.authorization ?? "";
    if (!header.toLowerCase().startsWith("bearer ")) {
      record.rejection = "no bearer token";
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${opts.resourceIdentifier}"`);
      respond(401, { error: { code: 401, message: "Request is missing a bearer token" } });
      return;
    }

    try {
      record.claims = verifyToken(header.slice(7).trim(), {
        issuer: opts.zoneIssuerUrl,
        audience: opts.resourceIdentifier,
        keys,
      });
    } catch (err) {
      record.rejection = err instanceof Error ? err.message : String(err);
      res.setHeader("WWW-Authenticate", `Bearer error="invalid_token"`);
      respond(401, { error: { code: 401, message: record.rejection } });
      return;
    }

    if (req.method === "GET" && path === "/calendars/primary/events") {
      respond(200, { kind: "calendar#events", items: stubEvents() });
      return;
    }
    if (req.method === "POST" && path === "/calendars/primary/events") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const created = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        respond(200, {
          id: "eval-event-created",
          summary: created.summary ?? "(no title)",
          htmlLink: "http://localhost/eval-event-created",
        });
      });
      return;
    }
    respond(404, { error: { code: 404, message: `No stub route for ${req.method} ${path}` } });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", resolve);
  });

  return {
    url: `http://localhost:${opts.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
