// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test as base, chromium, expect } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));

// The unpacked Chromium build `package.sh` produces. The e2e job runs
// `./package.sh` before Playwright, so this directory is present.
const builtExtension = path.resolve(here, "..", "dist", "chromium");

// The sites the tests serve by request interception. The shipped manifest
// asks for no host permissions: a user's toolbar click or shortcut grants
// `activeTab`, and a programmatic `chrome.action.openPopup()` is not such
// a gesture. The test build therefore gets host permissions for exactly
// these sites, standing in for the `activeTab` grant. `evil.test` is in
// the list so a cross-origin iframe can be injected at all, which is what
// lets a test show the popup's own origin check refusing it.
// `examp1e.com` is the look-alike of `example.com`; `confirm.test` and
// `slow.test` hold the secrets that ask for confirmation and that decrypt
// slowly (see `bootstrap-store.sh`).
export const TEST_HOST_PERMISSIONS = Object.freeze([
  "http://example.com/*",
  "http://evil.test/*",
  "http://examp1e.com/*",
  "http://confirm.test/*",
  "http://slow.test/*",
]);

// Copies the built extension into `dir` and adds the test-only host
// permissions to its manifest. `dist/chromium` and `manifests/` stay as
// shipped.
function buildTestExtension(dir) {
  fs.cpSync(builtExtension, dir, { recursive: true });
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = [...TEST_HOST_PERMISSIONS];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

// Everything a run writes — the extension copy, the browser profile, the
// native-messaging manifest and the host wrapper — lives under one
// throwaway directory whose `home/` stands in for `$HOME`, so a local run
// leaves the user's browser and pasejo configuration untouched.
export const test = base.extend({
  workDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pasejo-e2e-"));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },

  isolatedEnv: async ({ workDir }, use) => {
    const home = path.join(workDir, "home");
    fs.mkdirSync(home, { recursive: true });
    await use({
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
    });
  },

  // Playwright's bundled Chromium, headless: branded Google Chrome ignores
  // `--load-extension`.
  context: async ({ workDir, isolatedEnv }, use) => {
    const extensionPath = path.join(workDir, "extension");
    buildTestExtension(extensionPath);
    const context = await chromium.launchPersistentContext(
      path.join(workDir, "profile"),
      {
        channel: "chromium",
        headless: true,
        env: isolatedEnv,
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
        ],
      },
    );
    await use(context);
    await context.close();
  },

  // The MV3 service worker's origin is the extension id. Wait for it to spin
  // up if the context just launched.
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) {
      worker = await context.waitForEvent("serviceworker");
    }
    await use(new URL(worker.url()).host);
  },

  // Registers the real `pasejo browser host` for this run's extension id.
  // The wrapper `install-manifest` writes execs the binary with
  // PASEJO_CONFIG baked in, which is how the browser-spawned host (whose
  // environment is otherwise stripped) finds the test store, and with the
  // extension's origin as the one caller the host accepts. Hook throttling
  // is off so the `slow` store's pull hook delays every decryption, the
  // reveal included. Chromium
  // reads user-level host manifests from `NativeMessagingHosts` in its
  // profile directory, so the manifest is copied there too.
  nativeHost: async ({ extensionId, workDir, isolatedEnv }, use) => {
    const pasejoBin = process.env.PASEJO_BIN;
    const pasejoConfig = process.env.PASEJO_CONFIG;
    expect(pasejoBin, "PASEJO_BIN must point at the pasejo binary").toBeTruthy();
    expect(
      pasejoConfig,
      "PASEJO_CONFIG must point at the bootstrapped store config",
    ).toBeTruthy();
    execFileSync(
      pasejoBin,
      [
        "browser",
        "install-manifest",
        "--browser",
        "chromium",
        "--extension-id",
        extensionId,
        "--env",
        `PASEJO_CONFIG=${pasejoConfig}`,
        "--env",
        "PASEJO_DISABLE_HOOK_THROTTLING=1",
      ],
      { stdio: "inherit", env: isolatedEnv },
    );
    const manifestName = "wtf.metio.pasejo.json";
    const installed = path.join(
      isolatedEnv.XDG_CONFIG_HOME,
      "chromium",
      "NativeMessagingHosts",
      manifestName,
    );
    const profileHosts = path.join(workDir, "profile", "NativeMessagingHosts");
    fs.mkdirSync(profileHosts, { recursive: true });
    fs.copyFileSync(installed, path.join(profileHosts, manifestName));
    await use(installed);
  },
});

// Opens the real toolbar popup for the active tab and returns a driver for
// it. `chrome.action.openPopup()` attaches the popup to the active tab, so
// the popup's `tabs.query({active, currentWindow})` resolves to that tab —
// which opening popup.html as a standalone tab could not do (that tab
// would itself be the active one). Headless Chromium runs the popup but
// does not hand it to Playwright as a page, so the driver evaluates
// expressions in it over a browser-level CDP session.
export async function openPopup(context, page) {
  await page.bringToFront();
  const [worker] = context.serviceWorkers();
  await worker.evaluate(() => chrome.action.openPopup());
  const cdp = await context.browser().newBrowserCDPSession();
  const popupUrl = new URL("popup/popup.html", worker.url()).href;
  let target;
  await expect
    .poll(async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      target = targetInfos.find((info) => info.url === popupUrl);
      return target !== undefined;
    })
    .toBe(true);
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: false,
  });
  const pending = new Map();
  let nextId = 1;
  cdp.on("Target.receivedMessageFromTarget", (event) => {
    if (event.sessionId !== sessionId) {
      return;
    }
    const message = JSON.parse(event.message);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  async function evaluate(expression) {
    const id = nextId++;
    const reply = new Promise((resolve) => pending.set(id, resolve));
    await cdp.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true },
      }),
    });
    const { result, error } = await reply;
    if (error || result.exceptionDetails) {
      throw new Error(
        `popup evaluation failed: ${JSON.stringify(error ?? result.exceptionDetails)}`,
      );
    }
    return result.result.value;
  }
  return {
    // Text of the first result row, or null while there is none.
    firstRowText: () =>
      evaluate(
        `document.querySelector("#results li")?.textContent ?? null`,
      ),
    // Text of the whole result list.
    resultsText: () =>
      evaluate(`document.getElementById("results").textContent`),
    // Text of the one-time code shown on the first row, or null.
    firstRowOtp: () =>
      evaluate(
        `document.querySelector("#results li .otp")?.textContent ?? null`,
      ),
    status: () => evaluate(`document.getElementById("status").textContent`),
    // Whether the status line shows the waiting state.
    statusWaiting: () =>
      evaluate(`document.getElementById("status").classList.contains("waiting")`),
    // Text of the look-alike warning, or null while it is hidden.
    warning: () =>
      evaluate(
        `(() => { const w = document.getElementById("warning"); return w.hidden ? null : w.textContent; })()`,
      ),
    // Text of the confirmation prompt on the first row, or null.
    confirmPrompt: () =>
      evaluate(
        `document.querySelector("#results li .confirm-text")?.textContent ?? null`,
      ),
    // Whether the prompt's confirm button accepts clicks yet.
    confirmArmed: () =>
      evaluate(
        `document.querySelector("#results li .confirm button")?.getAttribute("aria-disabled") === null`,
      ),
    clickConfirm: () =>
      evaluate(`document.querySelector("#results li .confirm button").click()`),
    // Whether the first row is marked busy.
    firstRowBusy: () =>
      evaluate(
        `document.querySelector("#results li")?.getAttribute("aria-busy") === "true"`,
      ),
    // Picks `name` in the Store dropdown the way a user's choice does.
    selectStore: (name) =>
      evaluate(
        `(() => { const s = document.getElementById("store"); s.value = ${JSON.stringify(name)}; s.dispatchEvent(new Event("change")); })()`,
      ),
    clickFirstRow: () =>
      evaluate(`document.querySelector("#results li").click()`),
  };
}

export { expect };
