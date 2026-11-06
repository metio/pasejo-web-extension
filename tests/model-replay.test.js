// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import fs from "node:fs";
import path from "node:path";

import { describe, it } from "vitest";

import { decodeTrace } from "./helpers/itf.js";
import { replay } from "./helpers/model-harness.js";
import { modelTraces } from "./helpers/model-traces.js";

// Replays traces of the Quint model (model/extension.qnt) against the
// shipped popup and background scripts. The traces come from `quint run`:
// one per scenario of model/scenarios.qnt, plus a batch of random runs.
// See tests/helpers/model-harness.js for how a step becomes an event and
// what is compared after it.
const traces = await modelTraces();

describe("model replay", () => {
  it("has traces to replay", () => {
    if (traces.length === 0) {
      throw new Error("no model traces were written");
    }
  });

  for (const file of traces) {
    it(path.basename(file), async () => {
      await replay(decodeTrace(JSON.parse(fs.readFileSync(file, "utf8"))));
    });
  }
});
