// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");

// Loads one of the extension's classic scripts into the current vitest
// global context. Implemented via `vm.compileFunction` so top-level
// `const` / `let` / `function` declarations in the source become
// function-scoped (not script-global) — that lets the same script be
// reloaded across tests without `Identifier '…' has already been
// declared`. The `filename` option lets v8 coverage attribute every
// executed line back to the original source file.
//
// `expose` lists top-level function or const names that the test wants
// to call directly. They are returned as an object keyed by name. Pass
// `[]` (the default) when the test only cares about the script's side
// effects — installing globals, registering listeners — and not about
// reaching its internal helpers.
export function loadClassicScript(relPath, { expose = [] } = {}) {
  const absPath = path.resolve(projectRoot, relPath);
  const source = fs.readFileSync(absPath, "utf8");
  const trailer =
    expose.length === 0
      ? ""
      : `\n;return { ${expose.join(", ")} };\n`;
  const fn = vm.compileFunction(source + trailer, [], { filename: absPath });
  return fn() ?? null;
}
