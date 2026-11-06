// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { expect, openPopup, test } from "./fixtures.js";

// A minimal login form. `bootstrap-store.sh` writes the stores the tests
// read; its `test` store holds a secret named `alice`:
//   password: hunter2 / url: https://example.com / login: alice@example.com
// plus a TOTP entry under the same name, so a page at `example.com` lists
// it and, being the URL's exact host, gets the current code on a reveal.
// Request interception serves every page below without a real server or
// a hosts-file entry.
const LOGIN_FORM = `<form>
  <input id="username" name="username" autocomplete="username" />
  <input id="password" name="password" type="password" autocomplete="current-password" />
</form>`;

const LOGIN_FORM_WITH_OTP = `<form>
  <input id="username" name="username" autocomplete="username" />
  <input id="password" name="password" type="password" autocomplete="current-password" />
  <input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" />
</form>`;

// A login form whose password field lies under a transparent overlay that
// would catch the user's click.
const COVERED_FORM = `<form style="position: relative">
  <input id="username" name="username" autocomplete="username" />
  <input id="password" name="password" type="password" autocomplete="current-password" />
  <div style="position: absolute; inset: 0; background: transparent"></div>
</form>`;

// A transparent decoy password field ahead of the real login form.
const DECOY_FORM = `<input id="decoy" type="password" style="opacity: 0" />
${LOGIN_FORM}`;

function html(body) {
  return `<!doctype html><html lang="en"><body>${body}</body></html>`;
}

const IFRAME = (src) =>
  `<iframe id="frame" src="${src}" width="400" height="200"></iframe>`;

async function serve(context, routes) {
  for (const [pattern, body] of Object.entries(routes)) {
    await context.route(pattern, (route) =>
      route.fulfill({ contentType: "text/html", body: html(body) }),
    );
  }
}

// Every test talks to the real host, so each one registers it.
test.beforeEach(async ({ nativeHost }) => {
  expect(nativeHost).toBeTruthy();
});

test("fills a credential end-to-end through the real pasejo host", async ({
  context,
}) => {
  await serve(context, { "http://example.com/**": LOGIN_FORM });
  const page = await context.newPage();
  await page.goto("http://example.com/login");

  const popup = await openPopup(context, page);
  // The host decrypts the store and the matcher surfaces `alice`, with
  // metadata only: neither the password nor a code reaches the popup
  // before a match is picked.
  await expect.poll(popup.firstRowText).toContain("alice");
  expect(await popup.resultsText()).not.toContain("hunter2");
  expect(await popup.firstRowOtp()).toBeNull();

  await popup.clickFirstRow();
  await expect(page.locator("#username")).toHaveValue("alice@example.com");
  await expect(page.locator("#password")).toHaveValue("hunter2");
  // The page has no one-time-code field, so the released code is shown
  // on the row instead.
  await expect.poll(popup.firstRowOtp).toMatch(/^OTP: \d{6}$/);
});

test("fills the one-time code released for the exact host", async ({
  context,
}) => {
  await serve(context, { "http://example.com/**": LOGIN_FORM_WITH_OTP });
  const page = await context.newPage();
  await page.goto("http://example.com/login");

  const popup = await openPopup(context, page);
  await expect.poll(popup.firstRowText).toContain("alice");
  await popup.clickFirstRow();

  await expect(page.locator("#password")).toHaveValue("hunter2");
  await expect(page.locator("#otp")).toHaveValue(/^\d{6}$/);
});

test("passes over a transparent decoy field for the visible one", async ({
  context,
}) => {
  await serve(context, { "http://example.com/**": DECOY_FORM });
  const page = await context.newPage();
  await page.goto("http://example.com/login");

  const popup = await openPopup(context, page);
  await expect.poll(popup.firstRowText).toContain("alice");
  await popup.clickFirstRow();

  await expect(page.locator("#password")).toHaveValue("hunter2");
  await expect(page.locator("#decoy")).toHaveValue("");
});

test("refuses to fill a password field another element covers", async ({
  context,
}) => {
  await serve(context, { "http://example.com/**": COVERED_FORM });
  const page = await context.newPage();
  await page.goto("http://example.com/login");

  const popup = await openPopup(context, page);
  await expect.poll(popup.firstRowText).toContain("alice");
  await popup.clickFirstRow();

  await expect
    .poll(popup.status)
    .toMatch(/^Nothing filled\. Something on the page lies over the login field for alice\./);
  await expect(page.locator("#username")).toHaveValue("");
  await expect(page.locator("#password")).toHaveValue("");
});

test("fills a login form inside a same-origin iframe", async ({ context }) => {
  await serve(context, {
    "http://example.com/login": IFRAME("http://example.com/frame"),
    "http://example.com/frame": LOGIN_FORM,
  });
  const page = await context.newPage();
  await page.goto("http://example.com/login");
  const frame = page.frameLocator("#frame");
  await expect(frame.locator("#password")).toBeVisible();

  const popup = await openPopup(context, page);
  await expect.poll(popup.firstRowText).toContain("alice");
  await popup.clickFirstRow();

  await expect(frame.locator("#username")).toHaveValue("alice@example.com");
  await expect(frame.locator("#password")).toHaveValue("hunter2");
});

test("never fills a cross-origin iframe the secret does not match", async ({
  context,
}) => {
  await serve(context, {
    "http://example.com/login": IFRAME("http://evil.test/frame"),
    "http://evil.test/frame": LOGIN_FORM,
  });
  const page = await context.newPage();
  await page.goto("http://example.com/login");
  const frame = page.frameLocator("#frame");
  await expect(frame.locator("#password")).toBeVisible();

  const popup = await openPopup(context, page);
  await expect.poll(popup.firstRowText).toContain("alice");
  await popup.clickFirstRow();

  // The top frame on example.com was allowed and got the released
  // credential, but has no form; the code it carried stays in the popup.
  await expect
    .poll(popup.status)
    .toBe(
      "Nothing filled. Frames from sites that alice does not match were skipped. Its one-time code is shown below.",
    );
  await expect(frame.locator("#username")).toHaveValue("");
  await expect(frame.locator("#password")).toHaveValue("");
});

test("refuses to fill after the tab navigated to another site", async ({
  context,
}) => {
  await serve(context, {
    "http://example.com/**": LOGIN_FORM,
    "http://evil.test/**": LOGIN_FORM,
  });
  const page = await context.newPage();
  await page.goto("http://example.com/login");

  const popup = await openPopup(context, page);
  await expect.poll(popup.firstRowText).toContain("alice");

  await page.goto("http://evil.test/login");
  await popup.clickFirstRow();

  await expect.poll(popup.status).toMatch(/^The page changed/);
  await expect(page.locator("#username")).toHaveValue("");
  await expect(page.locator("#password")).toHaveValue("");
});

test("never lists a secret whose policy keeps it out of the browser", async ({
  context,
}) => {
  await serve(context, { "http://example.com/**": LOGIN_FORM });
  const page = await context.newPage();
  await page.goto("http://example.com/login");

  const popup = await openPopup(context, page);
  await expect.poll(popup.firstRowText).toContain("alice");
  // `carol` names the same URL but carries `pasejo-fill: never`.
  expect(await popup.resultsText()).not.toContain("carol");
});

test("asks before filling a secret whose policy asks for confirmation", async ({
  context,
}) => {
  await serve(context, { "http://confirm.test/**": LOGIN_FORM });
  const page = await context.newPage();
  await page.goto("http://confirm.test/login");

  const popup = await openPopup(context, page);
  await expect.poll(popup.firstRowText).toContain("dave");
  await popup.clickFirstRow();

  await expect
    .poll(popup.confirmPrompt)
    .toBe(
      "Fill dave into confirm.test? This secret asks to be confirmed every time.",
    );
  await expect(page.locator("#password")).toHaveValue("");

  await expect.poll(popup.confirmArmed).toBe(true);
  await popup.clickConfirm();
  await expect(page.locator("#username")).toHaveValue("dave@confirm.test");
  await expect(page.locator("#password")).toHaveValue("confirm-me");
});

test("warns that the page looks like a site the store holds a login for", async ({
  context,
}) => {
  await serve(context, { "http://examp1e.com/**": LOGIN_FORM });
  const page = await context.newPage();
  await page.goto("http://examp1e.com/login");

  const popup = await openPopup(context, page);
  await expect
    .poll(popup.warning)
    .toBe(
      "Careful: you have no login for examp1e.com, but it looks like example.com, where you do. Check the address bar before you enter anything.",
    );
  expect(await popup.status()).toBe("No matches for examp1e.com.");
});

test("shows that it is waiting while a reveal decrypts slowly", async ({
  context,
}) => {
  await serve(context, { "http://slow.test/**": LOGIN_FORM });
  const page = await context.newPage();
  await page.goto("http://slow.test/login");

  const popup = await openPopup(context, page);
  await expect.poll(popup.status).toBe("No matches for slow.test.");
  await popup.selectStore("slow");
  await expect.poll(popup.firstRowText).toContain("erin");
  await popup.clickFirstRow();

  // Every decryption of the `slow` store waits two seconds for its pull
  // hook, as one waiting for a security-key touch would.
  await expect
    .poll(popup.status)
    .toBe(
      "Waiting for pasejo to decrypt erin. If your identity is on a security key, touch it now.",
    );
  expect(await popup.statusWaiting()).toBe(true);
  expect(await popup.firstRowBusy()).toBe(true);

  await expect(page.locator("#password")).toHaveValue("slow-secret");
  expect(await popup.firstRowBusy()).toBe(false);
});
