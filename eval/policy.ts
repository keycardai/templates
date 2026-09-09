/**
 * Standing customer policy that permits impersonation for eval applications.
 *
 * Since svc-pdp #220 (ACC-980) the managed default-app-direct-access policy
 * permits dependency-based access only when context.on_behalf and
 * context.impersonate are both false, and no managed policy permits
 * impersonation at all: a zone that wants it has to grant it with a customer
 * policy. The eval zone is persistent and its runs are weekly, so the permit is
 * looked up by name and only created when missing. It is scoped to the
 * eval-app-<runId> identifiers provisioning gives every run's application, so
 * it covers every run without per-run churn and grants nothing to any other
 * application in the zone.
 */

import { keycardEndpoint } from "./provision.js";

export const EVAL_IMPERSONATION_POLICY_NAME = "eval-impersonation-permit";
export const EVAL_POLICY_SET_NAME = "eval-policy-set";

/** Oldest schema that carries the identifier attribute on principals. */
const MIN_SCHEMA_VERSION = "2026-03-16";

/** Adapted from svc-pdp integration/policies_test.go cedarPermitImpersonation. */
export const EVAL_IMPERSONATION_CEDAR = `@id("${EVAL_IMPERSONATION_POLICY_NAME}")
permit(
  principal is Keycard::Application,
  action,
  resource
) when {
  context has impersonate && context.impersonate == true &&
  principal has identifier && principal.identifier like "eval-app-*"
};`;

interface Policy {
  id: string;
  name: string;
  latest_version_id?: string | null;
}

interface PolicySet {
  id: string;
  name: string;
  owner_type: "platform" | "customer";
}

interface ManifestEntry {
  policy_id: string;
  policy_version_id: string;
}

interface PolicySetVersion {
  id: string;
  policy_set_id: string;
  schema_version: string;
  manifest: { entries: ManifestEntry[] };
  active?: boolean;
}

interface Page<T> {
  items: T[];
}

async function api<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const resp = await fetch(`${keycardEndpoint()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await resp.text();
  if (!resp.ok && resp.status !== 403) {
    throw new Error(`${method} ${path} failed: ${resp.status} ${text}`);
  }
  return { status: resp.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function findPolicyByName(zoneId: string, token: string, name: string): Promise<Policy | undefined> {
  // query[name] is a substring match, so pin the exact name client-side.
  const { body } = await api<Page<Policy>>(
    token,
    "GET",
    `/zones/${zoneId}/policies?query[name]=${encodeURIComponent(name)}&limit=100`,
  );
  return body.items.find((p) => p.name === name);
}

async function findActivePolicySetVersion(
  zoneId: string,
  token: string,
): Promise<{ set: PolicySet; version: PolicySetVersion } | undefined> {
  const { body: sets } = await api<Page<PolicySet>>(
    token,
    "GET",
    `/zones/${zoneId}/policy-sets?filter[active]=true&filter[target_type]=zone&limit=100`,
  );
  for (const set of sets.items) {
    const { body: versions } = await api<Page<PolicySetVersion>>(
      token,
      "GET",
      `/zones/${zoneId}/policy-sets/${set.id}/versions?limit=100`,
    );
    const active = versions.items.find((v) => v.active);
    if (active) {
      // The list omits the manifest; the single-version read carries it.
      const { body: version } = await api<PolicySetVersion>(
        token,
        "GET",
        `/zones/${zoneId}/policy-sets/${set.id}/versions/${active.id}`,
      );
      return { set, version };
    }
  }
  return undefined;
}

/** Set names are unique per zone, so a leftover from an interrupted run is reused. */
async function findOrCreateCustomerPolicySet(zoneId: string, token: string): Promise<string> {
  const { body } = await api<Page<PolicySet>>(
    token,
    "GET",
    `/zones/${zoneId}/policy-sets?query[name]=${encodeURIComponent(EVAL_POLICY_SET_NAME)}&limit=100`,
  );
  const existing = body.items.find((s) => s.name === EVAL_POLICY_SET_NAME);
  if (existing) return existing.id;
  const { body: created } = await api<PolicySet>(token, "POST", `/zones/${zoneId}/policy-sets`, {
    name: EVAL_POLICY_SET_NAME,
    target_type: "zone",
  });
  return created.id;
}

/**
 * Make sure the zone carries the eval impersonation permit and that it is part
 * of the active zone policy set. Returns "found" when nothing had to change.
 *
 * Creation adds a new version to the active set that carries every entry of the
 * current active manifest plus the permit, then activates it. A platform-owned
 * active set rejects the version write with 403; in that case a customer set
 * with the same content is created and bound instead. Existing policies are
 * never modified or dropped.
 */
export async function ensureEvalImpersonationPermit(
  zoneId: string,
  token: string,
): Promise<"found" | "created"> {
  const active = await findActivePolicySetVersion(zoneId, token);
  // Every manifest entry has to share the set's schema version, so the permit
  // follows the active set. Older schemas have no identifier attribute, which
  // the permit's scoping needs.
  const schemaVersion = active?.version.schema_version ?? MIN_SCHEMA_VERSION;
  if (schemaVersion < MIN_SCHEMA_VERSION) {
    throw new Error(
      `Active policy set pins schema ${schemaVersion}; the eval permit needs ${MIN_SCHEMA_VERSION} or newer`,
    );
  }

  let policy = await findPolicyByName(zoneId, token, EVAL_IMPERSONATION_POLICY_NAME);
  let changed = false;
  if (!policy) {
    const created = await api<Policy>(token, "POST", `/zones/${zoneId}/policies`, {
      name: EVAL_IMPERSONATION_POLICY_NAME,
      description:
        "Permits impersonation for eval-app-* applications provisioned by the templates eval harness (ECO-385, ACC-980).",
    });
    policy = created.body;
    changed = true;
  }

  let versionId = policy.latest_version_id ?? undefined;
  if (!versionId) {
    const created = await api<{ id: string }>(
      token,
      "POST",
      `/zones/${zoneId}/policies/${policy.id}/versions`,
      { cedar_raw: EVAL_IMPERSONATION_CEDAR, schema_version: schemaVersion },
    );
    versionId = created.body.id;
    changed = true;
  }

  const entries = active?.version.manifest.entries ?? [];
  if (entries.some((e) => e.policy_id === policy.id)) {
    return changed ? "created" : "found";
  }

  const manifest = { entries: [...entries, { policy_id: policy.id, policy_version_id: versionId }] };
  let setId = active?.set.id;
  let newVersion: PolicySetVersion | undefined;
  if (setId) {
    const resp = await api<PolicySetVersion>(
      token,
      "POST",
      `/zones/${zoneId}/policy-sets/${setId}/versions`,
      { manifest, schema_version: schemaVersion },
    );
    if (resp.status !== 403) newVersion = resp.body;
  }
  if (!newVersion) {
    setId = await findOrCreateCustomerPolicySet(zoneId, token);
    const resp = await api<PolicySetVersion>(
      token,
      "POST",
      `/zones/${zoneId}/policy-sets/${setId}/versions`,
      { manifest, schema_version: schemaVersion },
    );
    if (resp.status === 403) {
      throw new Error(`Create policy set version on ${setId} failed: 403 ${JSON.stringify(resp.body)}`);
    }
    newVersion = resp.body;
  }

  const patch = await api<PolicySetVersion>(
    token,
    "PATCH",
    `/zones/${zoneId}/policy-sets/${setId}/versions/${newVersion.id}`,
    { active: true },
  );
  if (patch.status === 403) {
    throw new Error(`Activate policy set version ${newVersion.id} failed: 403 ${JSON.stringify(patch.body)}`);
  }
  return "created";
}
