/**
 * Provisioning for an inbound-auth A2A agent template.
 *
 * An A2A agent is a server other agents call, so what it needs from the zone
 * is what an MCP server needs: a resource whose identifier is the URL it
 * serves on, so a caller can hold a zone token audienced at it. Two things
 * differ from provision.ts:
 *
 * - The resource is owned by the agent's own application, and the application
 *   has an impersonation permit, because the harness has no browser and mints
 *   the caller's user token by impersonation (impersonate.ts). The zone only
 *   lets an application mint a subject token whose first audience is a
 *   resource it owns.
 * - A second resource, not the agent, is provisioned too. A token minted for
 *   it is the negative control for the agent's audience check: the agent
 *   must refuse it even though the same zone issued it.
 *
 * Both are zone-native, so both take the Zone Provider. The template's own
 * SPEC.md provisions a public-key credential and a Snowflake resource for the
 * agent's outbound leg; neither is exercised here (the agent boots degraded by
 * design), so neither is provisioned.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeKeycardToml } from "./keycard-toml.js";
import { keycardEndpoint, findResourceIdByIdentifier } from "./provision.js";
import { ensureEvalImpersonationPermit, EVAL_IMPERSONATION_POLICY_NAME } from "./policy.js";

export interface ProvisionedA2AAgent {
  zoneId: string;
  zoneIssuerUrl: string;
  applicationId: string;
  applicationClientId: string;
  applicationClientSecret: string;
  /** The agent's own resource: its base URL, and the audience its verifier is bound to. */
  agentResourceId: string;
  agentResourceIdentifier: string;
  /** A resource the agent does not serve; tokens for it must be refused. */
  otherResourceId: string;
  otherResourceIdentifier: string;
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

async function createResource(opts: {
  zoneId: string;
  token: string;
  name: string;
  identifier: string;
  providerId: string;
  applicationId: string;
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
      prefix: true,
      application_id: opts.applicationId,
    }),
  });
  if (!resp.ok) throw new Error(`Create resource ${opts.identifier} failed: ${resp.status} ${await resp.text()}`);
  const { id } = (await resp.json()) as { id: string };
  return id;
}

async function addDependency(zoneId: string, token: string, applicationId: string, resourceId: string) {
  const resp = await fetch(
    `${keycardEndpoint()}/zones/${zoneId}/applications/${applicationId}/dependencies/${resourceId}`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) throw new Error(`Add dependency failed: ${resp.status} ${await resp.text()}`);
}

export async function provisionA2AAgent(opts: {
  zoneId: string;
  zoneIssuerUrl: string;
  runId: string;
  token: string;
  templateDir: string;
  /** Base URL the agent serves on; registered as its resource and written as AGENT_BASE_URL. */
  agentBaseUrl: string;
  port: number;
}): Promise<ProvisionedA2AAgent> {
  const { zoneId, zoneIssuerUrl, runId, token, templateDir } = opts;
  const zoneProviderId = await getZoneProviderId(zoneId, token);
  console.log(`   Zone provider: ${zoneProviderId}`);

  // consent: "implicit", as in provision-agent.ts: no browser, so no consent screen.
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
    zoneId, token, providerId: zoneProviderId, applicationId,
    name: `eval-resource-agent-${runId}`,
    identifier: opts.agentBaseUrl,
  });
  console.log(`   Agent resource: ${agentResourceId} (${opts.agentBaseUrl})`);

  const otherResourceIdentifier = `http://localhost:${opts.port + 1}`;
  const otherResourceId = await createResource({
    zoneId, token, providerId: zoneProviderId, applicationId,
    name: `eval-resource-other-${runId}`,
    identifier: otherResourceIdentifier,
  });
  console.log(`   Other resource: ${otherResourceId} (${otherResourceIdentifier})`);

  // Impersonation targets each resource, so both have to be dependencies of
  // the application; the permit below is what authorizes the mint (ACC-980).
  await addDependency(zoneId, token, applicationId, agentResourceId);
  await addDependency(zoneId, token, applicationId, otherResourceId);
  console.log("   Dependencies: application -> agent resource, other resource");

  const permit = await ensureEvalImpersonationPermit(zoneId, token);
  console.log(`   Policy: ${EVAL_IMPERSONATION_POLICY_NAME} (${permit})`);

  // SNOWFLAKE_* stay unset on purpose: src/index.ts boots degraded without them.
  const envContent = [
    `KEYCARD_URL=${zoneIssuerUrl}`,
    `AGENT_BASE_URL=${opts.agentBaseUrl}`,
    `KEYCARD_RESOURCE_ID=${opts.agentBaseUrl}`,
    `PORT=${opts.port}`,
  ].join("\n") + "\n";
  await fs.writeFile(path.join(templateDir, ".env"), envContent, "utf8");
  console.log("   Wrote .env");
  await writeKeycardToml(templateDir, zoneId);
  console.log("   Wrote keycard.toml");

  return {
    zoneId,
    zoneIssuerUrl,
    applicationId,
    applicationClientId,
    applicationClientSecret,
    agentResourceId,
    agentResourceIdentifier: opts.agentBaseUrl,
    otherResourceId,
    otherResourceIdentifier,
  };
}

export async function teardownA2AProvisioning(
  provisioned: ProvisionedA2AAgent,
  token: string,
): Promise<void> {
  const headers = { Authorization: `Bearer ${token}` };
  const base = `${keycardEndpoint()}/zones/${provisioned.zoneId}`;
  await Promise.all([
    fetch(`${base}/applications/${provisioned.applicationId}`, { method: "DELETE", headers }),
    fetch(`${base}/resources/${provisioned.agentResourceId}`, { method: "DELETE", headers }),
    fetch(`${base}/resources/${provisioned.otherResourceId}`, { method: "DELETE", headers }),
  ]);
}

/**
 * Provisioning for the two-agent delegation template (ECO-102).
 *
 * Two applications and two resources, each agent owning its own URL as a
 * resource. The caller's application carries both resources as dependencies:
 * its own, because the harness impersonates the user against it (the mint's
 * first audience has to be a resource the application owns), and the
 * target's, because that is what authorizes the caller's RFC 8693 exchange of
 * the user's token for the target under the managed default-app-direct-access
 * policy (the same grant the agent flow relies on in provision-agent.ts). The
 * zone adds the caller's application identifier as the token's act.sub at
 * exchange time, so that identifier is what verification asserts on.
 */
export interface ProvisionedA2ADelegation {
  zoneId: string;
  zoneIssuerUrl: string;
  callerApplicationId: string;
  callerApplicationIdentifier: string;
  callerClientId: string;
  callerClientSecret: string;
  targetApplicationId: string;
  callerResourceId: string;
  callerResourceIdentifier: string;
  targetResourceId: string;
  targetResourceIdentifier: string;
}

async function createApplication(zoneId: string, token: string, identifier: string): Promise<string> {
  const resp = await fetch(`${keycardEndpoint()}/zones/${zoneId}/applications`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: identifier, identifier, consent: "implicit" }),
  });
  if (!resp.ok) throw new Error(`Create application ${identifier} failed: ${resp.status} ${await resp.text()}`);
  const { id } = (await resp.json()) as { id: string };
  return id;
}

async function createPasswordCredential(
  zoneId: string,
  token: string,
  applicationId: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const resp = await fetch(`${keycardEndpoint()}/zones/${zoneId}/application-credentials`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ application_id: applicationId, type: "password" }),
  });
  if (!resp.ok) throw new Error(`Create application credential failed: ${resp.status} ${await resp.text()}`);
  const { identifier, password } = (await resp.json()) as { identifier?: string; password?: string };
  if (!identifier || !password) throw new Error("Application credential response missing identifier/password");
  return { clientId: identifier, clientSecret: password };
}

export async function provisionA2ADelegation(opts: {
  zoneId: string;
  zoneIssuerUrl: string;
  runId: string;
  token: string;
  templateDir: string;
  callerBaseUrl: string;
  targetBaseUrl: string;
}): Promise<ProvisionedA2ADelegation> {
  const { zoneId, zoneIssuerUrl, runId, token, templateDir } = opts;
  const zoneProviderId = await getZoneProviderId(zoneId, token);
  console.log(`   Zone provider: ${zoneProviderId}`);

  const callerApplicationIdentifier = `eval-app-${runId}`;
  const callerApplicationId = await createApplication(zoneId, token, callerApplicationIdentifier);
  const caller = await createPasswordCredential(zoneId, token, callerApplicationId);
  console.log(`   Caller application: ${callerApplicationId} (${callerApplicationIdentifier}, credential ${caller.clientId})`);

  const targetApplicationId = await createApplication(zoneId, token, `eval-app-target-${runId}`);
  console.log(`   Target application: ${targetApplicationId}`);

  const callerResourceId = await createResource({
    zoneId, token, providerId: zoneProviderId, applicationId: callerApplicationId,
    name: `eval-resource-caller-${runId}`,
    identifier: opts.callerBaseUrl,
  });
  console.log(`   Caller resource: ${callerResourceId} (${opts.callerBaseUrl})`);
  const targetResourceId = await createResource({
    zoneId, token, providerId: zoneProviderId, applicationId: targetApplicationId,
    name: `eval-resource-target-${runId}`,
    identifier: opts.targetBaseUrl,
  });
  console.log(`   Target resource: ${targetResourceId} (${opts.targetBaseUrl})`);

  await addDependency(zoneId, token, callerApplicationId, callerResourceId);
  await addDependency(zoneId, token, callerApplicationId, targetResourceId);
  console.log("   Dependencies: caller application -> caller resource, target resource");

  const permit = await ensureEvalImpersonationPermit(zoneId, token);
  console.log(`   Policy: ${EVAL_IMPERSONATION_POLICY_NAME} (${permit})`);

  const envContent = [
    `KEYCARD_URL=${zoneIssuerUrl}`,
    `KEYCARD_CLIENT_ID=${caller.clientId}`,
    `KEYCARD_CLIENT_SECRET=${caller.clientSecret}`,
    `CALLER_BASE_URL=${opts.callerBaseUrl}`,
    `TARGET_BASE_URL=${opts.targetBaseUrl}`,
  ].join("\n") + "\n";
  await fs.writeFile(path.join(templateDir, ".env"), envContent, "utf8");
  console.log("   Wrote .env");
  await writeKeycardToml(templateDir, zoneId);
  console.log("   Wrote keycard.toml");

  return {
    zoneId,
    zoneIssuerUrl,
    callerApplicationId,
    callerApplicationIdentifier,
    callerClientId: caller.clientId,
    callerClientSecret: caller.clientSecret,
    targetApplicationId,
    callerResourceId,
    callerResourceIdentifier: opts.callerBaseUrl,
    targetResourceId,
    targetResourceIdentifier: opts.targetBaseUrl,
  };
}

export async function teardownA2ADelegation(
  provisioned: ProvisionedA2ADelegation,
  token: string,
): Promise<void> {
  const headers = { Authorization: `Bearer ${token}` };
  const base = `${keycardEndpoint()}/zones/${provisioned.zoneId}`;
  await Promise.all([
    fetch(`${base}/applications/${provisioned.callerApplicationId}`, { method: "DELETE", headers }),
    fetch(`${base}/applications/${provisioned.targetApplicationId}`, { method: "DELETE", headers }),
    fetch(`${base}/resources/${provisioned.callerResourceId}`, { method: "DELETE", headers }),
    fetch(`${base}/resources/${provisioned.targetResourceId}`, { method: "DELETE", headers }),
  ]);
}
