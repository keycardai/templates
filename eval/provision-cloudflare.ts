import { keycardEndpoint } from "./provision.js";
import { getStsProviderId } from "./zone.js";
import { ensureEvalImpersonationPermit } from "./policy.js";

export function cloudflareProvisioning(zoneId: string, token: string) {
  const base = `${keycardEndpoint()}/zones/${zoneId}`;
  const authorization = { Authorization: `Bearer ${token}` };
  const created: { collection: string; id: string }[] = [];

  async function create<T extends { id: string }>(collection: string, body: object): Promise<T> {
    const response = await fetch(`${base}/${collection}`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = collection === "application-credentials" && "password" === (body as { type?: string }).type
        ? "" : ` ${await response.text()}`;
      throw new Error(`Create ${collection} failed: ${response.status}${detail}`);
    }
    const result = await response.json() as T;
    if (!result.id) throw new Error(`Create ${collection} response missing id`);
    created.push({ collection, id: result.id });
    return result;
  }

  return {
    async provision(opts: { runId: string; workerResource: string; downstreamResource: string }) {
      const provider = await getStsProviderId(zoneId, token);
      const appName = `eval-app-${opts.runId}`;
      const application = await create("applications", {
        name: appName,
        identifier: appName,
        consent: "implicit",
      });
      const harnessCredential = await create<{ id: string; identifier?: string; password?: string }>(
        "application-credentials",
        { application_id: application.id, type: "password" },
      );
      if (!harnessCredential.identifier || !harnessCredential.password) {
        throw new Error("Harness credential response missing identifier/password");
      }

      for (const [name, identifier, owned] of [
        ["worker", opts.workerResource, true],
        ["downstream", opts.downstreamResource, false],
      ] as const) {
        const resource = await create("resources", {
          name: `eval-resource-${name}-${opts.runId}`,
          identifier,
          credential_provider_id: provider,
          application_type: "native",
          prefix: false,
          ...(owned ? { application_id: application.id } : {}),
        });
        const response = await fetch(`${base}/applications/${application.id}/dependencies/${resource.id}`, {
          method: "PUT",
          headers: authorization,
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Add ${name} dependency failed: ${response.status} ${await response.text()}`);
      }
      await ensureEvalImpersonationPermit(zoneId, token);
      return {
        applicationId: application.id,
        clientId: harnessCredential.identifier,
        clientSecret: harnessCredential.password,
      };
    },
    async registerPublicKey(applicationId: string, identifier: string, jwksUri: string) {
      await create("application-credentials", {
        application_id: applicationId,
        type: "public-key",
        identifier,
        jwks_uri: jwksUri,
      });
    },
    async cleanup(): Promise<boolean> {
      let clean = true;
      // Delete both credentials, then their application, then the resources
      // that were owned by or depended on by the application.
      for (const kind of ["application-credentials", "applications", "resources"]) {
        for (const { collection, id } of created.filter((item) => item.collection === kind)) {
          try {
            const response = await fetch(`${base}/${collection}/${id}`, {
              method: "DELETE",
              headers: authorization,
              signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok && response.status !== 404) throw new Error(String(response.status));
          } catch {
            clean = false;
            console.error(`Cleanup failed for ${collection}/${id}`);
          }
        }
      }
      return clean;
    },
  };
}
