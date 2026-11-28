/**
 * Provision Keycard resources required for a template.
 * Mirrors the SPEC.md provisioning steps but executed by the harness
 * (not the agent) so the agent focuses on config + build verification.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeKeycardToml } from "./keycard-toml.js";
import { evalOrigin } from "./run-identity.js";

export function keycardEndpoint() {
  const e = process.env.CI_KEYCARD_ENDPOINT;
  if (!e) throw new Error("CI_KEYCARD_ENDPOINT is not set");
  return e;
}

const endpoint = keycardEndpoint;

type Collection = "applications" | "resources";

// The eval workflow uses GitHub Actions' default six-hour job timeout.
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;
const RUN_NAME = /^[a-z0-9-]+--(?:\d+-\d+|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/;

interface ProvisioningPage {
  items: Array<{ id: string; name: string; created_at: string }>;
  pagination?: { after_cursor: string | null };
}

export interface ProvisionedZone {
  /** Client credential minted for the application, so a broker can authenticate its exchange. */
  applicationClientId: string;
  applicationClientSecret: string;
  resourceIdentifier: string;
}

export class EvalProvisioning {
  private readonly entities: Array<{ collection: Collection; id: string }> = [];

  constructor(private readonly zoneId: string, private readonly token: string) {}

  async create(collection: Collection, body: object): Promise<string> {
    const resp = await fetch(`${endpoint()}/zones/${this.zoneId}/${collection}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Create ${collection} failed: ${resp.status} ${await resp.text()}`);
    const { id } = (await resp.json()) as { id: string };
    this.entities.push({ collection, id });
    return id;
  }

  async sweepStale(now = Date.now()): Promise<void> {
    const headers = { Authorization: `Bearer ${this.token}` };
    const cutoff = now - STALE_AFTER_MS;
    for (const [collection, prefix] of [["resources", "eval-resource-"], ["applications", "eval-app-"]] as const) {
      const base = `${endpoint()}/zones/${this.zoneId}/${collection}`;
      const query = new URLSearchParams({ "query[name]": prefix, limit: "100" });
      const stale: ProvisioningPage["items"] = [];
      try {
        while (true) {
          const resp = await fetch(`${base}?${query}`, { headers });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const { items, pagination } = await resp.json() as ProvisioningPage;
          stale.push(...items.filter(({ name, created_at }) =>
            name.startsWith(prefix) && RUN_NAME.test(name.slice(prefix.length)) && Date.parse(created_at) < cutoff,
          ));
          const after = pagination?.after_cursor;
          if (!after || after === query.get("after")) break;
          query.set("after", after);
        }
      } catch (error) {
        console.warn(`Could not list stale eval ${collection}:`, error);
      }
      for (const { id, name } of stale) {
        try {
          const resp = await fetch(`${base}/${id}`, { method: "DELETE", headers });
          if (resp.status === 404) continue;
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          console.log(`   Removed stale eval ${collection}: ${name} (${id})`);
        } catch (error) {
          console.warn(`Could not remove stale eval ${collection}: ${name} (${id}):`, error);
        }
      }
    }
  }

  async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    for (const { collection, id } of [...this.entities].reverse()) {
      try {
        const resp = await fetch(`${endpoint()}/zones/${this.zoneId}/${collection}/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (!resp.ok && resp.status !== 404) {
          throw new Error(`Delete ${collection}/${id} failed: HTTP ${resp.status}`);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Resource cleanup failed");
    console.log(`   Cleaned up ${this.entities.length} eval applications and resources`);
  }
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
  provisioning: EvalProvisioning;
  templateDir: string;
  serverPort: number;
}): Promise<ProvisionedZone> {
  const { zoneId, zoneIssuerUrl, runId, token, provisioning, templateDir, serverPort: port } = opts;
  const resourceIdentifier = `${evalOrigin(runId, port)}/mcp`;

  // 1. Find the STS provider
  const stsProviderId = await getStsProviderId(zoneId, token);
  console.log(`   STS provider: ${stsProviderId}`);

  // 2. Use implicit consent so delegated exchanges do not need a second browser prompt.
  const applicationId = await provisioning.create("applications", {
    name: `eval-app-${runId}`, identifier: `eval-app-${runId}`, consent: "implicit",
  });
  console.log(`   Application: ${applicationId}`);

  // 2b. Mint a client credential for the application so a template that brokers delegated
  // access can authenticate its token exchange as this application (the secret is only
  // returned on creation). Templates that do not broker simply ignore it.
  const credResp = await fetch(`${endpoint()}/zones/${zoneId}/application-credentials`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ application_id: applicationId, type: "password" }),
  });
  if (!credResp.ok) {
    throw new Error(`Create application credential failed: ${credResp.status} ${await credResp.text()}`);
  }
  const { identifier: applicationClientId, password: applicationClientSecret } =
    (await credResp.json()) as { identifier?: string; password?: string };
  if (!applicationClientId || !applicationClientSecret) {
    throw new Error("Application credential response missing identifier/password");
  }
  console.log(`   Application credential: ${applicationClientId}`);

  // 3. Link the resource to the application for delegated token exchange.
  const resourceId = await provisioning.create("resources", {
    name: `eval-resource-${runId}`,
    identifier: resourceIdentifier,
    credential_provider_id: stsProviderId,
    scopes_supported: ["mcp:tools"],
    application_id: applicationId,
  });
  console.log(`   Resource: ${resourceId} (${resourceIdentifier})`);

  // 4. Write .env — all templates use KEYCARD_URL
  const envContent = [
    `KEYCARD_URL=${zoneIssuerUrl}`,
    `KEYCARD_RESOURCE_ID=${resourceIdentifier}`,
    `PORT=${port}`,
  ].join("\n") + "\n";
  await fs.writeFile(path.join(templateDir, ".env"), envContent, "utf8");
  console.log(`   Wrote .env`);

  // 5. Write keycard.toml in the CLI's shape for the eval zone
  await writeKeycardToml(templateDir, zoneId);
  console.log(`   Wrote keycard.toml`);

  return {
    applicationClientId,
    applicationClientSecret,
    resourceIdentifier,
  };
}
