// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { loadClassicScript } from "./helpers/load-script.js";
import { makeApiMock } from "./helpers/mock-api.js";
import { buildPopupDom } from "./helpers/popup-dom.js";

const EXPOSED = [
  "ALL_STORES",
  "MAX_REMEMBERED_HOSTS",
  "MAX_STATUS_CHARS",
  "STORE_MEMORY_PREFIX",
  "STORE_MEMORY_INDEX_KEY",
  "truncateStatus",
  "setStatus",
  "sendBackground",
  "activeHostname",
  "loadActiveTab",
  "loadStores",
  "isCompatibleProtocol",
  "renderStores",
  "pickPreferredStore",
  "rememberStoreForHost",
  "recallStoreForHost",
  "touchHostInIndex",
  "dropHostFromIndex",
  "renderHostError",
  "runQuery",
  "runMultiStoreQuery",
  "showMatches",
  "renderMatch",
  "button",
  "fillIntoActiveTab",
  "fillAcrossFrames",
  "listFrames",
  "main",
  "refreshStoresAndQuery",
  "elements",
  "state",
];

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// popup.js calls `main()` immediately on load — there is no
// "don't autostart" knob. `setUp` therefore lets that initial main()
// settle against a benign default mock, then drains all call history so
// tests start with clean spies. Tests that care about the bootstrap
// behaviour pass their own mocks and assert on the state main() leaves
// behind without going through this reset.
async function setUp({
  tabs = [{ id: 7, url: "https://example.com/login" }],
} = {}) {
  const api = makeApiMock();
  api.tabs.query = vi.fn().mockResolvedValue(tabs);
  api.runtime.sendMessage = vi.fn().mockResolvedValue({
    ok: true,
    response: {
      protocol_version: 1,
      stores: [{ name: "personal", default: true }],
      results: [],
    },
  });
  api.storage.local.get = vi.fn().mockResolvedValue({});
  api.storage.local.set = vi.fn().mockResolvedValue();
  api.storage.local.remove = vi.fn().mockResolvedValue();
  api.webNavigation.getAllFrames = vi
    .fn()
    .mockResolvedValue([{ frameId: 0 }, { frameId: 1 }]);
  globalThis.chrome = api;
  buildPopupDom(document);
  loadClassicScript("src/protocol.js");
  const popup = loadClassicScript("src/popup/popup.js", { expose: EXPOSED });
  await flushAsync();
  await flushAsync();
  api.runtime.sendMessage.mockClear();
  api.tabs.query.mockClear();
  api.storage.local.get.mockClear();
  api.storage.local.set.mockClear();
  api.storage.local.remove.mockClear();
  api.webNavigation.getAllFrames.mockClear();
  popup.elements.status.textContent = "";
  popup.elements.status.classList.remove("error");
  popup.elements.results.replaceChildren();
  popup.elements.store.replaceChildren();
  popup.state.domain = null;
  popup.state.store = null;
  popup.state.stores = [];
  popup.state.protocolOk = false;
  popup.state.filling = false;
  popup.state.refreshing = false;
  return { api, popup };
}

describe("popup.js", () => {
  beforeEach(() => {
    delete globalThis.PASEJO;
    delete globalThis.browser;
    delete globalThis.chrome;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.PASEJO;
    delete globalThis.browser;
    delete globalThis.chrome;
    document.body.innerHTML = "";
  });

  describe("activeHostname (item K — IPv6 unbracketing)", () => {
    it("returns the bare hostname for normal HTTPS URLs", async () => {
      const { popup } = await setUp();
      expect(popup.activeHostname("https://example.com/login")).toBe(
        "example.com",
      );
    });

    it("strips user-info and port", async () => {
      const { popup } = await setUp();
      expect(
        popup.activeHostname("https://alice:pw@example.com:8443/login"),
      ).toBe("example.com");
    });

    it("strips the wrapping brackets from IPv6 literals (item K)", async () => {
      const { popup } = await setUp();
      expect(popup.activeHostname("https://[::1]/login")).toBe("::1");
      expect(popup.activeHostname("https://[fe80::1234]:8443/x")).toBe(
        "fe80::1234",
      );
    });

    it("returns null for malformed URLs", async () => {
      const { popup } = await setUp();
      expect(popup.activeHostname("not a url")).toBeNull();
    });

    it("returns null when the hostname is empty (e.g. file:/// URLs)", async () => {
      const { popup } = await setUp();
      expect(popup.activeHostname("file:///etc/hosts")).toBeNull();
    });
  });

  describe("isCompatibleProtocol", () => {
    it("accepts version 1", async () => {
      const { popup } = await setUp();
      expect(popup.isCompatibleProtocol(1)).toBe(true);
    });

    it("rejects 0 and 2", async () => {
      const { popup } = await setUp();
      expect(popup.isCompatibleProtocol(0)).toBe(false);
      expect(popup.isCompatibleProtocol(2)).toBe(false);
    });

    it("rejects non-number values", async () => {
      const { popup } = await setUp();
      expect(popup.isCompatibleProtocol("1")).toBe(false);
      expect(popup.isCompatibleProtocol(null)).toBe(false);
      expect(popup.isCompatibleProtocol(undefined)).toBe(false);
    });
  });

  describe("truncateStatus (pure helper, item P)", () => {
    it("returns empty text and no title for null input", async () => {
      const { popup } = await setUp();
      expect(popup.truncateStatus(null)).toEqual({ text: "", title: null });
    });

    it("returns empty text and no title for undefined input", async () => {
      const { popup } = await setUp();
      expect(popup.truncateStatus(undefined)).toEqual({
        text: "",
        title: null,
      });
    });

    it("returns empty text and no title for an empty string", async () => {
      const { popup } = await setUp();
      expect(popup.truncateStatus("")).toEqual({ text: "", title: null });
    });

    it("passes a short string through unchanged with no title", async () => {
      const { popup } = await setUp();
      expect(popup.truncateStatus("hello")).toEqual({
        text: "hello",
        title: null,
      });
    });

    it("passes a string at exactly the cap through unchanged", async () => {
      const { popup } = await setUp();
      const exact = "a".repeat(popup.MAX_STATUS_CHARS);
      expect(popup.truncateStatus(exact)).toEqual({ text: exact, title: null });
    });

    it("truncates a string one over the cap and preserves the original as the title", async () => {
      const { popup } = await setUp();
      const over = "a".repeat(popup.MAX_STATUS_CHARS + 1);
      const { text, title } = popup.truncateStatus(over);
      expect(Array.from(text)).toHaveLength(popup.MAX_STATUS_CHARS);
      expect(text.endsWith("…")).toBe(true);
      expect(title).toBe(over);
    });

    it("truncates a very long string to exactly MAX_STATUS_CHARS code points (including the ellipsis)", async () => {
      const { popup } = await setUp();
      const huge = "x".repeat(2000);
      const { text, title } = popup.truncateStatus(huge);
      expect(Array.from(text)).toHaveLength(popup.MAX_STATUS_CHARS);
      expect(text.endsWith("…")).toBe(true);
      expect(title).toBe(huge);
    });

    it("treats surrogate-pair emoji as single code points so the boundary doesn't split a glyph", async () => {
      const { popup } = await setUp();
      // 200 key-emoji characters: each emoji is 1 code point but 2
      // UTF-16 units, so a naive `.slice` would break the cut.
      const text = "🔑".repeat(200);
      const result = popup.truncateStatus(text);
      const codepoints = Array.from(result.text);
      expect(codepoints).toHaveLength(popup.MAX_STATUS_CHARS);
      // The trailing character is the ellipsis, and every other
      // character is the full emoji (no half-surrogates leaked).
      expect(codepoints[codepoints.length - 1]).toBe("…");
      for (let i = 0; i < codepoints.length - 1; i += 1) {
        expect(codepoints[i]).toBe("🔑");
      }
      expect(result.title).toBe(text);
    });

    it("does NOT truncate an emoji-only string whose code-point length fits the cap (UTF-16 length would over-count)", async () => {
      const { popup } = await setUp();
      // Each emoji is 2 UTF-16 units; MAX_STATUS_CHARS emoji = 2 * MAX
      // UTF-16 units. The function counts code points, not units.
      const text = "🔑".repeat(popup.MAX_STATUS_CHARS);
      const result = popup.truncateStatus(text);
      expect(result.text).toBe(text);
      expect(result.title).toBeNull();
    });
  });

  describe("setStatus", () => {
    it("writes the message and resets to status role for informational text", async () => {
      const { popup } = await setUp();
      popup.setStatus("hello");
      expect(popup.elements.status.textContent).toBe("hello");
      expect(popup.elements.status.getAttribute("role")).toBe("status");
      expect(popup.elements.status.getAttribute("aria-live")).toBe("polite");
      expect(popup.elements.status.classList.contains("error")).toBe(false);
    });

    it("switches to alert role and assertive aria-live for errors", async () => {
      const { popup } = await setUp();
      popup.setStatus("boom", "error");
      expect(popup.elements.status.getAttribute("role")).toBe("alert");
      expect(popup.elements.status.getAttribute("aria-live")).toBe("assertive");
      expect(popup.elements.status.classList.contains("error")).toBe(true);
    });

    it("clears the message when called with no text", async () => {
      const { popup } = await setUp();
      popup.setStatus("first");
      popup.setStatus();
      expect(popup.elements.status.textContent).toBe("");
    });

    it("does not set a title attribute for short messages (item P)", async () => {
      const { popup } = await setUp();
      popup.setStatus("short message");
      expect(popup.elements.status.hasAttribute("title")).toBe(false);
    });

    it("truncates long messages in textContent and stashes the full text in the title attribute", async () => {
      const { popup } = await setUp();
      const longMessage = `boom ${"a".repeat(popup.MAX_STATUS_CHARS + 50)}`;
      popup.setStatus(longMessage, "error");
      expect(
        Array.from(popup.elements.status.textContent),
      ).toHaveLength(popup.MAX_STATUS_CHARS);
      expect(popup.elements.status.textContent.endsWith("…")).toBe(true);
      expect(popup.elements.status.getAttribute("title")).toBe(longMessage);
    });

    it("removes a stale title attribute when a long message is replaced by a short one", async () => {
      const { popup } = await setUp();
      popup.setStatus("z".repeat(popup.MAX_STATUS_CHARS + 50), "error");
      expect(popup.elements.status.hasAttribute("title")).toBe(true);
      popup.setStatus("short again");
      expect(popup.elements.status.hasAttribute("title")).toBe(false);
    });
  });

  describe("sendBackground", () => {
    it("returns the response when the background reports ok", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: { foo: "bar" },
      });
      await expect(
        popup.sendBackground({ type: "list_stores" }),
      ).resolves.toEqual({ foo: "bar" });
    });

    it("throws when the background returns no reply at all", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage.mockResolvedValueOnce(undefined);
      await expect(
        popup.sendBackground({ type: "list_stores" }),
      ).rejects.toThrow("empty reply from background");
    });

    it("throws when the background returns ok=false", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: false,
        error: "host crashed",
      });
      await expect(
        popup.sendBackground({ type: "list_stores" }),
      ).rejects.toThrow("host crashed");
    });

    it("uses a fallback message when ok=false has no error field", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage.mockResolvedValueOnce({ ok: false });
      await expect(
        popup.sendBackground({ type: "list_stores" }),
      ).rejects.toThrow("background error");
    });

    it("rejects a malformed response payload (null)", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: null,
      });
      await expect(
        popup.sendBackground({ type: "list_stores" }),
      ).rejects.toThrow(/not an object/);
    });

    it("rejects a malformed response payload (primitive)", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: 42,
      });
      await expect(
        popup.sendBackground({ type: "list_stores" }),
      ).rejects.toThrow(/not an object/);
    });
  });

  describe("loadActiveTab", () => {
    it("returns null when there is no tab", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([]);
      await expect(popup.loadActiveTab()).resolves.toBeNull();
    });

    it("returns null when the tab has no url (extension/about pages)", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([{ id: 3 }]);
      await expect(popup.loadActiveTab()).resolves.toBeNull();
    });

    it("returns { id, hostname } for a normal page", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([
        { id: 9, url: "https://demo.test/login" },
      ]);
      await expect(popup.loadActiveTab()).resolves.toEqual({
        id: 9,
        hostname: "demo.test",
      });
    });
  });

  describe("renderStores", () => {
    it("inserts an 'All stores' entry only when more than one store exists", async () => {
      const { popup } = await setUp();
      popup.renderStores([{ name: "only", default: true }], null);
      expect(
        Array.from(popup.elements.store.options).map((o) => o.value),
      ).toEqual(["only"]);
      popup.renderStores(
        [
          { name: "a", default: true },
          { name: "b", default: false },
        ],
        null,
      );
      expect(
        Array.from(popup.elements.store.options).map((o) => o.value),
      ).toEqual([popup.ALL_STORES, "a", "b"]);
    });

    it("selects the preferred store when supplied", async () => {
      const { popup } = await setUp();
      popup.renderStores(
        [
          { name: "a", default: true },
          { name: "b", default: false },
        ],
        "b",
      );
      // happy-dom's HTMLSelectElement does not compute `.value` from
      // `option.selected = true` writes the way Chrome does, so we
      // assert on the option flag directly. The source still drives
      // `state.store` off the select's value — that side is exercised
      // end-to-end by the bootstrap-behaviour tests further down.
      const optionB = Array.from(popup.elements.store.options).find(
        (o) => o.value === "b",
      );
      expect(optionB.selected).toBe(true);
    });

    it("selects the All-stores sentinel when preferred", async () => {
      const { popup } = await setUp();
      popup.renderStores(
        [
          { name: "a", default: false },
          { name: "b", default: true },
        ],
        popup.ALL_STORES,
      );
      expect(popup.elements.store.value).toBe(popup.ALL_STORES);
    });

    it("falls back to the default-marked store when no preferred name", async () => {
      const { popup } = await setUp();
      popup.renderStores(
        [
          { name: "a", default: false },
          { name: "b", default: true },
        ],
        null,
      );
      const optionB = Array.from(popup.elements.store.options).find(
        (o) => o.value === "b",
      );
      expect(optionB.selected).toBe(true);
    });

    it("appends `(default)` to the displayed label of the default store", async () => {
      const { popup } = await setUp();
      popup.renderStores(
        [
          { name: "a", default: false },
          { name: "b", default: true },
        ],
        null,
      );
      const labels = Array.from(popup.elements.store.options).map(
        (o) => o.textContent,
      );
      expect(labels).toContain("a");
      expect(labels).toContain("b (default)");
    });

    it("populates state.stores and writes elements titles for hover hint", async () => {
      const { popup } = await setUp();
      popup.renderStores(
        [
          { name: "long-store-name-that-truncates", default: true },
          { name: "another", default: false },
        ],
        null,
      );
      expect(popup.state.stores).toHaveLength(2);
      const titles = Array.from(popup.elements.store.options)
        .filter((o) => o.value !== popup.ALL_STORES)
        .map((o) => o.title);
      expect(titles).toEqual(["long-store-name-that-truncates", "another"]);
    });

    it("sets state.store to null when the select is empty", async () => {
      const { popup } = await setUp();
      popup.renderStores([], null);
      expect(popup.state.store).toBeNull();
    });
  });

  describe("pickPreferredStore", () => {
    it("returns null when nothing is remembered for the host", async () => {
      const { popup } = await setUp();
      await expect(
        popup.pickPreferredStore([], "example.com"),
      ).resolves.toBeNull();
    });

    it("returns ALL_STORES when remembered and multiple stores exist", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        "store-for-host:example.com": popup.ALL_STORES,
      });
      await expect(
        popup.pickPreferredStore(
          [
            { name: "a", default: true },
            { name: "b", default: false },
          ],
          "example.com",
        ),
      ).resolves.toBe(popup.ALL_STORES);
    });

    it("falls back from ALL_STORES to null when only one store exists", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        "store-for-host:example.com": popup.ALL_STORES,
      });
      await expect(
        popup.pickPreferredStore([{ name: "a", default: true }], "example.com"),
      ).resolves.toBeNull();
    });

    it("returns the remembered store name when it still exists in the list", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        "store-for-host:example.com": "b",
      });
      await expect(
        popup.pickPreferredStore(
          [
            { name: "a", default: true },
            { name: "b", default: false },
          ],
          "example.com",
        ),
      ).resolves.toBe("b");
    });

    it("returns null when the remembered store has since been deleted", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        "store-for-host:example.com": "gone",
      });
      await expect(
        popup.pickPreferredStore(
          [{ name: "a", default: true }],
          "example.com",
        ),
      ).resolves.toBeNull();
    });
  });

  describe("rememberStoreForHost / recallStoreForHost", () => {
    it("stores under the per-host prefix when both args are present", async () => {
      const { api, popup } = await setUp();
      await popup.rememberStoreForHost("example.com", "personal");
      expect(api.storage.local.set).toHaveBeenCalledWith({
        "store-for-host:example.com": "personal",
      });
    });

    it("removes the key when the store argument is null/empty", async () => {
      const { api, popup } = await setUp();
      await popup.rememberStoreForHost("example.com", "");
      expect(api.storage.local.remove).toHaveBeenCalledWith(
        "store-for-host:example.com",
      );
    });

    it("no-ops without throwing when hostname is missing", async () => {
      const { api, popup } = await setUp();
      await popup.rememberStoreForHost(null, "personal");
      expect(api.storage.local.set).not.toHaveBeenCalled();
    });

    it("no-ops without throwing when storage.local is unavailable", async () => {
      const { api, popup } = await setUp();
      api.storage.local = undefined;
      await popup.rememberStoreForHost("example.com", "personal");
    });

    it("swallows storage write failures so the popup keeps working", async () => {
      const { api, popup } = await setUp();
      api.storage.local.set.mockRejectedValueOnce(new Error("quota exceeded"));
      await expect(
        popup.rememberStoreForHost("example.com", "personal"),
      ).resolves.toBeUndefined();
    });

    it("recall returns the stored value", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        "store-for-host:example.com": "personal",
      });
      await expect(popup.recallStoreForHost("example.com")).resolves.toBe(
        "personal",
      );
    });

    it("recall returns null when no entry exists", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({});
      await expect(popup.recallStoreForHost("example.com")).resolves.toBeNull();
    });

    it("recall returns null without throwing when hostname is missing", async () => {
      const { popup } = await setUp();
      await expect(popup.recallStoreForHost(null)).resolves.toBeNull();
    });

    it("recall returns null without throwing when storage.local is missing", async () => {
      const { api, popup } = await setUp();
      api.storage.local = undefined;
      await expect(popup.recallStoreForHost("example.com")).resolves.toBeNull();
    });

    it("recall swallows storage.get failures", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockRejectedValueOnce(new Error("disk gone"));
      await expect(popup.recallStoreForHost("example.com")).resolves.toBeNull();
    });
  });

  describe("per-host memory eviction (item N)", () => {
    it("appends new hosts to the index in touch order", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          [popup.STORE_MEMORY_INDEX_KEY]: ["example.com"],
        })
        .mockResolvedValueOnce({
          [popup.STORE_MEMORY_INDEX_KEY]: ["example.com", "github.com"],
        });
      await popup.rememberStoreForHost("example.com", "a");
      await popup.rememberStoreForHost("github.com", "a");
      await popup.rememberStoreForHost("gitlab.com", "a");
      expect(api.storage.local.set).toHaveBeenCalledWith({
        [popup.STORE_MEMORY_INDEX_KEY]: ["example.com"],
      });
      expect(api.storage.local.set).toHaveBeenCalledWith({
        [popup.STORE_MEMORY_INDEX_KEY]: ["example.com", "github.com"],
      });
      expect(api.storage.local.set).toHaveBeenCalledWith({
        [popup.STORE_MEMORY_INDEX_KEY]: ["example.com", "github.com", "gitlab.com"],
      });
    });

    it("re-touching an existing host moves it to the end without duplicating", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.STORE_MEMORY_INDEX_KEY]: ["a.test", "b.test", "c.test"],
      });
      await popup.rememberStoreForHost("a.test", "personal");
      expect(api.storage.local.set).toHaveBeenCalledWith({
        [popup.STORE_MEMORY_INDEX_KEY]: ["b.test", "c.test", "a.test"],
      });
    });

    it("treats a missing index key as empty", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({}); // no index key
      await popup.rememberStoreForHost("new.test", "personal");
      expect(api.storage.local.set).toHaveBeenCalledWith({
        [popup.STORE_MEMORY_INDEX_KEY]: ["new.test"],
      });
    });

    it("treats a corrupt (non-array) index value as empty", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.STORE_MEMORY_INDEX_KEY]: "i-am-broken",
      });
      await popup.rememberStoreForHost("new.test", "personal");
      expect(api.storage.local.set).toHaveBeenCalledWith({
        [popup.STORE_MEMORY_INDEX_KEY]: ["new.test"],
      });
    });

    it("evicts the oldest host (and its storage entry) when the cap is exceeded", async () => {
      const { api, popup } = await setUp();
      // Seed a full index. Touching a brand-new host pushes the cap
      // over and must drop the front of the index — both from the
      // index itself and from `chrome.storage.local`.
      const fullIndex = Array.from(
        { length: popup.MAX_REMEMBERED_HOSTS },
        (_, i) => `host${i}.test`,
      );
      api.storage.local.get.mockResolvedValueOnce({
        [popup.STORE_MEMORY_INDEX_KEY]: [...fullIndex],
      });
      await popup.rememberStoreForHost("new.test", "personal");
      expect(api.storage.local.remove).toHaveBeenCalledWith(
        `${popup.STORE_MEMORY_PREFIX}host0.test`,
      );
      const expectedIndex = [
        ...Array.from(
          { length: popup.MAX_REMEMBERED_HOSTS - 1 },
          (_, i) => `host${i + 1}.test`,
        ),
        "new.test",
      ];
      expect(api.storage.local.set).toHaveBeenCalledWith({
        [popup.STORE_MEMORY_INDEX_KEY]: expectedIndex,
      });
    });

    it("evicts every overflowing host in one call when the seed index is multiple over the cap", async () => {
      const { api, popup } = await setUp();
      // An index that is two over the cap (could happen after a manual
      // import or a cap change in a future release) must be trimmed
      // back to exactly `MAX_REMEMBERED_HOSTS` entries in one go.
      const overflowIndex = Array.from(
        { length: popup.MAX_REMEMBERED_HOSTS + 1 },
        (_, i) => `host${i}.test`,
      );
      api.storage.local.get.mockResolvedValueOnce({
        [popup.STORE_MEMORY_INDEX_KEY]: [...overflowIndex],
      });
      await popup.rememberStoreForHost("new.test", "personal");
      expect(api.storage.local.remove).toHaveBeenCalledWith(
        `${popup.STORE_MEMORY_PREFIX}host0.test`,
      );
      expect(api.storage.local.remove).toHaveBeenCalledWith(
        `${popup.STORE_MEMORY_PREFIX}host1.test`,
      );
      // After two evictions the surviving index has exactly the cap's
      // worth of entries — `MAX_REMEMBERED_HOSTS - 1` originals plus
      // the new one.
      const indexCall = api.storage.local.set.mock.calls.find(
        ([arg]) => popup.STORE_MEMORY_INDEX_KEY in arg,
      );
      expect(indexCall[0][popup.STORE_MEMORY_INDEX_KEY]).toHaveLength(
        popup.MAX_REMEMBERED_HOSTS,
      );
    });

    it("removes the host from the index when the store is cleared", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.STORE_MEMORY_INDEX_KEY]: ["a.test", "b.test", "c.test"],
      });
      await popup.rememberStoreForHost("b.test", "");
      expect(api.storage.local.remove).toHaveBeenCalledWith(
        `${popup.STORE_MEMORY_PREFIX}b.test`,
      );
      expect(api.storage.local.set).toHaveBeenCalledWith({
        [popup.STORE_MEMORY_INDEX_KEY]: ["a.test", "c.test"],
      });
    });

    it("clearing a host that was never in the index does not rewrite it", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.STORE_MEMORY_INDEX_KEY]: ["a.test", "b.test"],
      });
      await popup.rememberStoreForHost("never-seen.test", "");
      // The host entry remove call always fires; the index set call
      // must NOT because nothing in the index changed.
      expect(api.storage.local.remove).toHaveBeenCalledWith(
        `${popup.STORE_MEMORY_PREFIX}never-seen.test`,
      );
      const indexWrites = api.storage.local.set.mock.calls.filter(
        ([arg]) => popup.STORE_MEMORY_INDEX_KEY in arg,
      );
      expect(indexWrites).toHaveLength(0);
    });

    it("clearing a host when the index is missing/corrupt is a no-op", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({});
      await popup.rememberStoreForHost("a.test", "");
      const indexWrites = api.storage.local.set.mock.calls.filter(
        ([arg]) => popup.STORE_MEMORY_INDEX_KEY in arg,
      );
      expect(indexWrites).toHaveLength(0);
    });
  });

  describe("renderHostError", () => {
    it("writes known-error copy for a known error kind", async () => {
      const { popup } = await setUp();
      popup.renderHostError({ error: "identity_locked" });
      expect(popup.elements.status.textContent).toMatch(/Could not decrypt/);
      expect(popup.elements.status.classList.contains("error")).toBe(true);
    });

    it("falls back to a generic message for unknown error kinds", async () => {
      const { popup } = await setUp();
      popup.renderHostError({ error: "fnord", hint: "wat" });
      expect(popup.elements.status.textContent).toMatch(/Host returned fnord/);
      expect(popup.elements.status.textContent).toMatch(/\(wat\)/);
    });

    it("returns null so callers can `return renderHostError(reply)`", async () => {
      const { popup } = await setUp();
      expect(popup.renderHostError({ error: "decode_error" })).toBeNull();
    });
  });

  describe("loadStores", () => {
    it("resets protocolOk at the start of every call", async () => {
      const { api, popup } = await setUp();
      popup.state.protocolOk = true;
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: false,
        error: "boom",
      });
      const result = await popup.loadStores();
      expect(result).toBeNull();
      expect(popup.state.protocolOk).toBe(false);
    });

    it("returns the stores array on success", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: {
          protocol_version: 1,
          stores: [{ name: "personal", default: true }],
        },
      });
      const stores = await popup.loadStores();
      expect(stores).toEqual([{ name: "personal", default: true }]);
      expect(popup.state.protocolOk).toBe(true);
    });

    it("defaults to [] when the host returns no stores field", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: { protocol_version: 1 },
      });
      const stores = await popup.loadStores();
      expect(stores).toEqual([]);
    });

    it("surfaces a transport failure into the status line", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: false,
        error: "host crashed",
      });
      const result = await popup.loadStores();
      expect(result).toBeNull();
      expect(popup.elements.status.textContent).toMatch(/Could not reach/);
    });

    it("renders a host error reply via renderHostError", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: { error: "identity_locked" },
      });
      const result = await popup.loadStores();
      expect(result).toBeNull();
      expect(popup.elements.status.textContent).toMatch(/decrypt/);
    });

    it("rejects an incompatible protocol_version", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: { protocol_version: 99, stores: [] },
      });
      const result = await popup.loadStores();
      expect(result).toBeNull();
      expect(popup.state.protocolOk).toBe(false);
      expect(popup.elements.status.textContent).toMatch(/protocol 99/);
    });

    it("formats the unknown-version case with `(unknown)` placeholder", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: { stores: [] },
      });
      const result = await popup.loadStores();
      expect(result).toBeNull();
      expect(popup.elements.status.textContent).toMatch(/\(unknown\)/);
    });

    it("rejects a malformed stores field (not an array)", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: { protocol_version: 1, stores: "broken" },
      });
      const result = await popup.loadStores();
      expect(result).toBeNull();
      expect(popup.elements.status.textContent).toMatch(/Malformed/);
    });
  });

  describe("runQuery / single-store path", () => {
    it("does nothing useful when no domain is set", async () => {
      const { popup } = await setUp();
      popup.state.domain = null;
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/No domain/);
    });

    it("fans the query to background and renders the results", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = "personal";
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: {
          results: [
            {
              name: "alice",
              username: "alice@example.com",
              password: "hunter2",
              match_kind: "url_field",
              score: 1,
            },
          ],
        },
      });
      await popup.runQuery();
      expect(api.runtime.sendMessage).toHaveBeenCalledWith({
        type: "query",
        domain: "example.com",
        store: "personal",
      });
      expect(popup.elements.results.children.length).toBe(1);
      expect(popup.elements.results.textContent).toMatch(/alice/);
    });

    it("renders 'No matches' for an empty result list", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: { results: [] },
      });
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/No matches/);
    });

    it("uses the singular noun for a single match and plural for many", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: {
          results: [
            { name: "a", match_kind: "name", score: 0.5 },
            { name: "b", match_kind: "name", score: 0.5 },
          ],
        },
      });
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/2 matches/);
    });

    it("surfaces a transport error into the status line", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: false,
        error: "boom",
      });
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/Could not reach/);
    });

    it("renders a host error reply via renderHostError", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: { error: "unknown_store" },
      });
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/does not exist/);
    });

    it("rejects a malformed results field (not an array)", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: { results: "broken" },
      });
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/Malformed/);
    });

    it("falls back to [] when results field is absent", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: {},
      });
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/No matches/);
    });

    it("posts the 'Searching for …' message after the 250 ms grace window", async () => {
      // Fake timers must be installed AFTER setUp finishes: setUp's
      // `flushAsync` relies on real `setTimeout`, which fake timers
      // would stall.
      const { api, popup } = await setUp();
      vi.useFakeTimers();
      popup.state.domain = "example.com";
      let resolveReply;
      api.runtime.sendMessage.mockReturnValueOnce(
        new Promise((r) => {
          resolveReply = r;
        }),
      );
      const queryDone = popup.runQuery();
      expect(popup.elements.status.textContent).toBe("");
      await vi.advanceTimersByTimeAsync(250);
      expect(popup.elements.status.textContent).toMatch(/Searching/);
      resolveReply({ ok: true, response: { results: [] } });
      await vi.runAllTimersAsync();
      await queryDone;
    });
  });

  describe("runMultiStoreQuery", () => {
    it("refuses to fan out without a protocol-verified host", async () => {
      const { popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = false;
      popup.state.stores = [{ name: "a" }, { name: "b" }];
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/Refusing multi-store/);
    });

    it("warns when no stores are configured", async () => {
      const { popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.stores = [];
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/No stores to search/);
    });

    it("merges results across stores and re-sorts by score", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }, { name: "b" }];
      api.runtime.sendMessage
        .mockResolvedValueOnce({
          ok: true,
          response: {
            results: [
              { name: "low", store: "a", match_kind: "name", score: 0.5 },
            ],
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          response: {
            results: [
              { name: "high", store: "b", match_kind: "url_field", score: 1 },
            ],
          },
        });
      await popup.runQuery();
      const names = Array.from(
        popup.elements.results.querySelectorAll(".name"),
      ).map((n) => n.textContent);
      expect(names).toEqual(["high", "low"]);
    });

    it("treats per-store errors as skipped, surfaces the count in the status", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "good" }, { name: "broken" }];
      api.runtime.sendMessage
        .mockResolvedValueOnce({
          ok: true,
          response: {
            results: [{ name: "x", match_kind: "name", score: 0.5 }],
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          response: { error: "identity_locked" },
        });
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/1 store\(s\) skipped/);
    });

    it("treats sendBackground throws as skipped", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }, { name: "b" }];
      api.runtime.sendMessage
        .mockRejectedValueOnce(new Error("net"))
        .mockResolvedValueOnce({
          ok: true,
          response: {
            results: [{ name: "x", match_kind: "name", score: 0.5 }],
          },
        });
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/1 store\(s\) skipped/);
    });

    it("treats a non-array results field as skipped", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }];
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: { results: "broken" },
      });
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/1 store\(s\) skipped/);
    });

    it("renders 'no matches' with skipped count when nothing matched anywhere", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }];
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: { results: [] },
      });
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/No matches/);
    });

    it("treats a missing score on a result as zero when sorting", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }, { name: "b" }];
      // Two stores so the second leg also produces a comparison call —
      // together the two compares cover both `?? 0` branches on both
      // sides of the subtraction.
      api.runtime.sendMessage
        .mockResolvedValueOnce({
          ok: true,
          response: {
            results: [
              { name: "high", match_kind: "name", score: 0.7 },
              { name: "no_score_b", match_kind: "name" },
            ],
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          response: {
            results: [
              { name: "no_score_a", match_kind: "name" },
              { name: "mid", match_kind: "name", score: 0.5 },
            ],
          },
        });
      await popup.runQuery();
      const names = Array.from(
        popup.elements.results.querySelectorAll(".name"),
      ).map((n) => n.textContent);
      // Sort is by descending score: 0.7, 0.5, then the two zero-scored
      // entries in stable insertion order.
      expect(names[0]).toBe("high");
      expect(names[1]).toBe("mid");
      expect(names.slice(2).sort()).toEqual(["no_score_a", "no_score_b"]);
    });
  });

  describe("showMatches", () => {
    it("uses 'errors' as the skipped-name fallback when names are omitted", async () => {
      const { popup } = await setUp();
      popup.state.domain = "example.com";
      popup.showMatches([], 2);
      expect(popup.elements.status.textContent).toMatch(/skipped: errors/);
    });

    it("includes the skipped-names list when provided alongside results", async () => {
      const { popup } = await setUp();
      popup.state.domain = "example.com";
      popup.showMatches(
        [{ name: "x", match_kind: "name", score: 0.5 }],
        2,
        ["a", "b"],
      );
      expect(popup.elements.status.textContent).toMatch(
        /2 store\(s\) skipped: a, b/,
      );
    });

    it("uses 'errors' fallback when skipped names are omitted but count > 0 and we have matches", async () => {
      const { popup } = await setUp();
      popup.state.domain = "example.com";
      popup.showMatches([{ name: "x", match_kind: "name", score: 0.5 }], 1);
      expect(popup.elements.status.textContent).toMatch(/skipped: errors/);
    });
  });

  describe("renderMatch", () => {
    it("renders name, kind badge, and optional username/otp/store fields", async () => {
      const { popup } = await setUp();
      const li = popup.renderMatch({
        name: "alice@example.com",
        match_kind: "url_field",
        score: 1,
        username: "alice",
        password: "hunter2",
        otp: "123456",
        store: "personal",
      });
      expect(li.tagName).toBe("LI");
      expect(li.getAttribute("role")).toBe("button");
      expect(li.tabIndex).toBe(0);
      expect(li.querySelector(".name").textContent).toBe("alice@example.com");
      expect(li.querySelector(".badge").textContent).toBe("url");
      const secondaries = Array.from(
        li.querySelector(".row-secondary").children,
      ).map((c) => c.textContent);
      expect(secondaries).toEqual(["alice", "OTP: 123456", "store: personal"]);
    });

    it("uses 'name' badge text for match_kind=name", async () => {
      const { popup } = await setUp();
      const li = popup.renderMatch({
        name: "x",
        match_kind: "name",
        score: 0.5,
      });
      expect(li.querySelector(".badge").textContent).toBe("name");
    });

    it("clicking the row dispatches fillIntoActiveTab", async () => {
      const { api, popup } = await setUp();
      api.tabs.sendMessage = vi
        .fn()
        .mockResolvedValue({
          ok: true,
          filled: { username: true, password: true },
        });
      api.tabs.query.mockResolvedValueOnce([
        { id: 7, url: "https://example.com" },
      ]);
      const li = popup.renderMatch({
        name: "alice",
        username: "alice",
        password: "p",
        match_kind: "name",
        score: 0.5,
      });
      popup.elements.results.appendChild(li);
      li.click();
      await flushAsync();
      expect(api.tabs.sendMessage).toHaveBeenCalled();
    });

    it("Enter and Space on the row trigger fill, other keys do not", async () => {
      const { api, popup } = await setUp();
      api.tabs.sendMessage = vi
        .fn()
        .mockResolvedValue({
          ok: true,
          filled: { username: true, password: true },
        });
      api.tabs.query.mockResolvedValue([{ id: 7, url: "https://example.com" }]);
      const li = popup.renderMatch({
        name: "alice",
        username: "alice",
        password: "p",
        match_kind: "name",
        score: 0.5,
      });
      popup.elements.results.appendChild(li);
      const e1 = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
      li.dispatchEvent(e1);
      await flushAsync();
      expect(api.tabs.sendMessage).toHaveBeenCalled();

      api.tabs.sendMessage.mockClear();
      popup.state.filling = false;
      const e2 = new KeyboardEvent("keydown", { key: " ", bubbles: true });
      li.dispatchEvent(e2);
      await flushAsync();
      expect(api.tabs.sendMessage).toHaveBeenCalled();

      api.tabs.sendMessage.mockClear();
      popup.state.filling = false;
      const e3 = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
      li.dispatchEvent(e3);
      await flushAsync();
      expect(api.tabs.sendMessage).not.toHaveBeenCalled();
    });

    it("keydown on the inner Fill button does NOT bubble into a second fill", async () => {
      const { api, popup } = await setUp();
      api.tabs.sendMessage = vi
        .fn()
        .mockResolvedValue({
          ok: true,
          filled: { username: true, password: true },
        });
      const li = popup.renderMatch({
        name: "alice",
        username: "alice",
        password: "p",
        match_kind: "name",
        score: 0.5,
      });
      popup.elements.results.appendChild(li);
      const fillBtn = li.querySelector(".actions button");
      const e = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      });
      Object.defineProperty(e, "target", { value: fillBtn, configurable: true });
      li.dispatchEvent(e);
      await flushAsync();
      expect(api.tabs.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("button helper", () => {
    it("creates a typed button that stops click propagation", async () => {
      const { popup } = await setUp();
      const calls = [];
      const btn = popup.button("Fill", () => calls.push("fill"));
      expect(btn.tagName).toBe("BUTTON");
      expect(btn.type).toBe("button");
      const parent = document.createElement("div");
      const parentHandler = vi.fn();
      parent.addEventListener("click", parentHandler);
      parent.appendChild(btn);
      btn.click();
      expect(calls).toEqual(["fill"]);
      expect(parentHandler).not.toHaveBeenCalled();
    });
  });

  describe("listFrames", () => {
    it("returns [0] when webNavigation.getAllFrames is unavailable", async () => {
      const { api, popup } = await setUp();
      api.webNavigation = undefined;
      await expect(popup.listFrames(1)).resolves.toEqual([0]);
    });

    it("returns the frameIds reported by webNavigation", async () => {
      const { api, popup } = await setUp();
      api.webNavigation.getAllFrames.mockResolvedValueOnce([
        { frameId: 0 },
        { frameId: 7 },
        { frameId: 9 },
      ]);
      await expect(popup.listFrames(2)).resolves.toEqual([0, 7, 9]);
    });

    it("returns [0] when getAllFrames returns empty (tab closed mid-flight)", async () => {
      const { api, popup } = await setUp();
      api.webNavigation.getAllFrames.mockResolvedValueOnce([]);
      await expect(popup.listFrames(2)).resolves.toEqual([0]);
    });

    it("returns [0] when getAllFrames throws (permission missing)", async () => {
      const { api, popup } = await setUp();
      api.webNavigation.getAllFrames.mockRejectedValueOnce(new Error("nope"));
      await expect(popup.listFrames(2)).resolves.toEqual([0]);
    });
  });

  describe("fillAcrossFrames", () => {
    it("walks frames in order and returns the first ok reply", async () => {
      const { api, popup } = await setUp();
      api.webNavigation.getAllFrames.mockResolvedValueOnce([
        { frameId: 0 },
        { frameId: 1 },
        { frameId: 2 },
      ]);
      api.tabs.sendMessage = vi
        .fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({
          ok: true,
          filled: { username: true, password: true },
        })
        .mockResolvedValueOnce({ ok: true });
      const reply = await popup.fillAcrossFrames(7, { type: "fill" });
      expect(reply.ok).toBe(true);
      expect(api.tabs.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("skips frames that throw (no content script) and tries the next", async () => {
      const { api, popup } = await setUp();
      api.webNavigation.getAllFrames.mockResolvedValueOnce([
        { frameId: 0 },
        { frameId: 1 },
      ]);
      api.tabs.sendMessage = vi
        .fn()
        .mockRejectedValueOnce(new Error("no receiver"))
        .mockResolvedValueOnce({ ok: true });
      const reply = await popup.fillAcrossFrames(7, { type: "fill" });
      expect(reply.ok).toBe(true);
    });

    it("returns { ok: false } when no frame reports success", async () => {
      const { api, popup } = await setUp();
      api.webNavigation.getAllFrames.mockResolvedValueOnce([{ frameId: 0 }]);
      api.tabs.sendMessage = vi.fn().mockResolvedValue({ ok: false });
      const reply = await popup.fillAcrossFrames(7, { type: "fill" });
      expect(reply).toEqual({ ok: false });
    });
  });

  describe("fillIntoActiveTab", () => {
    it("bails when no tab is active", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([]);
      await popup.fillIntoActiveTab({ name: "x" });
      expect(popup.elements.status.textContent).toMatch(/No active tab/);
      expect(popup.state.filling).toBe(false);
    });

    it("returns immediately on a re-entry while filling is in progress", async () => {
      const { api, popup } = await setUp();
      popup.state.filling = true;
      await popup.fillIntoActiveTab({ name: "x" });
      expect(api.tabs.query).not.toHaveBeenCalled();
    });

    it("renders the partial-fill message when only username was filled", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([
        { id: 1, url: "https://x.test" },
      ]);
      api.webNavigation.getAllFrames.mockResolvedValueOnce([{ frameId: 0 }]);
      api.tabs.sendMessage = vi.fn().mockResolvedValueOnce({
        ok: true,
        filled: { username: true, password: false },
      });
      await popup.fillIntoActiveTab({ name: "alice", username: "alice" });
      expect(popup.elements.status.textContent).toMatch(
        /Filled username for alice/,
      );
      expect(popup.elements.status.textContent).toMatch(/no password field/);
    });

    it("renders the full-fill success message", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([
        { id: 1, url: "https://x.test" },
      ]);
      api.webNavigation.getAllFrames.mockResolvedValueOnce([{ frameId: 0 }]);
      api.tabs.sendMessage = vi.fn().mockResolvedValueOnce({
        ok: true,
        filled: { username: true, password: true },
      });
      await popup.fillIntoActiveTab({
        name: "alice",
        username: "alice",
        password: "p",
      });
      expect(popup.elements.status.textContent).toBe("Filled alice.");
    });

    it("renders the generic 'no fillable input' error when every frame says ok:false", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([
        { id: 1, url: "https://x.test" },
      ]);
      api.webNavigation.getAllFrames.mockResolvedValueOnce([{ frameId: 0 }]);
      api.tabs.sendMessage = vi.fn().mockResolvedValueOnce({ ok: false });
      await popup.fillIntoActiveTab({ name: "alice", username: "alice" });
      expect(popup.elements.status.textContent).toMatch(/No frame/);
      expect(popup.state.filling).toBe(false);
    });

  });

  describe("refreshStoresAndQuery (helper, item Q)", () => {
    it("runs loadStores → pickPreferredStore → renderStores → runQuery in order on the happy path", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      api.runtime.sendMessage
        .mockResolvedValueOnce({
          ok: true,
          response: {
            protocol_version: 1,
            stores: [
              { name: "personal", default: true },
              { name: "work", default: false },
            ],
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          response: {
            results: [
              {
                name: "alice",
                username: "alice@example.com",
                password: "hunter2",
                match_kind: "url_field",
                score: 1,
              },
            ],
          },
        });
      api.storage.local.get.mockResolvedValue({
        "store-for-host:example.com": "work",
      });
      await popup.refreshStoresAndQuery();
      // list_stores then query — two background calls in order:
      const types = api.runtime.sendMessage.mock.calls.map((c) => c[0].type);
      expect(types).toEqual(["list_stores", "query"]);
      // The remembered store wins the dropdown selection:
      const work = Array.from(popup.elements.store.options).find(
        (o) => o.value === "work",
      );
      expect(work.selected).toBe(true);
      expect(popup.state.stores).toHaveLength(2);
      // The query is wired up against state.domain:
      expect(api.runtime.sendMessage).toHaveBeenLastCalledWith({
        type: "query",
        domain: "example.com",
        store: popup.state.store,
      });
      // And the result is rendered:
      expect(popup.elements.results.children.length).toBe(1);
      expect(popup.elements.results.textContent).toMatch(/alice/);
    });

    it("bails before pickPreferredStore / renderStores / runQuery when loadStores returns null", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: false,
        error: "host crashed",
      });
      await popup.refreshStoresAndQuery();
      expect(api.runtime.sendMessage).toHaveBeenCalledTimes(1);
      expect(api.storage.local.get).not.toHaveBeenCalled();
      expect(popup.elements.results.children.length).toBe(0);
      expect(popup.elements.status.textContent).toMatch(/Could not reach/);
    });

    it("looks up the per-host preference under state.domain (not whatever tab.hostname was when popup opened)", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "switched.example";
      api.runtime.sendMessage
        .mockResolvedValueOnce({
          ok: true,
          response: {
            protocol_version: 1,
            stores: [{ name: "personal", default: true }],
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          response: { results: [] },
        });
      api.storage.local.get.mockResolvedValue({});
      await popup.refreshStoresAndQuery();
      expect(api.storage.local.get).toHaveBeenCalledWith(
        "store-for-host:switched.example",
      );
    });
  });

  describe("main()", () => {
    it("populates state.domain from the active tab and reports a 'no domain' message when missing", async () => {
      delete globalThis.PASEJO;
      delete globalThis.chrome;
      const api = makeApiMock();
      api.tabs.query = vi.fn().mockResolvedValue([]);
      api.runtime.sendMessage = vi.fn();
      api.storage.local.get = vi.fn().mockResolvedValue({});
      api.storage.local.set = vi.fn();
      api.storage.local.remove = vi.fn();
      globalThis.chrome = api;
      buildPopupDom(document);
      loadClassicScript("src/protocol.js");
      const popup = loadClassicScript("src/popup/popup.js", {
        expose: EXPOSED,
      });
      await flushAsync();
      await flushAsync();
      expect(popup.elements.status.textContent).toMatch(/No active tab/);
    });

    it("renders '(no domain)' for tabs whose URL parses to no hostname", async () => {
      delete globalThis.PASEJO;
      delete globalThis.chrome;
      const api = makeApiMock();
      api.tabs.query = vi
        .fn()
        .mockResolvedValue([{ id: 1, url: "about:blank" }]);
      api.runtime.sendMessage = vi.fn().mockResolvedValue({
        ok: true,
        response: {
          protocol_version: 1,
          stores: [{ name: "personal", default: true }],
          results: [],
        },
      });
      api.storage.local.get = vi.fn().mockResolvedValue({});
      api.storage.local.set = vi.fn();
      api.storage.local.remove = vi.fn();
      api.webNavigation.getAllFrames = vi
        .fn()
        .mockResolvedValue([{ frameId: 0 }]);
      globalThis.chrome = api;
      buildPopupDom(document);
      loadClassicScript("src/protocol.js");
      const popup = loadClassicScript("src/popup/popup.js", {
        expose: EXPOSED,
      });
      await flushAsync();
      await flushAsync();
      expect(popup.elements.domain.textContent).toBe("(no domain)");
      expect(popup.elements.status.textContent).toMatch(/No domain/);
    });

    it("aborts before runQuery when loadStores returns null", async () => {
      delete globalThis.PASEJO;
      delete globalThis.chrome;
      const api = makeApiMock();
      api.tabs.query = vi
        .fn()
        .mockResolvedValue([{ id: 1, url: "https://example.com" }]);
      api.runtime.sendMessage = vi.fn().mockResolvedValue({
        ok: false,
        error: "host down",
      });
      api.storage.local.get = vi.fn().mockResolvedValue({});
      api.storage.local.set = vi.fn();
      api.storage.local.remove = vi.fn();
      globalThis.chrome = api;
      buildPopupDom(document);
      loadClassicScript("src/protocol.js");
      loadClassicScript("src/popup/popup.js", { expose: EXPOSED });
      await flushAsync();
      await flushAsync();
      expect(api.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("store-dropdown change and refresh-button click bootstrap behaviour", () => {
    it("change handler resets state.store to null when the select is empty", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      // Empty select — value getter returns "" so the fallback runs.
      popup.elements.store.replaceChildren();
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: { results: [] },
      });
      popup.elements.store.dispatchEvent(new Event("change"));
      await flushAsync();
      expect(popup.state.store).toBeNull();
    });

    it("change handler remembers the chosen store and re-runs the query", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.renderStores(
        [
          { name: "a", default: true },
          { name: "b", default: false },
        ],
        null,
      );
      popup.elements.store.value = "b";
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        response: { results: [] },
      });
      popup.elements.store.dispatchEvent(new Event("change"));
      await flushAsync();
      expect(api.storage.local.set).toHaveBeenCalledWith({
        "store-for-host:example.com": "b",
      });
      expect(api.runtime.sendMessage).toHaveBeenCalled();
    });

    it("refresh re-runs loadStores → runQuery and disables the button while in flight", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      api.runtime.sendMessage
        .mockResolvedValueOnce({
          ok: true,
          response: {
            protocol_version: 1,
            stores: [{ name: "personal", default: true }],
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          response: { results: [] },
        });
      popup.elements.refresh.click();
      expect(popup.elements.refresh.disabled).toBe(true);
      await flushAsync();
      await flushAsync();
      expect(popup.elements.refresh.disabled).toBe(false);
      expect(popup.state.refreshing).toBe(false);
    });

    it("refresh second-click is a no-op while one is already in flight", async () => {
      const { api, popup } = await setUp();
      popup.state.refreshing = true;
      popup.elements.refresh.click();
      expect(api.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("refresh stops at loadStores when it returns null", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      api.runtime.sendMessage.mockResolvedValueOnce({
        ok: false,
        error: "boom",
      });
      popup.elements.refresh.click();
      await flushAsync();
      await flushAsync();
      expect(api.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});
