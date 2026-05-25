// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: false,
    include: ["tests/**/*.test.js"],
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.js"],
      exclude: [],
      reportsDirectory: "coverage",
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
