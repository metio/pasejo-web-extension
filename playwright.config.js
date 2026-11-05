// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { defineConfig } from "@playwright/test";

// The e2e suite drives a real Chrome with the unpacked extension loaded and
// the real `pasejo browser host` on the other end of native messaging, so it
// lives apart from the happy-dom unit suite (`tests/**`, run by Vitest). A
// single worker only: the test registers one native-messaging host manifest
// and one shared store, which concurrent runs would race over.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.js",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : "list",
});
