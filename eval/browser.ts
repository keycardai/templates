/**
 * Playwright OAuth flow: navigate to the authorization URL, log in as the
 * test user, approve the consent screen, capture the authorization code
 * from the redirect, and exchange it for an access token.
 */

import { chromium, type Page } from "playwright";
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

/**
 * Log the current page URL, title, and HTML so a headless CI failure can be
 * diagnosed from the run log (there is no browser window to inspect in CI).
 */
async function dumpPage(page: Page, label: string): Promise<void> {
  const url = page.url();
  const title = await page.title().catch(() => "(unavailable)");
  const html = await page.content().catch(() => "(unavailable)");
  console.error(`[eval:${label}] url=${url}`);
  console.error(`[eval:${label}] title=${title}`);
  console.error(`[eval:${label}] html (first 6000 chars):\n${html.slice(0, 6000)}`);
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
  // An error callback (for example "No User Identity Provider configured in
  // Zone") can arrive while the browser is still open. Mark the rejection
  // handled here so it surfaces at `await codePromise` below, where the
  // caller's error handling and teardown run, instead of crashing the process.
  codePromise.catch(() => undefined);

  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(authorizeUrl.toString());
    await driveLogin(page, opts);
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

// Sign-in can span several zones. With the eval zone's Identity Provider set
// to the Organization Zone, the authorize request goes eval zone -> Organization
// Zone -> Keycard ID Zone, and each hop can show its own page: an identifier
// form, a password form, or a consent screen. The forms differ by zone: the ID
// Zone uses input#username and input#current-password, a zone's own login page
// uses input[name="identifier"], input[name="username"] and input[name="password"].
const IDENTIFIER_FIELD = 'input#username, input[name="identifier"]';
const PASSWORD_FIELD = 'input#current-password, input[name="password"]';
// Provider buttons on the ID Zone login page are also submit buttons; they carry data-provider.
const PRIMARY_BUTTON = 'button[type="submit"]:not([data-provider])';
const APPROVE_BUTTON = "form:has(input[name='action'][value='approve']) button[type='submit']";
const MAX_LOGIN_STEPS = 8;

type LoginPage = "callback" | "signup" | "consent" | "password" | "identifier" | "error";

/** Wait until the page shows something the login loop knows how to handle. */
async function nextLoginPage(page: Page): Promise<LoginPage | null> {
  const silence = () => null;
  const timeout = 45_000;
  const seen = await Promise.race([
    page.waitForURL(`${CALLBACK_URL}**`, { timeout }).then(() => "callback" as const).catch(silence),
    page.waitForURL(/\/login\/(signup|verify-email)/, { timeout }).then(() => "signup" as const).catch(silence),
    page.waitForURL("**/login/consent**", { timeout }).then(() => "consent" as const).catch(silence),
    page.waitForSelector(APPROVE_BUTTON, { timeout }).then(() => "consent" as const).catch(silence),
    page.waitForSelector(PASSWORD_FIELD, { state: "visible", timeout }).then(() => "password" as const).catch(silence),
    page.waitForSelector(IDENTIFIER_FIELD, { state: "visible", timeout }).then(() => "identifier" as const).catch(silence),
    page.getByRole("heading", { name: "Authentication Error" }).waitFor({ timeout }).then(() => "error" as const).catch(silence),
  ]);
  // A zone's own login page shows the username and password fields together,
  // so a page with a visible password field is always the password step.
  if (seen === "identifier" && (await page.locator(PASSWORD_FIELD).first().isVisible())) return "password";
  return seen;
}

/** Fill the field, then confirm the value stuck (hydration can reset an early fill). */
async function fill(page: Page, selector: string, value: string): Promise<void> {
  const field = page.locator(selector).first();
  for (let attempt = 0; attempt < 3; attempt++) {
    await field.fill(value);
    if ((await field.inputValue()) === value) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not fill ${selector} at ${page.url()}`);
}

/** After a submit, wait until the page navigates or the element just acted on goes away. */
async function settle(page: Page, before: string, actedOn: string): Promise<void> {
  const silence = () => undefined;
  await Promise.race([
    page.waitForURL((url) => url.toString() !== before, { timeout: 15_000 }).catch(silence),
    page.locator(actedOn).first().waitFor({ state: "hidden", timeout: 15_000 }).catch(silence),
  ]);
}

/**
 * Drive the browser from the authorize request to the callback: submit the
 * identifier and password wherever they're asked for, and approve each
 * consent screen, for up to MAX_LOGIN_STEPS pages.
 */
async function driveLogin(
  page: Page,
  opts: { testUserEmail: string; testUserPassword: string; headless?: boolean },
): Promise<void> {
  const handled: string[] = [];
  for (let step = 0; step < MAX_LOGIN_STEPS; step++) {
    const current = await nextLoginPage(page);
    const before = page.url();
    handled.push(`${current ?? "stall"} @ ${new URL(before).host}`);

    switch (current) {
      case "callback":
        return;

      case null:
        await dumpPage(page, "login-stall");
        throw new Error(
          `OAuth flow stalled on an unexpected page: ${page.url()}\n` +
          `Pages so far: ${handled.join(" -> ")}. See dumped HTML above. ` +
          `Run with EVAL_HEADLESS=false to inspect the browser state.`,
        );

      case "error":
        await dumpPage(page, "login-provider-error");
        throw new Error(
          `An identity provider in the sign-in chain returned an error at ${page.url()}\n` +
          `Pages so far: ${handled.join(" -> ")}.`,
        );

      case "signup":
        if (opts.headless === false) {
          console.log("\n  ⚠️  New user detected. Complete sign-up in the browser window.");
          console.log("     After signing up and verifying your email, the eval will continue automatically.\n");
          await page.waitForURL(`${CALLBACK_URL}**`, { timeout: 300_000 });
          return;
        }
        throw new Error(
          `Test user '${opts.testUserEmail}' has no account at ${new URL(page.url()).host}.\n` +
          `Run once with EVAL_HEADLESS=false to sign up and verify the account.`,
        );

      case "consent": {
        const approve = page.locator(APPROVE_BUTTON).first();
        if (await approve.isVisible().catch(() => false)) {
          await approve.click();
        } else {
          await page.getByRole("button", { name: /^allow/i }).first().click();
        }
        await settle(page, before, APPROVE_BUTTON);
        break;
      }

      case "password": {
        // A zone's own login page asks for the username beside the password.
        const username = page.locator('input[name="username"]').first();
        if ((await username.isVisible().catch(() => false)) && (await username.isEditable().catch(() => false))) {
          await fill(page, 'input[name="username"]', opts.testUserEmail);
        }
        await fill(page, PASSWORD_FIELD, opts.testUserPassword);
        await page.locator(PRIMARY_BUTTON).first().click();
        await settle(page, before, PASSWORD_FIELD);
        break;
      }

      case "identifier":
        await fill(page, IDENTIFIER_FIELD, opts.testUserEmail);
        await page.locator(PRIMARY_BUTTON).first().click();
        await settle(page, before, IDENTIFIER_FIELD);
        break;
    }
  }

  await dumpPage(page, "login-too-many-steps");
  throw new Error(
    `OAuth flow did not reach the callback within ${MAX_LOGIN_STEPS} pages: ` +
    `${handled.join(" -> ")}. See dumped HTML above.`,
  );
}
