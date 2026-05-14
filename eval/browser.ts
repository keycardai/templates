/**
 * Playwright OAuth flow: navigate to the authorization URL, log in as the
 * test user, approve the consent screen, capture the authorization code
 * from the redirect, and exchange it for an access token.
 */

import { chromium } from "playwright";
import * as http from "node:http";
import * as crypto from "node:crypto";

const CALLBACK_PORT = 8888;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Start a local HTTP server on CALLBACK_PORT, return the first code it receives. */
function captureCallbackCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Authorization complete. You can close this tab.</body></html>");
      server.close();
      if (code) resolve(code);
      else reject(new Error(`No code in callback: ${req.url}`));
    });
    server.listen(CALLBACK_PORT);
    server.on("error", reject);
  });
}

export interface AuthResult {
  accessToken: string;
  idToken?: string;
}

/**
 * Handle Linear's OAuth authorization page if Keycard redirects there during
 * the dependency consent flow. Linear's auth page lives at linear.app/oauth
 * or auth.linear.app. We use the same credentials as the Keycard test user
 * since the eval uses a single personal account for both.
 */
async function handleLinearOAuthIfPresent(
  page: import("playwright").Page,
  email: string,
  password: string,
  callbackUrl: string,
): Promise<void> {
  if (!page.url().includes("linear.app")) return;

  console.log("   Linear OAuth page detected, authenticating...");

  // Linear shows an email input first, then password
  const emailInput = page.locator('input[type="email"], input[name="email"]');
  const continueBtn = page.locator('button[type="submit"]').first();

  if (await emailInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await emailInput.fill(email);
    await continueBtn.click();
  }

  const passwordInput = page.locator('input[type="password"]');
  if (await passwordInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await passwordInput.fill(password);
    await page.locator('button[type="submit"]').last().click();
  }

  // After login, Linear shows an "Authorize" button to approve scope access
  const authorizeBtn = page.locator('button:has-text("Authorize"), button:has-text("Allow"), button[type="submit"]').first();
  if (await authorizeBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await authorizeBtn.click();
  }

  // Wait to land back at callback or Keycard
  await Promise.race([
    page.waitForURL(`${callbackUrl}**`, { timeout: 30_000 }),
    page.waitForURL("**/keycard**", { timeout: 30_000 }),
    page.waitForURL("**keycard.cloud**", { timeout: 30_000 }),
  ]).catch(() => { /* may already be past this */ });
}

export async function authenticateViaOAuth(opts: {
  zoneIssuerUrl: string;
  resourceIdentifier: string;
  clientId: string;
  testUserEmail: string;
  testUserPassword: string;
  headless?: boolean;
}): Promise<AuthResult> {
  const { verifier, challenge } = generatePkce();
  const state = base64url(crypto.randomBytes(16));

  const authorizeUrl = new URL(`${opts.zoneIssuerUrl}/oauth/2/authorize`);
  authorizeUrl.searchParams.set("client_id", opts.clientId);
  authorizeUrl.searchParams.set("redirect_uri", CALLBACK_URL);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "openid email mcp:tools");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("resource", opts.resourceIdentifier);

  const codePromise = captureCallbackCode();

  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(authorizeUrl.toString());

    // May land on identifier page first, or skip straight to password page
    // depending on zone config and whether the browser has a prior session.
    const identifierInput = page.locator('input[name="identifier"]');
    const passwordInput = page.locator('input[name="password"]');

    // Wait for whichever shows up first
    await Promise.race([
      identifierInput.waitFor({ timeout: 15_000 }),
      passwordInput.waitFor({ timeout: 15_000 }),
    ]);

    if (await identifierInput.isVisible()) {
      await page.fill('input[name="identifier"]', opts.testUserEmail);
      await page.click('button[type="submit"]');
      await page.waitForSelector('input[name="password"]');
    }

    // Password page
    await page.fill('input[name="username"]', opts.testUserEmail);
    await page.fill('input[name="password"]', opts.testUserPassword);
    await page.click('button[type="submit"]');

    // After submitting credentials, wait to see where we land:
    // - /login/signup or /login/verify-email → new user, need to sign up
    // - consent page (button.btn-primary) → existing user, just approve
    // - callback URL → already authorized (rare)
    const silence = () => null;
    const postPasswordOutcome = await Promise.race([
      page.waitForURL(`${CALLBACK_URL}**`, { timeout: 45_000 }).then(() => "callback" as const).catch(silence),
      page.waitForURL("**/login/signup**", { timeout: 45_000 }).then(() => "signup" as const).catch(silence),
      page.waitForURL("**/login/verify-email**", { timeout: 45_000 }).then(() => "verify" as const).catch(silence),
      page.waitForURL("**/login/consent**", { timeout: 45_000 }).then(() => "consent-url" as const).catch(silence),
      page.waitForSelector(".consent-actions button.btn-primary", { timeout: 45_000 }).then(() => "consent" as const).catch(silence),
    ]);

    if (!postPasswordOutcome) {
      throw new Error(
        `OAuth flow stalled after password submission — unexpected page: ${page.url()}\n` +
        `Run with EVAL_HEADLESS=false to inspect the browser state.`,
      );
    }

    if (postPasswordOutcome === "signup" || postPasswordOutcome === "verify") {
      if (opts.headless === false) {
        console.log("\n  ⚠️  New user detected. Complete sign-up in the browser window.");
        console.log("     After signing up and verifying your email, the eval will continue automatically.\n");
        await page.waitForURL(`${CALLBACK_URL}**`, { timeout: 300_000 });
      } else {
        throw new Error(
          `Test user '${opts.testUserEmail}' does not have an account in this zone.\n` +
          `Run once with EVAL_HEADLESS=false to sign up and verify the account.`,
        );
      }
    } else if (postPasswordOutcome === "consent" || postPasswordOutcome === "consent-url") {
      await page.waitForSelector(".consent-actions button.btn-primary", { timeout: 10_000 });
      await page.click(".consent-actions button.btn-primary");

      // For brokered-credentials templates, Keycard may redirect to Linear's OAuth
      // page to obtain a Linear token as part of the dependency consent chain.
      // We wait briefly to see if the URL moves to linear.app before waiting for callback.
      await page.waitForTimeout(2_000);
      await handleLinearOAuthIfPresent(page, opts.testUserEmail, opts.testUserPassword, CALLBACK_URL);

      await page.waitForURL(`${CALLBACK_URL}**`, { timeout: 30_000 });
    }
    // else: postPasswordOutcome === "callback" — already redirected
  } finally {
    await browser.close();
  }

  const code = await codePromise;

  // Exchange authorization code for tokens
  const tokenResp = await fetch(`${opts.zoneIssuerUrl}/oauth/2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: opts.clientId,
      code,
      redirect_uri: CALLBACK_URL,
      code_verifier: verifier,
    }),
  });

  if (!tokenResp.ok) {
    throw new Error(`Token exchange failed: ${tokenResp.status} ${await tokenResp.text()}`);
  }

  const tokens = await tokenResp.json() as { access_token: string; id_token?: string };
  return { accessToken: tokens.access_token, idToken: tokens.id_token };
}
