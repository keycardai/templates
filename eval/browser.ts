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
      await page.waitForURL(`${CALLBACK_URL}**`, { timeout: 15_000 });
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
