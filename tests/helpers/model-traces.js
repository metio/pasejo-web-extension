// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const modelDir = path.join(root, "model");

// The situations of model/scenarios.qnt the replay wants one trace of.
export const SCENARIOS = [
  "filled",
  "filledIframe",
  "filledAfterFrameCheck",
  "filledAfterConfirmation",
  "filledFromSecondStore",
  "triedSecondFrame",
  "releasedOtp",
  "releasedWithoutFill",
  "releasedForGoneFrame",
  "stoppedForChangedPage",
  "stoppedWithoutAccess",
  "refusedByVisibility",
  "refusedOtherSite",
  "refusedReveal",
  "answeredStream",
  "abandonedStream",
];

const MAX_STEPS = 40;

function quintCli() {
  return fs.realpathSync(path.join(root, "node_modules", ".bin", "quint"));
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [quintCli(), ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

// The `quint run` invocations that write the traces into `dir`: one per
// scenario, which stops at the first state reaching it, and one batch of
// random runs that check every invariant on the way.
function jobs(dir, { seed, samples, backend }) {
  const common = [
    "--backend",
    backend,
    "--max-steps",
    String(MAX_STEPS),
    "--seed",
    seed,
    "--mbt",
    "--verbosity",
    "0",
  ];
  return [
    ...SCENARIOS.map((name) => ({
      expectViolation: true,
      what: `scenario ${name}`,
      args: [
        "run",
        "model/scenarios.qnt",
        "--main",
        "scenarios",
        "--invariant",
        `not(${name})`,
        "--max-samples",
        "20000",
        "--out-itf",
        path.join(dir, `scenario-${name}.itf.json`),
        ...common,
      ],
    })),
    {
      expectViolation: false,
      what: "random runs",
      args: [
        "run",
        "model/extension.qnt",
        "--main",
        "extension",
        "--invariant",
        "allInvariants",
        "--max-samples",
        String(samples),
        "--n-traces",
        String(samples),
        "--out-itf",
        path.join(dir, "random-{seq}.itf.json"),
        ...common,
      ],
    },
  ];
}

function listTraces(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".itf.json"))
    .sort()
    .map((name) => path.join(dir, name));
}

// Writes the replay traces (or reuses the ones a previous run wrote for
// the same model, seed and Quint version) and returns their paths.
// `PASEJO_MODEL_TRACES` names a directory of traces to replay instead.
export async function modelTraces({
  seed = process.env.PASEJO_MODEL_SEED ?? "0x5eed",
  samples = Number(process.env.PASEJO_MODEL_SAMPLES ?? "60"),
  backend = process.env.PASEJO_MODEL_BACKEND ?? "rust",
} = {}) {
  if (process.env.PASEJO_MODEL_TRACES) {
    return listTraces(process.env.PASEJO_MODEL_TRACES);
  }
  const hash = createHash("sha256");
  for (const name of fs.readdirSync(modelDir).sort()) {
    hash.update(name);
    hash.update(fs.readFileSync(path.join(modelDir, name)));
  }
  hash.update(fs.readFileSync(path.join(path.dirname(quintCli()), "..", "..", "package.json")));
  hash.update(JSON.stringify({ seed, samples, backend, MAX_STEPS, SCENARIOS }));
  const cache = path.join(root, "node_modules", ".cache", "pasejo-model");
  const dir = path.join(cache, hash.digest("hex").slice(0, 16));
  if (fs.existsSync(path.join(dir, "complete"))) {
    return listTraces(dir);
  }
  fs.mkdirSync(cache, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(cache, "tmp-"));
  // The first run fetches Quint's Rust evaluator when it is not installed
  // yet; the others start after it, so they do not race for the download.
  const [first, ...rest] = jobs(scratch, { seed, samples, backend });
  const results = [{ job: first, ...(await run(first.args)) }];
  results.push(
    ...(await Promise.all(rest.map(async (job) => ({ job, ...(await run(job.args)) })))),
  );
  for (const { job, code, output } of results) {
    // `quint run` exits 1 when the invariant fails, which for a scenario
    // means the run reached it and wrote the path there.
    if (code !== (job.expectViolation ? 1 : 0)) {
      throw new Error(`quint ${job.what} exited ${code}:\n${output}`);
    }
    const out = job.args[job.args.indexOf("--out-itf") + 1];
    if (job.expectViolation && !fs.existsSync(out)) {
      throw new Error(`quint ${job.what} wrote no trace:\n${output}`);
    }
  }
  fs.writeFileSync(path.join(scratch, "complete"), "");
  // Traces of an earlier model are of no further use.
  for (const entry of fs.readdirSync(cache)) {
    if (!entry.startsWith("tmp-")) {
      fs.rmSync(path.join(cache, entry), { recursive: true, force: true });
    }
  }
  fs.renameSync(scratch, dir);
  return listTraces(dir);
}
