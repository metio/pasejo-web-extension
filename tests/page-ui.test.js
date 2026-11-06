// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The extension draws no UI inside web pages: everything the user acts
// on lives in the browser-owned popup, which a page can neither overlay
// nor script. These checks pin the static half of that rule; the fill
// script's runtime behaviour is pinned in fill.test.js.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

// Source text without `//` and `/* */` comments, so prose about an API
// does not count as a use of it.
function code(relPath) {
  return read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// APIs that add nodes, shadow roots, frames or top-layer UI to a page.
const PAGE_UI_APIS = [
  "createElement",
  "createElementNS",
  "attachShadow",
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "insertAdjacentElement",
  "appendChild",
  "insertBefore",
  "replaceChildren",
  "replaceWith",
  ".append(",
  ".prepend(",
  ".before(",
  ".after(",
  "document.write",
  "showModal",
  "showPopover",
  "requestFullscreen",
  "<iframe",
];

describe("no UI inside web pages", () => {
  it("keeps the fill script free of every API that adds UI to a page", () => {
    const source = code("src/content/fill.js");
    for (const api of PAGE_UI_APIS) {
      expect(source.includes(api), api).toBe(false);
    }
  });

  it("finds such an API when the fill script would use one", () => {
    // Positive control for the scan above: the popup builds its own
    // UI with these APIs, inside the extension's own document.
    const source = code("src/popup/popup.js");
    expect(PAGE_UI_APIS.some((api) => source.includes(api))).toBe(true);
  });

  for (const browser of ["chromium", "firefox"]) {
    it(`declares no content scripts or page-reachable resources for ${browser}`, () => {
      const manifest = JSON.parse(read(`manifests/${browser}.json`));
      expect(manifest.content_scripts).toBeUndefined();
      expect(manifest.web_accessible_resources).toBeUndefined();
    });
  }

  it("injects only the fill script file into pages, no inline code or styles", () => {
    const source = code("src/popup/popup.js");
    expect(source).not.toMatch(/insertCSS|\bfunc\s*:/);
    expect(source.match(/executeScript\(/g)).toHaveLength(1);
    expect(source).toMatch(/files:\s*\[FILL_SCRIPT_PATH\]/);
  });
});
