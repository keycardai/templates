import assert from "node:assert/strict";
import test from "node:test";
import { checkEvalZone, findEvalZoneDrift } from "./preflight.js";
import { expectedEvalZone } from "./zone-expected.js";
import { getOrCreateEvalZone } from "./zone.js";

test("the expected zone config passes", () => {
  assert.deepEqual(findEvalZoneDrift(expectedEvalZone), []);
});

test("reports one line per mismatch without identifying the test user", () => {
  assert.deepEqual(findEvalZoneDrift({
    identityProvider: "missing",
    requiresInvitation: true,
    testUserPresent: false,
  }), [
    "Identity Provider (user_identity_provider_id): expected Organization Zone for user sign-in; none is set.",
    "Invitation requirement (requires_invitation): expected false.",
    "Test user: expected the user identified by EVAL_TEST_USER_EMAIL to exist in the eval zone.",
  ]);
});

test("reads the configured provider issuer, organization zone issuer, and exact email match", async (t) => {
  const env = {
    CI_KEYCARD_CLIENT_ID: "fixture-client",
    CI_KEYCARD_CLIENT_SECRET: "fixture-secret",
    CI_KEYCARD_ENDPOINT: "https://api.example.com",
    EVAL_ORG_ID: "fallback-org",
    EVAL_TEST_USER_EMAIL: "Test+Eval@example.com",
    EVAL_ZONE_ID: "eval-zone",
  };
  const previous = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => {
    for (const name of Object.keys(env)) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });

  const issuer = "https://org-zone.example.com";
  let providerIssuer = issuer;
  let providerOwner = "customer";
  let providerIdentifier = "custom-provider";
  let userIdentityProviderId: string | undefined = "eval-provider";
  let organizationId: string | undefined = "fixture-org";
  let organizationReadable = true;
  let organizationZoneId = "org-zone";
  let orgZoneReadable = true;
  let providerReadable = true;
  const seen = new Set<string>();
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.origin, env.CI_KEYCARD_ENDPOINT);
    seen.add(url.pathname);
    if (url.pathname === "/service-account-token") {
      assert.equal(init.method, "POST");
      assert.equal(String(init.body), "grant_type=client_credentials&client_id=fixture-client&client_secret=fixture-secret");
      return Response.json({ access_token: "fixture-token" });
    }
    assert.equal(init.method ?? "GET", "GET");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer fixture-token");
    switch (url.pathname) {
      case "/zones/eval-zone":
        return Response.json({ organization_id: organizationId, user_identity_provider_id: userIdentityProviderId });
      case "/zones/eval-zone/providers/eval-provider":
        if (!providerReadable) return new Response(null, { status: 403 });
        return Response.json({
          identifier: providerIdentifier,
          owner_type: providerOwner,
          protocols: { oauth2: { issuer: providerIssuer } },
        });
      case "/organizations/fixture-org":
      case "/organizations/fallback-org":
        if (!organizationReadable) return new Response(null, { status: 403 });
        return Response.json({ zone_id: organizationZoneId });
      case "/zones/org-zone":
        if (!orgZoneReadable) return new Response(null, { status: 404 });
        return Response.json({ protocols: { oauth2: { issuer } } });
      case "/zones/eval-zone/users":
        assert.equal(url.searchParams.get("filter[email]"), env.EVAL_TEST_USER_EMAIL);
        return Response.json({ items: [{ email: "test+EVAL@example.com" }] });
      default:
        throw new Error("Unexpected management API path");
    }
  });

  const pass = { errors: [], warnings: [] };
  assert.deepEqual(await checkEvalZone(), pass);
  assert.deepEqual(seen, new Set([
    "/service-account-token",
    "/zones/eval-zone",
    "/zones/eval-zone/providers/eval-provider",
    "/organizations/fixture-org",
    "/zones/org-zone",
    "/zones/eval-zone/users",
  ]));

  process.env.EVAL_ZONE_ID = ` ${env.EVAL_ZONE_ID}\n`;
  assert.deepEqual(await checkEvalZone(), pass);
  const evalZone = await getOrCreateEvalZone("fixture-run");
  assert.equal(evalZone.zone.id, env.EVAL_ZONE_ID);
  assert.equal(evalZone.ephemeral, false);
  process.env.EVAL_ZONE_ID = env.EVAL_ZONE_ID;

  providerIssuer = `${issuer}/`;
  assert.deepEqual(await checkEvalZone(), pass);

  organizationId = undefined;
  seen.clear();
  assert.deepEqual(await checkEvalZone(), pass);
  assert.ok(seen.has("/organizations/fallback-org"));

  organizationZoneId = "eval-zone";
  providerIssuer = "https://id.keycard.ai";
  providerOwner = "platform";
  providerIdentifier = "keycard-id";
  seen.clear();
  assert.deepEqual(await checkEvalZone(), pass);
  assert.ok(!seen.has("/zones/org-zone"));

  const keycardIdError = {
    errors: ["Identity Provider (user_identity_provider_id): expected Keycard ID for user sign-in in the Organization Zone."],
    warnings: [],
  };
  providerIdentifier = "other-platform-provider";
  assert.deepEqual(await checkEvalZone(), keycardIdError);
  providerIdentifier = "keycard-id";
  providerOwner = "customer";
  providerIssuer = "https://sso.example.com";
  assert.deepEqual(await checkEvalZone(), keycardIdError);
  providerOwner = "platform";
  providerIssuer = "";
  assert.deepEqual(await checkEvalZone(), keycardIdError);
  organizationZoneId = "org-zone";

  providerIssuer = "https://other-zone.example.com";
  const identityProviderError = "Identity Provider (user_identity_provider_id): expected Organization Zone for user sign-in.";
  assert.deepEqual(await checkEvalZone(), { errors: [identityProviderError], warnings: [] });

  providerIssuer = issuer;
  organizationReadable = false;
  assert.deepEqual(await checkEvalZone(), {
    errors: [],
    warnings: ["Could not verify that the Identity Provider is the Organization Zone (Could not read the eval zone's organization: HTTP 403)."],
  });
  organizationReadable = true;
  orgZoneReadable = false;
  assert.deepEqual(await checkEvalZone(), {
    errors: [],
    warnings: ["Could not verify that the Identity Provider is the Organization Zone (Could not read the Organization Zone: HTTP 404)."],
  });

  delete process.env.EVAL_ORG_ID;
  seen.clear();
  assert.deepEqual(await checkEvalZone(), {
    errors: [],
    warnings: ["Could not verify that the Identity Provider is the Organization Zone (the eval zone's organization ID is unavailable)."],
  });
  assert.deepEqual(seen, new Set(["/service-account-token", "/zones/eval-zone", "/zones/eval-zone/providers/eval-provider", "/zones/eval-zone/users"]));

  providerReadable = false;
  await assert.rejects(checkEvalZone(), { message: "Could not read the Identity Provider: HTTP 403." });

  userIdentityProviderId = undefined;
  seen.clear();
  assert.deepEqual(await checkEvalZone(), {
    errors: ["Identity Provider (user_identity_provider_id): expected Organization Zone for user sign-in; none is set."],
    warnings: [],
  });
  assert.deepEqual(seen, new Set(["/service-account-token", "/zones/eval-zone", "/zones/eval-zone/users"]));
});
