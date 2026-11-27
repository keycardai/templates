import { pathToFileURL } from "node:url";
import { evalOrgId } from "./keycard-toml.js";
import { keycardEndpoint } from "./provision.js";
import { expectedEvalZone } from "./zone-expected.js";
import { getToken } from "./zone.js";

interface ZoneConfig {
  organization_id?: string;
  user_identity_provider_id?: string | null;
  requires_invitation?: boolean;
}

interface OAuthIssuer {
  protocols?: { oauth2?: { issuer?: string } };
}

interface IdentityProvider extends OAuthIssuer {
  identifier?: string;
  owner_type?: string;
}

interface EvalZoneState {
  identityProvider: "Organization Zone" | "Keycard ID" | "missing" | "different" | "not-keycard-id" | "unverified";
  requiresInvitation: boolean;
  testUserPresent: boolean;
}

export function findEvalZoneDrift(actual: EvalZoneState): string[] {
  const errors: string[] = [];
  if (actual.identityProvider === "missing") {
    errors.push(`Identity Provider (user_identity_provider_id): expected ${expectedEvalZone.identityProvider} for user sign-in; none is set.`);
  } else if (actual.identityProvider === "different") {
    errors.push(`Identity Provider (user_identity_provider_id): expected ${expectedEvalZone.identityProvider} for user sign-in.`);
  } else if (actual.identityProvider === "not-keycard-id") {
    errors.push(`Identity Provider (user_identity_provider_id): expected ${expectedEvalZone.organizationZoneIdentityProvider} for user sign-in in the Organization Zone.`);
  }
  if (actual.requiresInvitation !== expectedEvalZone.requiresInvitation) {
    errors.push(`Invitation requirement (requires_invitation): expected ${expectedEvalZone.requiresInvitation}.`);
  }
  if (actual.testUserPresent !== expectedEvalZone.testUserPresent) {
    errors.push("Test user: expected the user identified by EVAL_TEST_USER_EMAIL to exist in the eval zone.");
  }
  return errors;
}

class PreflightError extends Error {}

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new PreflightError(`Missing required environment variable ${name}.`);
  return value;
}

async function read<T>(path: string, token: string, label: string): Promise<T> {
  try {
    const response = await fetch(`${keycardEndpoint()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
    });
    if (!response.ok) throw new PreflightError(`Could not read ${label}: HTTP ${response.status}.`);
    return await response.json() as T;
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    throw new PreflightError(`Could not read ${label} from the management API.`);
  }
}

async function readIdentityProvider(
  zoneId: string,
  zonePath: string,
  zone: ZoneConfig,
  token: string,
): Promise<{ identityProvider: EvalZoneState["identityProvider"]; warning?: string }> {
  if (!zone.user_identity_provider_id) return { identityProvider: "missing" };

  const provider = await read<IdentityProvider>(`${zonePath}/providers/${encodeURIComponent(zone.user_identity_provider_id)}`, token, "the Identity Provider");
  const providerIssuer = provider.protocols?.oauth2?.issuer?.replace(/\/+$/, "");

  try {
    const orgId = zone.organization_id?.trim() || await evalOrgId();
    if (!orgId) throw new PreflightError("the eval zone's organization ID is unavailable.");
    const organization = await read<{ zone_id?: string }>(`/organizations/${encodeURIComponent(orgId)}`, token, "the eval zone's organization");
    if (!organization?.zone_id) throw new PreflightError("the organization response has no zone_id.");
    // The eval can run in the Organization Zone itself, whose Identity Provider is Keycard ID.
    if (organization.zone_id === zoneId) {
      const isKeycardId = provider.owner_type === "platform" && provider.identifier === "keycard-id" && Boolean(providerIssuer);
      return { identityProvider: isKeycardId ? "Keycard ID" : "not-keycard-id" };
    }
    const orgZone = await read<OAuthIssuer>(`/zones/${encodeURIComponent(organization.zone_id)}`, token, "the Organization Zone");
    const orgIssuer = orgZone?.protocols?.oauth2?.issuer?.replace(/\/+$/, "");
    if (!orgIssuer) throw new PreflightError("the Organization Zone's OAuth issuer is unavailable.");
    return { identityProvider: providerIssuer === orgIssuer ? "Organization Zone" : "different" };
  } catch (error) {
    if (!(error instanceof PreflightError)) throw error;
    return {
      identityProvider: "unverified",
      warning: `Could not verify that the Identity Provider is the Organization Zone (${error.message.replace(/\.$/, "")}).`,
    };
  }
}

export async function checkEvalZone(): Promise<{ errors: string[]; warnings: string[] }> {
  const zoneId = required("EVAL_ZONE_ID").trim();
  const zonePath = `/zones/${encodeURIComponent(zoneId)}`;
  const email = required("EVAL_TEST_USER_EMAIL");
  required("CI_KEYCARD_ENDPOINT");
  required("CI_KEYCARD_CLIENT_ID");
  required("CI_KEYCARD_CLIENT_SECRET");
  let token: string;
  try {
    token = await getToken();
  } catch {
    throw new PreflightError("Could not exchange CI credentials for a management API token.");
  }
  if (!token) throw new PreflightError("Management API token exchange returned no access token.");

  const zone = await read<ZoneConfig>(zonePath, token, "the eval zone");
  const userQuery = new URLSearchParams({ "filter[email]": email, limit: "1" });
  const [{ identityProvider, warning }, users] = await Promise.all([
    readIdentityProvider(zoneId, zonePath, zone, token),
    read<{ items: Array<{ email?: string }> }>(`${zonePath}/users?${userQuery}`, token, "users in the eval zone"),
  ]);
  const errors = findEvalZoneDrift({
    identityProvider,
    // The API removed this field. Older versions only returned it when no IdP was configured.
    requiresInvitation: zone.requires_invitation ?? false,
    testUserPresent: users.items.some((user) => user.email?.trim().toLowerCase() === email.trim().toLowerCase()),
  });
  return { errors, warnings: warning ? [warning] : [] };
}

async function main(): Promise<void> {
  try {
    const { errors, warnings } = await checkEvalZone();
    for (const warning of warnings) console.warn(`::warning::Eval zone preflight: ${warning}`);
    if (errors.length === 0) {
      console.log("Eval zone preflight passed.");
      return;
    }
    for (const error of errors) console.error(`::error::Eval zone preflight: ${error}`);
  } catch (error) {
    const message = error instanceof PreflightError ? error.message : "Could not verify the eval zone configuration.";
    console.error(`::error::Eval zone preflight: ${message}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
