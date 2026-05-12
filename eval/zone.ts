/**
 * Zone and resource provisioning via the Keycard Management API.
 * Reuses the same token exchange pattern as the CI workflow.
 */

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

export async function createEvalZone(runId: string): Promise<{ zone: ZoneInfo; token: string }> {
  const token = await getToken();
  const name = `eval-${runId}`;

  const resp = await fetch(`${endpoint()}/zones`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!resp.ok) throw new Error(`Zone creation failed: ${resp.status} ${await resp.text()}`);

  const zone = await resp.json() as {
    id: string;
    protocols: { oauth2: { issuer: string; token_endpoint: string } };
  };

  return {
    zone: {
      id: zone.id,
      issuerUrl: zone.protocols.oauth2.issuer,
      stsProviderUrl: zone.protocols.oauth2.token_endpoint,
    },
    token,
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
