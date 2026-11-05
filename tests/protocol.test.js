// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    expect(globalThis.PASEJO.PROTOCOL_VERSION).toBe(1);
    // Range-based negotiation (PROTOCOL_MIN/PROTOCOL_MAX) and the
    // dispatch threshold (MULTI_STORE_MIN_VERSION) were removed when
    // we collapsed to a single supported version — fail loudly if
    // anyone re-introduces them by accident.
    expect(globalThis.PASEJO.PROTOCOL_MIN).toBeUndefined();
    expect(globalThis.PASEJO.PROTOCOL_MAX).toBeUndefined();
    expect(globalThis.PASEJO.MULTI_STORE_MIN_VERSION).toBeUndefined();
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
      ResponseTooLarge: "response_too_large",
    });
  });

  it("freezes ERROR_MESSAGE_IDS and maps every fail-mode error kind to a message id", () => {
    loadClassicScript("src/protocol.js");
    expect(Object.isFrozen(globalThis.PASEJO.ERROR_MESSAGE_IDS)).toBe(true);
    // unknown_action is reserved but currently unused by the host.
    const kinds = Object.values(globalThis.PASEJO.ERROR_KIND).filter(
      (k) => k !== "unknown_action",
    );
    for (const kind of kinds) {
      expect(globalThis.PASEJO.ERROR_MESSAGE_IDS[kind]).toBeTypeOf("string");
      expect(globalThis.PASEJO.ERROR_MESSAGE_IDS[kind].length).toBeGreaterThan(
        0,
      );
    }
  });

  it("resolves localized strings through `t`, stringifying substitutions", () => {
    const getMessage = vi.fn(
      (key, subs) => `${key}|${(subs ?? []).join(",")}`,
    );
    globalThis.browser = { i18n: { getMessage } };
    loadClassicScript("src/protocol.js");
    expect(globalThis.PASEJO.t("statusFilled", "acme")).toBe(
      "statusFilled|acme",
    );
    // Substitutions are stringified before they reach the i18n API.
    globalThis.PASEJO.t("statusSearchingProgress", "site", 1, 2);
    expect(getMessage).toHaveBeenLastCalledWith("statusSearchingProgress", [
      "site",
      "1",
      "2",
    ]);
    // No substitutions => undefined (not an empty array) to the API.
    globalThis.PASEJO.t("grantAccessButton");
    expect(getMessage).toHaveBeenLastCalledWith("grantAccessButton", undefined);
  });

  it("returns an empty string from `t` when the i18n API is unavailable", () => {
    loadClassicScript("src/protocol.js");
    expect(globalThis.PASEJO.t("statusFilled", "acme")).toBe("");
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

  describe("shared storage primitives", () => {
    function loadPasejo() {
      globalThis.chrome = {};
      loadClassicScript("src/protocol.js");
      return globalThis.PASEJO;
    }

    // A storage stub whose `local.get(key)` returns `{ [key]: data[key] }`
    // for known keys and `{}` otherwise — mirroring the real API.
    function storageStub(data) {
      return {
        storage: {
          local: {
            get: async (key) => (key in data ? { [key]: data[key] } : {}),
          },
        },
      };
    }

    it("recallStoreForHost returns the remembered store or null", async () => {
      const pasejo = loadPasejo();
      const stub = storageStub({
        "pasejo:host-stores": {
          "example.com": { store: "work", lastUsedAt: 1 },
        },
      });
      expect(await pasejo.recallStoreForHost(stub, "example.com")).toBe("work");
      expect(await pasejo.recallStoreForHost(stub, "other.com")).toBe(null);
      expect(await pasejo.recallStoreForHost(stub, "")).toBe(null);
    });

    it("recallStoreForHost drops malformed entries", async () => {
      const pasejo = loadPasejo();
      const stub = storageStub({
        "pasejo:host-stores": {
          "a.com": { store: 123, lastUsedAt: 1 },
          "b.com": "nope",
        },
      });
      expect(await pasejo.recallStoreForHost(stub, "a.com")).toBe(null);
      expect(await pasejo.recallStoreForHost(stub, "b.com")).toBe(null);
    });
  });
});
