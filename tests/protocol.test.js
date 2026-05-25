// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadClassicScript } from "./helpers/load-script.js";

describe("protocol.js", () => {
  beforeEach(() => {
    delete globalThis.PASEJO;
    delete globalThis.browser;
    delete globalThis.chrome;
  });

  afterEach(() => {
    delete globalThis.PASEJO;
    delete globalThis.browser;
    delete globalThis.chrome;
  });

  it("installs the frozen PASEJO namespace on globalThis", () => {
    globalThis.chrome = { stub: true };
    loadClassicScript("src/protocol.js");
    expect(globalThis.PASEJO).toBeDefined();
    expect(Object.isFrozen(globalThis.PASEJO)).toBe(true);
    expect(globalThis.PASEJO.NATIVE_HOST).toBe("wtf.metio.pasejo");
    expect(globalThis.PASEJO.PROTOCOL_MIN).toBe(1);
    expect(globalThis.PASEJO.PROTOCOL_MAX).toBe(1);
  });

  it("freezes the ACTION map", () => {
    loadClassicScript("src/protocol.js");
    expect(Object.isFrozen(globalThis.PASEJO.ACTION)).toBe(true);
    expect(globalThis.PASEJO.ACTION).toEqual({
      Query: "query",
      ListStores: "list_stores",
    });
  });

  it("freezes the ERROR_KIND map and contains every documented kind", () => {
    loadClassicScript("src/protocol.js");
    expect(Object.isFrozen(globalThis.PASEJO.ERROR_KIND)).toBe(true);
    expect(globalThis.PASEJO.ERROR_KIND).toEqual({
      UnknownStore: "unknown_store",
      UnknownAction: "unknown_action",
      DecodeError: "decode_error",
      IdentityLocked: "identity_locked",
      HookFailed: "hook_failed",
      StoreUnreachable: "store_unreachable",
      NoStoreConfigured: "no_store_configured",
    });
  });

  it("freezes the ERROR_COPY map and has copy for every fail-mode error kind", () => {
    loadClassicScript("src/protocol.js");
    expect(Object.isFrozen(globalThis.PASEJO.ERROR_COPY)).toBe(true);
    // unknown_action is reserved but currently unused by the host.
    const kinds = Object.values(globalThis.PASEJO.ERROR_KIND).filter(
      (k) => k !== "unknown_action",
    );
    for (const kind of kinds) {
      expect(globalThis.PASEJO.ERROR_COPY[kind]).toBeTypeOf("string");
      expect(globalThis.PASEJO.ERROR_COPY[kind].length).toBeGreaterThan(0);
    }
  });

  it("prefers the `browser` global over `chrome` for api binding", () => {
    const browserStub = { source: "browser" };
    const chromeStub = { source: "chrome" };
    globalThis.browser = browserStub;
    globalThis.chrome = chromeStub;
    loadClassicScript("src/protocol.js");
    expect(globalThis.PASEJO.api).toBe(browserStub);
  });

  it("falls back to `chrome` when `browser` is not defined", () => {
    const chromeStub = { source: "chrome-only" };
    globalThis.chrome = chromeStub;
    loadClassicScript("src/protocol.js");
    expect(globalThis.PASEJO.api).toBe(chromeStub);
  });

  it("api is undefined when neither global exists (extension never sees this, but kept defensive)", () => {
    loadClassicScript("src/protocol.js");
    expect(globalThis.PASEJO.api).toBeUndefined();
  });
});
