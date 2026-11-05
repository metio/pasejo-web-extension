// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { expect, openPopup, test } from "./fixtures.js";

// A minimal login form. The store the CI step bootstraps holds one secret
// named `alice`:
//   password: hunter2 / url: https://example.com / login: alice@example.com
// so a page at `example.com` lists it. Request interception serves every
// page below without a real server or a hosts-file entry.
const LOGIN_FORM = `<form>
  <input id="username" name="username" autocomplete="username" />
  <input id="password" name="password" type="password" autocomplete="current-password" />
</form>`;

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
  // The host decrypts the store and the matcher surfaces `alice`.
  await expect.poll(popup.firstRowText).toContain("alice");

  await popup.clickFirstRow();
  await expect(page.locator("#username")).toHaveValue("alice@example.com");
  await expect(page.locator("#password")).toHaveValue("hunter2");
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

  await expect
    .poll(popup.status)
    .toBe("Nothing filled. Frames from sites that alice does not match were skipped.");
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
