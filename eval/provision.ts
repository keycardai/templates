/**
 * Provision Keycard resources required for a template.
 * Mirrors the SPEC.md provisioning steps but executed by the harness
 * (not the agent) so the agent focuses on config + build verification.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

function endpoint() {
  const e = process.env.CI_KEYCARD_ENDPOINT;
  if (!e) throw new Error("CI_KEYCARD_ENDPOINT is not set");
  return e;
}

export interface ProvisionedZone {
  zoneId: string;
  zoneIssuerUrl: string;
  applicationId: string;
  resourceId: string;
  resourceIdentifier: string;
}

/** Find the keycard-sts provider on the zone. */
async function getStsProviderId(zoneId: string, token: string): Promise<string> {
  const resp = await fetch(`${endpoint()}/zones/${zoneId}/providers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`GET /zones/${zoneId}/providers failed: ${resp.status} ${await resp.text()}`);
  const { items } = await resp.json() as { items: Array<{ id: string; name: string; type?: string }> };
  const sts = items.find((p) => p.type === "keycard-sts" || p.name?.toLowerCase().includes("sts"));
  if (!sts) throw new Error(`No STS provider found. Providers: ${JSON.stringify(items.map(p => p.name))}`);
  return sts.id;
}

/** Create the Application and Resource the template needs, write .env and keycard.toml. */
export async function provision(opts: {
  zoneId: string;
  zoneIssuerUrl: string;
  runId: string;
  token: string;
  templateDir: string;
  serverPort?: number;
}): Promise<ProvisionedZone> {
  const { zoneId, zoneIssuerUrl, runId, token, templateDir } = opts;
  const port = opts.serverPort ?? 8000;
  const resourceIdentifier = `http://localhost:${port}/mcp`;

  // 1. Find the STS provider
  const stsProviderId = await getStsProviderId(zoneId, token);
  console.log(`   STS provider: ${stsProviderId}`);

  // 2. Create Application
  const appResp = await fetch(`${endpoint()}/zones/${zoneId}/applications`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `eval-app-${runId}`, identifier: `eval-app-${runId}` }),
  });
  if (!appResp.ok) throw new Error(`Create application failed: ${appResp.status} ${await appResp.text()}`);
  const { id: applicationId } = await appResp.json() as { id: string };
  console.log(`   Application: ${applicationId}`);

  // 3. Create Resource
  const resResp = await fetch(`${endpoint()}/zones/${zoneId}/resources`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `eval-resource-${runId}`,
      identifier: resourceIdentifier,
      credential_provider_id: stsProviderId,
    }),
  });
  if (!resResp.ok) throw new Error(`Create resource failed: ${resResp.status} ${await resResp.text()}`);
  const { id: resourceId } = await resResp.json() as { id: string };
  console.log(`   Resource: ${resourceId} (${resourceIdentifier})`);

  // 4. Write .env
  const envContent = `KEYCARD_URL=${zoneIssuerUrl}\nKEYCARD_RESOURCE_ID=${resourceIdentifier}\nPORT=${port}\n`;
  await fs.writeFile(path.join(templateDir, ".env"), envContent, "utf8");
  console.log(`   Wrote .env`);

  // 5. Write keycard.toml (overwrites the placeholder in the template)
  const tomlContent = `schema_version = "1"\n\n[project]\nname = "mcp-server-typescript-express"\nkind = "mcp-server"\n\n[zone]\nurl = "${zoneIssuerUrl}"\n\n[server]\ncommand = "npm run start"\nport = ${port}\n`;
  await fs.writeFile(path.join(templateDir, "keycard.toml"), tomlContent, "utf8");
  console.log(`   Wrote keycard.toml`);

  return { zoneId, zoneIssuerUrl, applicationId, resourceId, resourceIdentifier };
}
