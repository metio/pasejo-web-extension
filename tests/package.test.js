// @vitest-environment node
// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVES = ["pasejo-chromium.zip", "pasejo-firefox.xpi"];
// 1980-01-01T00:00:00Z, the earliest time a zip entry can carry.
const DEFAULT_EPOCH = 315532800;

const workDirs = [];

afterEach(() => {
  for (const dir of workDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Copies the inputs package.sh reads into a fresh directory, so each build
// runs against files whose metadata the test controls.
function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pasejo-package-"));
  workDirs.push(dir);
  fs.copyFileSync(path.join(projectRoot, "package.sh"), path.join(dir, "package.sh"));
  fs.chmodSync(path.join(dir, "package.sh"), 0o755);
  for (const sub of ["src", "manifests", "icons"]) {
    fs.cpSync(path.join(projectRoot, sub), path.join(dir, sub), { recursive: true });
  }
  return dir;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? [full, ...walk(full)] : [full];
  });
}

function scramble(dir) {
  let seconds = 1_600_000_000;
  for (const file of walk(dir)) {
    seconds += 7919;
    fs.utimesSync(file, seconds, seconds);
    if (!fs.statSync(file).isDirectory()) {
      fs.chmodSync(file, file.endsWith(".sh") ? 0o700 : 0o600);
    }
  }
}

function build(dir, { args = [], env = {}, umask = "022" } = {}) {
  const result = spawnSync("sh", ["-c", `umask ${umask} && exec ./package.sh "$@"`, "sh", ...args], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return result;
}

function buildOk(dir, options) {
  const result = build(dir, options);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return path.join(dir, "dist");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Reads the central directory of a zip archive without a zip library.
function centralDirectory(file) {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    expect(buf.readUInt32LE(offset)).toBe(0x02014b50);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    entries.push({
      name: buf.toString("utf8", offset + 46, offset + 46 + nameLength),
      time: buf.readUInt16LE(offset + 12),
      date: buf.readUInt16LE(offset + 14),
      mode: buf.readUInt32LE(offset + 38) >>> 16,
      extraLength,
      localExtraLength: buf.readUInt16LE(localOffset + 28),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function dosDateTime(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  return {
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
  };
}

function manifestVersion(dist, target) {
  return JSON.parse(fs.readFileSync(path.join(dist, target, "manifest.json"), "utf8")).version;
}

describe("package.sh", () => {
  it("builds byte-identical archives whatever the source mtimes, modes, umask and timezone", () => {
    const first = buildOk(stage());
    const otherDir = stage();
    scramble(otherDir);
    const second = buildOk(otherDir, { umask: "077", env: { TZ: "Pacific/Kiritimati" } });

    for (const archive of ARCHIVES) {
      expect(sha256(path.join(second, archive))).toBe(sha256(path.join(first, archive)));
    }
    expect(fs.readFileSync(path.join(second, "SHA256SUMS"), "utf8")).toBe(
      fs.readFileSync(path.join(first, "SHA256SUMS"), "utf8"),
    );
  });

  it("writes sorted file entries with a fixed timestamp, fixed modes and no extra fields", () => {
    const dist = buildOk(stage());
    const expected = dosDateTime(DEFAULT_EPOCH);

    for (const archive of ARCHIVES) {
      const entries = centralDirectory(path.join(dist, archive));
      const names = entries.map((entry) => entry.name);
      expect(names).toContain("manifest.json");
      expect(names).toContain("popup/popup.js");
      expect(names).toEqual([...names].sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : 1)));
      for (const entry of entries) {
        expect(entry.name.endsWith("/")).toBe(false);
        expect({ name: entry.name, date: entry.date, time: entry.time }).toEqual({ name: entry.name, ...expected });
        expect(entry.mode).toBe(0o100644);
        expect(entry.extraLength).toBe(0);
        expect(entry.localExtraLength).toBe(0);
      }
    }
  });

  it("takes the entry timestamp from SOURCE_DATE_EPOCH", () => {
    const epoch = 1_767_225_600; // 2026-01-01T00:00:00Z
    const dist = buildOk(stage(), { env: { SOURCE_DATE_EPOCH: String(epoch) } });
    for (const entry of centralDirectory(path.join(dist, "pasejo-firefox.xpi"))) {
      expect({ date: entry.date, time: entry.time }).toEqual(dosDateTime(epoch));
    }
  });

  it("lists every archive's SHA-256 in SHA256SUMS", () => {
    const dist = buildOk(stage());
    const expected = ARCHIVES.map((archive) => `${sha256(path.join(dist, archive))}  ${archive}\n`).join("");
    expect(fs.readFileSync(path.join(dist, "SHA256SUMS"), "utf8")).toBe(expected);
  });

  it("stamps a version argument into both built manifests and leaves manifests/ alone", () => {
    const dir = stage();
    const before = fs.readFileSync(path.join(dir, "manifests", "firefox.json"), "utf8");
    const dist = buildOk(dir, { args: ["1.20.3"] });

    expect(manifestVersion(dist, "firefox")).toBe("1.20.3");
    expect(manifestVersion(dist, "chromium")).toBe("1.20.3");
    expect(fs.readFileSync(path.join(dir, "manifests", "firefox.json"), "utf8")).toBe(before);
  });

  it("keeps the manifests' own version without an argument", () => {
    const dir = stage();
    const own = JSON.parse(fs.readFileSync(path.join(dir, "manifests", "chromium.json"), "utf8")).version;
    expect(manifestVersion(buildOk(dir), "chromium")).toBe(own);
  });

  it.each(["v1.2.3", "1.2.3.4.5", "1..2", "1.2-beta", "1.2/3"])("rejects the version %s", (version) => {
    const dir = stage();
    const result = build(dir, { args: [version] });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(version);
    expect(fs.existsSync(path.join(dir, "dist", "pasejo-firefox.xpi"))).toBe(false);
  });
});
