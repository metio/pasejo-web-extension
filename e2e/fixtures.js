// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import path from "node:path";
import { fileURLToPath } from "node:url";

import { test as base, chromium, expect } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));

// The unpacked Chromium build `package.sh` produces. The e2e job runs
// `./package.sh` before Playwright, so this directory is present.
const extensionPath = path.resolve(here, "..", "dist", "chromium");

// Loading an extension requires a persistent context, and the content
// scripts + the toolbar popup only run in a headed browser — under `xvfb`
// in CI. `channel: "chrome"` uses real Google Chrome so the native-messaging
// host manifest lookup path matches what `install-manifest --browser chrome`
// writes (`~/.config/google-chrome/NativeMessagingHosts/`).
export const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chrome",
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
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
});

export { expect };
