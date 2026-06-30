/**
 * Zone and resource provisioning via the Keycard Management API.
 * Reuses the same token exchange pattern as the CI workflow.
 */

import * as fs from "node:fs/promises";

async function getZoneIdFromToml(): Promise<string | undefined> {
  try {
    const toml = await fs.readFile(new URL("keycard.toml", import.meta.url), "utf8");
    // Match [zone] section then find id = "..."
    const match = toml.match(/\[zone\][^\[]*\bid\s*=\s*"([^"]+)"/s);
    return match?.[1];
  } catch { return undefined; }
}

function endpoint() {
  const e = process.env.CI_KEYCARD_ENDPOINT;
  if (!e) throw new Error("CI_KEYCARD_ENDPOINT is not set");
  return e;
}

export interface ZoneInfo {
  id: string;
  issuerUrl: string;
  stsProviderUrl: string;
}

async function getToken(): Promise<string> {
  const resp = await fetch(`${endpoint()}/service-account-token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.CI_KEYCARD_CLIENT_ID!,
      client_secret: process.env.CI_KEYCARD_CLIENT_SECRET!,
    }),
  });
  if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status} ${await resp.text()}`);
  const { access_token } = await resp.json() as { access_token: string };
  return access_token;
}

/**
 * Returns zone info for the eval run.
 * If EVAL_ZONE_ID + EVAL_ZONE_ISSUER_URL are set, reuses a persistent zone
 * (test user already exists there — no sign-up flow needed each run).
 * Otherwise creates a fresh ephemeral zone and marks it for teardown.
 */
export async function getOrCreateEvalZone(runId: string): Promise<{
  zone: ZoneInfo;
  token: string;
  ephemeral: boolean;
}> {
  const token = await getToken();

  // Prefer a persistent eval zone: the test user is already signed up there, so the
  // browser flow logs in directly instead of hitting sign-up/verify each run. The zone
  // comes from EVAL_ZONE_ID + EVAL_ZONE_ISSUER_URL (CI secrets), with keycard.toml
  // [zone].id as a local fallback.
  const persistentId = process.env.EVAL_ZONE_ID || (await getZoneIdFromToml());
  if (persistentId && persistentId !== "<eval-zone-id>") {
    const issuerUrl = process.env.EVAL_ZONE_ISSUER_URL || `https://${persistentId}.keycard.cloud`;
    return {
      zone: { id: persistentId, issuerUrl, stsProviderUrl: `${issuerUrl}/oauth/2/token` },
      token,
      ephemeral: false,
    };
  }

  // Refuse to create a throwaway zone implicitly: that is how abandoned eval-<runId>
  // zones accumulate. Require a persistent zone unless ephemeral creation is opted into.
  if (process.env.EVAL_ALLOW_EPHEMERAL !== "true") {
    throw new Error(
      "No persistent eval zone configured. Set EVAL_ZONE_ID + EVAL_ZONE_ISSUER_URL " +
      "(or keycard.toml [zone].id), or set EVAL_ALLOW_EPHEMERAL=true to create a throwaway " +
      "zone (it is torn down after the run).",
    );
  }

  const resp = await fetch(`${endpoint()}/zones`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `eval-${runId}` }),
  });
  if (!resp.ok) throw new Error(`Zone creation failed: ${resp.status} ${await resp.text()}`);

  const zone = await resp.json() as {
    id: string;
    protocols: { oauth2: { issuer: string; token_endpoint: string } };
  };

  // Zone bootstrap is async — wait for policy bindings to propagate
  await new Promise((r) => setTimeout(r, 5000));

  return {
    zone: {
      id: zone.id,
      issuerUrl: zone.protocols.oauth2.issuer,
      stsProviderUrl: zone.protocols.oauth2.token_endpoint,
    },
    token,
    ephemeral: true,
  };
}

export async function deleteZone(zoneId: string): Promise<void> {
  const token = await getToken();
  await fetch(`${endpoint()}/zones/${zoneId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Look up the zone's STS provider ID — needed to create a Resource with it as credential_provider. */
export async function getStsProviderId(zoneId: string, token: string): Promise<string> {
  const resp = await fetch(`${endpoint()}/zones/${zoneId}/providers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Providers fetch failed: ${resp.status}`);
  const { items } = await resp.json() as { items: Array<{ id: string; name: string; type: string }> };
  const sts = items.find((p) => p.type === "keycard-sts" || p.name?.toLowerCase().includes("sts"));
  if (!sts) throw new Error("No STS provider found on zone");
  return sts.id;
}
