/**
 * Provisioning for an outbound-auth agent template.
 *
 * The server templates need one resource: the thing the client authenticates
 * to. An agent needs two, and both matter:
 *
 * - The resource it calls (here the local calendar stub, standing in for the
 *   Google Calendar resource SPEC.md installs from the catalog), granted to the
 *   agent application as a dependency.
 * - A resource the application itself owns (SPEC.md section 1c). The zone only
 *   lets an application exchange a subject token whose first audience is one of
 *   its own resources, so without it every delegated exchange fails with
 *   `invalid_grant`. It is the same invariant an MCP server satisfies by being
 *   the audience of the token it receives.
 *
 * Both are zone-native, so both take the Zone Provider. That is also what makes
 * the eval verifiable end to end: the credential minted for the calendar
 * resource is a zone-issued JWT, which the stub can verify against the zone's
 * published keys.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { keycardEndpoint, findResourceIdByIdentifier, type ProvisionedZone } from "./provision.js";

export interface ProvisionedAgent extends ProvisionedZone {
  /** Identifier of the resource the application owns, the exchange's first audience. */
  agentResourceIdentifier: string;
  agentResourceId: string;
}

async function getZoneProviderId(zoneId: string, token: string): Promise<string> {
  const resp = await fetch(`${keycardEndpoint()}/zones/${zoneId}/providers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`List providers failed: ${resp.status} ${await resp.text()}`);
  const { items } = (await resp.json()) as { items: Array<{ id: string; name: string; type?: string }> };
  const zoneProvider = items.find(
    (p) => p.type === "keycard-sts" || p.name?.toLowerCase() === "zone provider",
  );
  if (!zoneProvider) {
    throw new Error(`No Zone Provider found. Providers: ${JSON.stringify(items.map((p) => p.name))}`);
  }
  return zoneProvider.id;
}

/** Create a zone-native resource, replacing any leftover with the same identifier. */
async function createResource(opts: {
  zoneId: string;
  token: string;
  name: string;
  identifier: string;
  providerId: string;
  applicationId?: string;
}): Promise<string> {
  const stale = await findResourceIdByIdentifier(opts.zoneId, opts.token, opts.identifier);
  if (stale) {
    await fetch(`${keycardEndpoint()}/zones/${opts.zoneId}/resources/${stale}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${opts.token}` },
    });
  }

  const resp = await fetch(`${keycardEndpoint()}/zones/${opts.zoneId}/resources`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: opts.name,
      identifier: opts.identifier,
      credential_provider_id: opts.providerId,
      application_type: "native",
      // The tool calls a path under the resource identifier, so the grant has
      // to cover the whole prefix rather than the bare base URL.
      prefix: true,
      ...(opts.applicationId ? { application_id: opts.applicationId } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`Create resource ${opts.identifier} failed: ${resp.status} ${await resp.text()}`);
  const { id } = (await resp.json()) as { id: string };
  return id;
}

export async function provisionAgent(opts: {
  zoneId: string;
  zoneIssuerUrl: string;
  runId: string;
  token: string;
  templateDir: string;
  /** Base URL of the local calendar stub, registered as the resource the agent calls. */
  calendarResourceIdentifier: string;
  /** Base URL `langgraph dev` serves on, registered as the application's own resource. */
  agentResourceIdentifier: string;
  anthropicApiKey: string;
  anthropicModel: string;
}): Promise<ProvisionedAgent> {
  const { zoneId, zoneIssuerUrl, runId, token, templateDir } = opts;
  const zoneProviderId = await getZoneProviderId(zoneId, token);
  console.log(`   Zone provider: ${zoneProviderId}`);

  // The eval has no browser, so no one can click through a consent screen.
  // consent: "implicit" pre-authorizes the application; SPEC.md keeps the
  // default for the shipped template because the consent screen is part of the
  // product demo, but it would deadlock a headless run.
  const appResp = await fetch(`${keycardEndpoint()}/zones/${zoneId}/applications`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `eval-app-${runId}`,
      identifier: `eval-app-${runId}`,
      consent: "implicit",
    }),
  });
  if (!appResp.ok) throw new Error(`Create application failed: ${appResp.status} ${await appResp.text()}`);
  const { id: applicationId } = (await appResp.json()) as { id: string };
  console.log(`   Application: ${applicationId}`);

  const credResp = await fetch(`${keycardEndpoint()}/zones/${zoneId}/application-credentials`, {
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

  const agentResourceId = await createResource({
    zoneId,
    token,
    name: `eval-resource-agent-${runId}`,
    identifier: opts.agentResourceIdentifier,
    providerId: zoneProviderId,
    applicationId,
  });
  console.log(`   Agent resource: ${agentResourceId} (${opts.agentResourceIdentifier})`);

  const calendarResourceId = await createResource({
    zoneId,
    token,
    name: `eval-resource-calendar-${runId}`,
    identifier: opts.calendarResourceIdentifier,
    providerId: zoneProviderId,
  });
  console.log(`   Calendar resource: ${calendarResourceId} (${opts.calendarResourceIdentifier})`);

  // Grant the calendar resource to the application (SPEC.md section 1d).
  const depResp = await fetch(
    `${keycardEndpoint()}/zones/${zoneId}/applications/${applicationId}/dependencies/${calendarResourceId}`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!depResp.ok) {
    throw new Error(`Add dependency failed: ${depResp.status} ${await depResp.text()}`);
  }
  console.log("   Dependency: application -> calendar resource");

  // The impersonation mint targets the agent resource, and the zone's managed
  // policies only permit impersonation of a resource registered as a
  // dependency of the application (default-app-direct-access). Without this,
  // the substitute-user exchange is denied.
  const agentDepResp = await fetch(
    `${keycardEndpoint()}/zones/${zoneId}/applications/${applicationId}/dependencies/${agentResourceId}`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!agentDepResp.ok) {
    throw new Error(
      `Add agent dependency failed: ${agentDepResp.status} ${await agentDepResp.text()}`,
    );
  }
  console.log("   Dependency: application -> agent resource (impersonation permit)");

  // KEYCARD_SUBJECT_TOKEN is deliberately absent here: index.ts appends the
  // impersonated token once the zone has minted it, exactly where signin.py
  // would have written it.
  const envContent = [
    `KEYCARD_ZONE_URL=${zoneIssuerUrl}`,
    `KEYCARD_RESOURCE=${opts.calendarResourceIdentifier}`,
    `KEYCARD_AGENT_RESOURCE=${opts.agentResourceIdentifier}`,
    `KEYCARD_CLIENT_ID=${applicationClientId}`,
    `KEYCARD_CLIENT_SECRET=${applicationClientSecret}`,
    `ANTHROPIC_API_KEY=${opts.anthropicApiKey}`,
    `ANTHROPIC_MODEL=${opts.anthropicModel}`,
  ].join("\n") + "\n";
  await fs.writeFile(path.join(templateDir, ".env"), envContent, "utf8");
  console.log("   Wrote .env");

  return {
    zoneId,
    zoneIssuerUrl,
    applicationId,
    applicationClientId,
    applicationClientSecret,
    resourceId: calendarResourceId,
    resourceIdentifier: opts.calendarResourceIdentifier,
    agentResourceId,
    agentResourceIdentifier: opts.agentResourceIdentifier,
  };
}

/** Delete both resources and the application created for an agent run. */
export async function teardownAgentProvisioning(
  provisioned: ProvisionedAgent,
  token: string,
): Promise<void> {
  const headers = { Authorization: `Bearer ${token}` };
  const base = `${keycardEndpoint()}/zones/${provisioned.zoneId}`;
  await Promise.all([
    fetch(`${base}/applications/${provisioned.applicationId}`, { method: "DELETE", headers }),
    fetch(`${base}/resources/${provisioned.resourceId}`, { method: "DELETE", headers }),
    fetch(`${base}/resources/${provisioned.agentResourceId}`, { method: "DELETE", headers }),
  ]);
}
