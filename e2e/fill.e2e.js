// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { execFileSync } from "node:child_process";

import { expect, test } from "./fixtures.js";

// A minimal login form, served by request interception at the host the
// stored secret's `url:` field points at. The popup queries by the active
// tab's hostname, so the page must live at `example.com` for the match to
// land; intercepting the request lets us serve it there without a real
// server or a hosts-file entry.
const LOGIN_PAGE = `<!doctype html>
<html lang="en">
  <body>
    <form>
      <input id="username" name="username" autocomplete="username" />
      <input
        id="password"
        name="password"
        type="password"
        autocomplete="current-password"
      />
    </form>
  </body>
</html>`;

// The store the CI step bootstraps holds one secret named `alice`:
//   password: hunter2 / url: https://example.com / login: alice@example.com
test("fills a credential end-to-end through the real pasejo host", async ({
  context,
  extensionId,
}) => {
  const pasejoBin = process.env.PASEJO_BIN;
  const pasejoConfig = process.env.PASEJO_CONFIG;
  expect(pasejoBin, "PASEJO_BIN must point at the pasejo binary").toBeTruthy();
  expect(
    pasejoConfig,
    "PASEJO_CONFIG must point at the bootstrapped store config",
  ).toBeTruthy();

  // Register the native-messaging host for THIS run's extension id. The
  // wrapper that install-manifest writes execs the same binary with
  // PASEJO_CONFIG baked in, which is how the browser-spawned host (whose
  // environment is otherwise stripped) finds the test store.
  execFileSync(
    pasejoBin,
    [
      "browser",
      "install-manifest",
      "--browser",
      "chrome",
      "--extension-id",
      extensionId,
      "--env",
      `PASEJO_CONFIG=${pasejoConfig}`,
    ],
    { stdio: "inherit" },
  );

  await context.route("http://example.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: LOGIN_PAGE }),
  );
  const page = await context.newPage();
  await page.goto("http://example.com/login");
  await page.bringToFront();

  // Open the real toolbar popup. `chrome.action.openPopup()` attaches it to
  // the active example.com tab, so the popup's `tabs.query({active,
  // currentWindow})` resolves to example.com — which opening the popup as a
  // standalone tab could not do (that tab would itself be the active one).
  const [worker] = context.serviceWorkers();
  const popupPromise = context.waitForEvent("page");
  await worker.evaluate(() => chrome.action.openPopup());
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");

  // The host decrypts the store and the matcher surfaces `alice`.
  const row = popup.locator("#results li").first();
  await expect(row).toContainText("alice");

  // Clicking the row fans the fill out to the underlying page's form.
  await row.click();
  await expect(page.locator("#username")).toHaveValue("alice@example.com");
  await expect(page.locator("#password")).toHaveValue("hunter2");
});
