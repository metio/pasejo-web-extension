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
  "HOST_STORE_KEY",
  "LEGACY_HOST_KEY_PREFIX",
  "LEGACY_HOST_INDEX_KEY",
  "reconcileLegacyStorage",
  "truncateStatus",
  "setStatus",
  "sendBackground",
  "activeHostname",
  "loadActiveTab",
  "loadStores",
  "isCompatibleProtocol",
  "renderStores",
  "readSelectedStore",
  "pickPreferredStore",
  "isPickStillValid",
  "rememberStoreForHost",
  "recallStoreForHost",
  "coerceHostStoreMap",
  "pruneMapToCap",
  "renderHostError",
  "runQuery",
  "runMultiStoreQuery",
  "showMatches",
  "renderMatch",
  "button",
  "fillIntoActiveTab",
  "needsConfirmation",
  "CONFIRM_ARM_DELAY_MS",
  "fillAcrossFrames",
  "injectFillScript",
  "createFrameCollector",
  "orderFramesForFill",
  "requestFill",
  "isSamePage",
  "originOf",
  "senderOrigin",
  "originHostname",
  "storedUrlHostname",
  "frameMatchesCredential",
  "hostMatchesSecret",
  "FRAME_HANDSHAKE_TIMEOUT_MS",
  "FRAME_FILL_TIMEOUT_MS",
  "main",
  "refreshStoresAndQuery",
  "elements",
  "state",
];

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Pretends to be the background side of the popup's streaming port.
// Posts each `replies` entry to the popup's onMessage listeners in
// order, with a microtask hop between them so the popup can repaint
// its incremental state, then closes the stream with `{type:"done"}`.
// Tests that want to assert on intermediate state (e.g. the progress
// counter after the second-of-three results lands) can call
// `pushStreamReply(api, reply)` directly instead.
async function driveStreamReplies(api, replies) {
  const pair = api.__streamPairs.at(-1);
  if (!pair) {
    throw new Error("popup never opened a streaming port");
  }
  for (const reply of replies) {
    pair.backgroundPort.postMessage(reply);
    await flushAsync();
  }
  pair.backgroundPort.postMessage({ type: "done" });
  await flushAsync();
}

function pushStreamReply(api, reply) {
  const pair = api.__streamPairs.at(-1);
  if (!pair) {
    throw new Error("popup never opened a streaming port");
  }
  pair.backgroundPort.postMessage(reply);
}

// Externally-controllable promise for racing two runQuery flows in a
// deterministic order: capture a `deferred()`, hand its `.promise`
// to a `mockReturnValueOnce`, then call `resolve()` whenever the test
// is ready for that response to arrive.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// The page `setUp`'s default tab shows, as `main()` records it.
const PAGE = Object.freeze({
  tabId: 7,
  origin: "https://example.com",
  hostname: "example.com",
});

const allowAll = async () => true;

// The credential the default host stub releases on a `reveal`.
const CREDENTIAL = Object.freeze({
  name: "alice",
  store: "personal",
  username: "alice",
  password: "hunter2",
});

// A `reveal` callback for `fillAcrossFrames` that releases `credential`.
function revealAs(credential = CREDENTIAL) {
  return vi.fn(async () => ({ credential }));
}

// The popup's background traffic as the host would answer it: a
// `reveal` gets `reveal` (a reply, or a function of the request; by
// default `CREDENTIAL` under the requested name and store), anything
// else the `results` listed for its domain.
function stubHost(api, { results = {}, reveal } = {}) {
  api.runtime.sendMessage = vi.fn(async (message) => {
    if (message.type === "reveal") {
      const response =
        typeof reveal === "function"
          ? reveal(message)
          : (reveal ?? {
              credential: {
                ...CREDENTIAL,
                name: message.name,
                store: message.store,
              },
            });
      return { ok: true, response };
    }
    return { ok: true, response: { results: results[message.domain] ?? [] } };
  });
}

// The `reveal` requests the popup sent so far.
function revealRequests(api) {
  return api.runtime.sendMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === "reveal");
}

// Stands in for `scripting.executeScript`: every entry in `frames`
// "runs" fill.js — opens a pasejo-frame port carrying the sender the
// browser would stamp, reports ready (unless `ready: false`), and answers
// a fill with its `fill` entry: a reply object, "disconnect", or
// "silent". Returns the ids of the frames that received a fill, in order.
function stubFrames(api, frames) {
  const filled = [];
  // The fill messages the frames received, in order.
  api.__fillMessages = [];
  api.scripting.executeScript = vi.fn(async ({ target }) => {
    const results = [];
    for (const frame of frames) {
      const port = api.__connectFromContent("pasejo-frame", {
        tab: { id: frame.tabId ?? target.tabId },
        frameId: frame.frameId,
        url: frame.url ?? "https://example.com/login",
        origin: frame.origin,
      });
      port.onMessage.addListener((message) => {
        if (message.type !== "fill") {
          return;
        }
        filled.push(frame.frameId);
        api.__fillMessages.push(message);
        const reply = frame.fill ?? { ok: false };
        if (reply === "disconnect") {
          port.disconnect();
          return;
        }
        if (reply === "silent") {
          return;
        }
        port.postMessage({ type: "fill-result", ...reply });
      });
      if (frame.ready !== false) {
        port.postMessage({
          type: "ready",
          focused: frame.focused === true,
          editableFocused: frame.editableFocused === true,
        });
      }
      results.push({ frameId: frame.frameId, result: true });
    }
    return results;
  });
  return filled;
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
  api.runtime.sendMessage = vi.fn(async (message) =>
    message?.type === "reveal"
      ? {
          ok: true,
          response: {
            credential: {
              ...CREDENTIAL,
              name: message.name,
              store: message.store,
            },
          },
        }
      : {
          ok: true,
          response: {
            protocol_version: 2,
            stores: [{ name: "personal", default: true }],
            results: [],
          },
        },
  );
  api.storage.local.get = vi.fn().mockResolvedValue({});
  api.storage.local.set = vi.fn().mockResolvedValue();
  api.storage.local.remove = vi.fn().mockResolvedValue();
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
  popup.elements.status.textContent = "";
  popup.elements.status.classList.remove("error");
  popup.elements.results.replaceChildren();
  popup.elements.store.replaceChildren();
  popup.state.domain = null;
  popup.state.page = { ...PAGE };
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

  describe("static UI localization", () => {
    // `localizeStaticDom` runs on load and resolves every `data-i18n*`
    // attribute through `i18n.getMessage`. The mock returns the real
    // English catalog, so the visible chrome ends up in the user's
    // language (English here) and the call proves the seam was used.
    it("localizes the data-i18n chrome through i18n.getMessage on load", async () => {
      const { api, popup } = await setUp();
      expect(api.i18n.getMessage).toHaveBeenCalledWith("storeLabel", undefined);
      expect(api.i18n.getMessage).toHaveBeenCalledWith(
        "refreshButtonTitle",
        undefined,
      );
      expect(popup.elements.refresh.textContent).toBe("Refresh");
      expect(popup.elements.refresh.title).toBe("Re-query the host");
      expect(popup.elements.store.getAttribute("aria-label")).toBe("Store");
    });
  });

  describe("popup chrome / accessibility (item E)", () => {
    it("does not mark #domain as a live region — the value is written once during main() and AT picks it up from the initial paint", async () => {
      const { popup } = await setUp();
      // The element is in the DOM and reachable through the
      // popup's element lookup table.
      expect(popup.elements.domain).not.toBeNull();
      // The status section below is the only intentionally-live
      // region in the popup chrome. Marking #domain as `aria-live`
      // promises updates that never happen and adds noise to the
      // screen reader's tracking. A future contributor reflexively
      // adding `aria-live` back would trip this assertion.
      expect(popup.elements.domain.hasAttribute("aria-live")).toBe(false);
    });

    it("keeps #status as a polite live region (positive control: setStatus mutates it after first paint)", async () => {
      const { popup } = await setUp();
      // setStatus writes both role and aria-live explicitly on each
      // call; the initial HTML attribute survives until then.
      expect(popup.elements.status.getAttribute("aria-live")).toBe("polite");
    });
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
    it("accepts version 2", async () => {
      const { popup } = await setUp();
      expect(popup.isCompatibleProtocol(2)).toBe(true);
    });

    it("rejects every other integer version, including the metadata-and-secrets version 1", async () => {
      const { popup } = await setUp();
      expect(popup.isCompatibleProtocol(0)).toBe(false);
      expect(popup.isCompatibleProtocol(1)).toBe(false);
      expect(popup.isCompatibleProtocol(3)).toBe(false);
      expect(popup.isCompatibleProtocol(99)).toBe(false);
    });

    it("rejects non-number values", async () => {
      const { popup } = await setUp();
      expect(popup.isCompatibleProtocol("2")).toBe(false);
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

    it("returns { id, hostname, origin } for a normal page", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([
        { id: 9, url: "https://demo.test/login" },
      ]);
      await expect(popup.loadActiveTab()).resolves.toEqual({
        id: 9,
        hostname: "demo.test",
        origin: "https://demo.test",
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
      // assert on the option flag directly. `state.store` is the
      // caller's job to set (via readSelectedStore) — that side is
      // exercised end-to-end by the bootstrap-behaviour tests further
      // down.
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

    it("writes element titles for hover hint", async () => {
      const { popup } = await setUp();
      popup.renderStores(
        [
          { name: "long-store-name-that-truncates", default: true },
          { name: "another", default: false },
        ],
        null,
      );
      const titles = Array.from(popup.elements.store.options)
        .filter((o) => o.value !== popup.ALL_STORES)
        .map((o) => o.title);
      expect(titles).toEqual(["long-store-name-that-truncates", "another"]);
    });

    it("does not touch state.stores or state.store (item R: render is DOM-only)", async () => {
      const { popup } = await setUp();
      const beforeStores = popup.state.stores;
      const beforeStore = popup.state.store;
      popup.renderStores(
        [
          { name: "a", default: true },
          { name: "b", default: false },
        ],
        "b",
      );
      expect(popup.state.stores).toBe(beforeStores);
      expect(popup.state.store).toBe(beforeStore);
    });
  });

  describe("readSelectedStore (item R)", () => {
    it("returns the currently selected option's value", async () => {
      const { popup } = await setUp();
      popup.renderStores(
        [
          { name: "a", default: true },
          { name: "b", default: false },
        ],
        "b",
      );
      // `b` is selected per option.selected = true (asserted in the
      // renderStores test above); readSelectedStore should mirror that.
      expect(popup.readSelectedStore()).toBe("b");
    });

    it("returns null when the select element is empty", async () => {
      const { popup } = await setUp();
      popup.renderStores([], null);
      expect(popup.readSelectedStore()).toBeNull();
    });

    it("returns the ALL_STORES sentinel when that option is selected", async () => {
      const { popup } = await setUp();
      popup.renderStores(
        [
          { name: "a", default: false },
          { name: "b", default: true },
        ],
        popup.ALL_STORES,
      );
      expect(popup.readSelectedStore()).toBe(popup.ALL_STORES);
    });
  });

  describe("isPickStillValid (pure helper, item K)", () => {
    it("rejects an empty pick", async () => {
      const { popup } = await setUp();
      expect(popup.isPickStillValid(null, [])).toBe(false);
      expect(popup.isPickStillValid(undefined, [])).toBe(false);
      expect(popup.isPickStillValid("", [])).toBe(false);
    });

    it("accepts ALL_STORES when more than one store exists", async () => {
      const { popup } = await setUp();
      expect(
        popup.isPickStillValid(popup.ALL_STORES, [
          { name: "a" },
          { name: "b" },
        ]),
      ).toBe(true);
    });

    it("rejects ALL_STORES when only one store exists", async () => {
      const { popup } = await setUp();
      expect(popup.isPickStillValid(popup.ALL_STORES, [{ name: "a" }])).toBe(
        false,
      );
    });

    it("accepts a store name that exists in the list", async () => {
      const { popup } = await setUp();
      expect(
        popup.isPickStillValid("b", [{ name: "a" }, { name: "b" }]),
      ).toBe(true);
    });

    it("rejects a store name that does not exist in the list", async () => {
      const { popup } = await setUp();
      expect(popup.isPickStillValid("c", [{ name: "a" }, { name: "b" }])).toBe(
        false,
      );
    });

    it("rejects against an empty store list", async () => {
      const { popup } = await setUp();
      expect(popup.isPickStillValid("a", [])).toBe(false);
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
        [popup.HOST_STORE_KEY]: {
          "example.com": { store: popup.ALL_STORES, lastUsedAt: 1 },
        },
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
        [popup.HOST_STORE_KEY]: {
          "example.com": { store: popup.ALL_STORES, lastUsedAt: 1 },
        },
      });
      await expect(
        popup.pickPreferredStore([{ name: "a", default: true }], "example.com"),
      ).resolves.toBeNull();
    });

    it("returns the remembered store name when it still exists in the list", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.HOST_STORE_KEY]: {
          "example.com": { store: "b", lastUsedAt: 1 },
        },
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
        [popup.HOST_STORE_KEY]: {
          "example.com": { store: "gone", lastUsedAt: 1 },
        },
      });
      await expect(
        popup.pickPreferredStore(
          [{ name: "a", default: true }],
          "example.com",
        ),
      ).resolves.toBeNull();
    });
  });

  describe("coerceHostStoreMap (pure helper, item B)", () => {
    it("returns an empty map for null", async () => {
      const { popup } = await setUp();
      expect(popup.coerceHostStoreMap(null)).toEqual({});
    });

    it("returns an empty map for undefined (missing storage key)", async () => {
      const { popup } = await setUp();
      expect(popup.coerceHostStoreMap(undefined)).toEqual({});
    });

    it("returns an empty map for a non-object value (string, number, etc.)", async () => {
      const { popup } = await setUp();
      expect(popup.coerceHostStoreMap("broken")).toEqual({});
      expect(popup.coerceHostStoreMap(42)).toEqual({});
      expect(popup.coerceHostStoreMap(true)).toEqual({});
    });

    it("returns an empty map for an array (storage value was overwritten by an older array-shaped value)", async () => {
      const { popup } = await setUp();
      expect(popup.coerceHostStoreMap(["a", "b"])).toEqual({});
    });

    it("passes through a well-formed map", async () => {
      const { popup } = await setUp();
      const raw = {
        "example.com": { store: "personal", lastUsedAt: 100 },
        "github.com": { store: "work", lastUsedAt: 200 },
      };
      expect(popup.coerceHostStoreMap(raw)).toEqual(raw);
    });

    it("drops entries whose value is not an object", async () => {
      const { popup } = await setUp();
      const raw = {
        "ok.test": { store: "a", lastUsedAt: 1 },
        "bad.test": "scalar",
        "null.test": null,
      };
      expect(popup.coerceHostStoreMap(raw)).toEqual({
        "ok.test": { store: "a", lastUsedAt: 1 },
      });
    });

    it("drops entries whose store is not a string", async () => {
      const { popup } = await setUp();
      const raw = {
        "ok.test": { store: "a", lastUsedAt: 1 },
        "bad.test": { store: 42, lastUsedAt: 1 },
      };
      expect(popup.coerceHostStoreMap(raw)).toEqual({
        "ok.test": { store: "a", lastUsedAt: 1 },
      });
    });

    it("drops entries whose lastUsedAt is not a number", async () => {
      const { popup } = await setUp();
      const raw = {
        "ok.test": { store: "a", lastUsedAt: 1 },
        "bad.test": { store: "a", lastUsedAt: "earlier" },
      };
      expect(popup.coerceHostStoreMap(raw)).toEqual({
        "ok.test": { store: "a", lastUsedAt: 1 },
      });
    });

    it("keeps only the recognised fields on each entry (defensive against schema drift)", async () => {
      const { popup } = await setUp();
      const raw = {
        "example.com": {
          store: "a",
          lastUsedAt: 5,
          // Unknown future field — must not leak into the kept entry
          // (which would cause the next write to round-trip a value we
          // don't understand).
          comment: "leak",
        },
      };
      expect(popup.coerceHostStoreMap(raw)).toEqual({
        "example.com": { store: "a", lastUsedAt: 5 },
      });
    });
  });

  describe("pruneMapToCap (pure helper, item B)", () => {
    it("returns the input untouched when it is at or under the cap", async () => {
      const { popup } = await setUp();
      const map = {
        a: { store: "x", lastUsedAt: 3 },
        b: { store: "x", lastUsedAt: 1 },
      };
      expect(popup.pruneMapToCap(map, 5)).toEqual({ map, removed: [] });
      expect(popup.pruneMapToCap(map, 2)).toEqual({ map, removed: [] });
    });

    it("drops the entry with the oldest lastUsedAt when over the cap by one", async () => {
      const { popup } = await setUp();
      const map = {
        a: { store: "x", lastUsedAt: 3 },
        b: { store: "x", lastUsedAt: 1 },
        c: { store: "x", lastUsedAt: 2 },
      };
      const { map: kept, removed } = popup.pruneMapToCap(map, 2);
      expect(removed).toEqual(["b"]);
      expect(Object.keys(kept).sort()).toEqual(["a", "c"]);
    });

    it("drops multiple entries when over the cap by several", async () => {
      const { popup } = await setUp();
      const map = {
        a: { store: "x", lastUsedAt: 5 },
        b: { store: "x", lastUsedAt: 1 },
        c: { store: "x", lastUsedAt: 3 },
        d: { store: "x", lastUsedAt: 2 },
        e: { store: "x", lastUsedAt: 4 },
      };
      const { map: kept, removed } = popup.pruneMapToCap(map, 2);
      // Three oldest (1, 2, 3 → b, d, c) get evicted; the two newest
      // (4, 5 → e, a) survive.
      expect(removed.sort()).toEqual(["b", "c", "d"]);
      expect(Object.keys(kept).sort()).toEqual(["a", "e"]);
    });

    it("breaks ties on lastUsedAt by hostname string order (deterministic)", async () => {
      const { popup } = await setUp();
      const map = {
        zebra: { store: "x", lastUsedAt: 1 },
        alpha: { store: "x", lastUsedAt: 1 },
      };
      const { removed } = popup.pruneMapToCap(map, 1);
      // Tie at lastUsedAt:1 → alphabetical winner is "alpha", so
      // alpha falls first and zebra is kept.
      expect(removed).toEqual(["alpha"]);
    });

    it("returns an empty map and no removals for an empty input", async () => {
      const { popup } = await setUp();
      expect(popup.pruneMapToCap({}, 5)).toEqual({ map: {}, removed: [] });
    });

    it("does not mutate its input", async () => {
      const { popup } = await setUp();
      const map = {
        a: { store: "x", lastUsedAt: 3 },
        b: { store: "x", lastUsedAt: 1 },
      };
      const snapshot = JSON.parse(JSON.stringify(map));
      popup.pruneMapToCap(map, 1);
      expect(map).toEqual(snapshot);
    });
  });

  describe("rememberStoreForHost / recallStoreForHost (item B)", () => {
    // Helper: a Date.now stub that returns predictable, monotonically
    // increasing values so the timestamps the production code writes
    // are testable without leaking into wall-clock-dependent assertions.
    function stubMonotonicNow() {
      let t = 1000;
      return vi.spyOn(Date, "now").mockImplementation(() => ++t);
    }

    it("writes the host→store entry under the single map key with a current timestamp", async () => {
      const { api, popup } = await setUp();
      stubMonotonicNow();
      api.storage.local.get.mockResolvedValueOnce({});
      await popup.rememberStoreForHost("example.com", "personal");
      expect(api.storage.local.set).toHaveBeenCalledWith({
        [popup.HOST_STORE_KEY]: {
          "example.com": { store: "personal", lastUsedAt: 1001 },
        },
      });
    });

    it("merges new entries into the existing map (does not overwrite siblings)", async () => {
      const { api, popup } = await setUp();
      stubMonotonicNow();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.HOST_STORE_KEY]: {
          "github.com": { store: "work", lastUsedAt: 100 },
        },
      });
      await popup.rememberStoreForHost("example.com", "personal");
      const written = api.storage.local.set.mock.calls.at(-1)[0][
        popup.HOST_STORE_KEY
      ];
      expect(written["github.com"]).toEqual({
        store: "work",
        lastUsedAt: 100,
      });
      expect(written["example.com"].store).toBe("personal");
    });

    it("re-touching an existing host updates only its lastUsedAt and store", async () => {
      const { api, popup } = await setUp();
      stubMonotonicNow();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.HOST_STORE_KEY]: {
          "example.com": { store: "old", lastUsedAt: 100 },
        },
      });
      await popup.rememberStoreForHost("example.com", "new");
      const written = api.storage.local.set.mock.calls.at(-1)[0][
        popup.HOST_STORE_KEY
      ];
      expect(written["example.com"].store).toBe("new");
      expect(written["example.com"].lastUsedAt).toBeGreaterThan(100);
    });

    it("removes a host from the map when the store argument is empty", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.HOST_STORE_KEY]: {
          "example.com": { store: "personal", lastUsedAt: 100 },
          "github.com": { store: "work", lastUsedAt: 200 },
        },
      });
      await popup.rememberStoreForHost("example.com", "");
      expect(api.storage.local.set).toHaveBeenCalledWith({
        [popup.HOST_STORE_KEY]: {
          "github.com": { store: "work", lastUsedAt: 200 },
        },
      });
    });

    it("clearing a host that was never remembered does not issue a set call", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.HOST_STORE_KEY]: {
          "other.test": { store: "x", lastUsedAt: 1 },
        },
      });
      await popup.rememberStoreForHost("never-seen.test", "");
      expect(api.storage.local.set).not.toHaveBeenCalled();
    });

    it("clearing the last host writes an empty map (subsequent reads see {})", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.HOST_STORE_KEY]: {
          "only.test": { store: "x", lastUsedAt: 1 },
        },
      });
      await popup.rememberStoreForHost("only.test", "");
      expect(api.storage.local.set).toHaveBeenCalledWith({
        [popup.HOST_STORE_KEY]: {},
      });
    });

    it("no-ops without throwing when hostname is missing", async () => {
      const { api, popup } = await setUp();
      await popup.rememberStoreForHost(null, "personal");
      expect(api.storage.local.set).not.toHaveBeenCalled();
      expect(api.storage.local.get).not.toHaveBeenCalled();
    });

    it("no-ops without throwing when storage.local is unavailable", async () => {
      const { api, popup } = await setUp();
      api.storage.local = undefined;
      await popup.rememberStoreForHost("example.com", "personal");
    });

    it("swallows storage write failures so the popup keeps working", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({});
      api.storage.local.set.mockRejectedValueOnce(new Error("quota exceeded"));
      await expect(
        popup.rememberStoreForHost("example.com", "personal"),
      ).resolves.toBeUndefined();
    });

    it("swallows storage read failures so a corrupt storage layer doesn't block writes from queueing", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockRejectedValueOnce(new Error("disk gone"));
      await expect(
        popup.rememberStoreForHost("example.com", "personal"),
      ).resolves.toBeUndefined();
    });

    it("treats a corrupt (non-object) stored value as an empty map", async () => {
      const { api, popup } = await setUp();
      stubMonotonicNow();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.HOST_STORE_KEY]: "i-am-broken",
      });
      await popup.rememberStoreForHost("new.test", "personal");
      const written = api.storage.local.set.mock.calls.at(-1)[0][
        popup.HOST_STORE_KEY
      ];
      expect(Object.keys(written)).toEqual(["new.test"]);
      expect(written["new.test"].store).toBe("personal");
    });

    it("recall returns the stored value", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.HOST_STORE_KEY]: {
          "example.com": { store: "personal", lastUsedAt: 100 },
        },
      });
      await expect(popup.recallStoreForHost("example.com")).resolves.toBe(
        "personal",
      );
    });

    it("recall returns null when no entry exists for this host (map missing)", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({});
      await expect(popup.recallStoreForHost("example.com")).resolves.toBeNull();
    });

    it("recall returns null when the map exists but the host is absent", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.HOST_STORE_KEY]: {
          "other.test": { store: "x", lastUsedAt: 1 },
        },
      });
      await expect(popup.recallStoreForHost("example.com")).resolves.toBeNull();
    });

    it("recall returns null when the stored value is corrupt (non-object)", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.HOST_STORE_KEY]: "i-am-broken",
      });
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

  describe("per-host memory eviction (item B)", () => {
    it("evicts the oldest host (by lastUsedAt) when the cap is exceeded", async () => {
      const { api, popup } = await setUp();
      vi.spyOn(Date, "now").mockReturnValue(9_999_999);
      // Seed a full map. Each entry has a distinct, monotonically
      // increasing timestamp — host0 is the oldest, hostN-1 the newest.
      const full = {};
      for (let i = 0; i < popup.MAX_REMEMBERED_HOSTS; i += 1) {
        full[`host${i}.test`] = { store: "x", lastUsedAt: i + 1 };
      }
      api.storage.local.get.mockResolvedValueOnce({
        [popup.HOST_STORE_KEY]: full,
      });
      await popup.rememberStoreForHost("new.test", "personal");
      const written = api.storage.local.set.mock.calls.at(-1)[0][
        popup.HOST_STORE_KEY
      ];
      // host0 was the oldest — it should be the one evicted.
      expect(written).not.toHaveProperty("host0.test");
      expect(written).toHaveProperty("new.test");
      // The map size is capped, not just the new entry inserted.
      expect(Object.keys(written)).toHaveLength(popup.MAX_REMEMBERED_HOSTS);
    });

    it("evicts every overflowing host in one call when the seed map is multiple over the cap", async () => {
      const { api, popup } = await setUp();
      vi.spyOn(Date, "now").mockReturnValue(9_999_999);
      // A map that is two over the cap (could happen after a manual
      // import or a future cap change) must be trimmed back to exactly
      // `MAX_REMEMBERED_HOSTS` entries in one write.
      const overflow = {};
      for (let i = 0; i < popup.MAX_REMEMBERED_HOSTS + 1; i += 1) {
        overflow[`host${i}.test`] = { store: "x", lastUsedAt: i + 1 };
      }
      api.storage.local.get.mockResolvedValueOnce({
        [popup.HOST_STORE_KEY]: overflow,
      });
      await popup.rememberStoreForHost("new.test", "personal");
      const written = api.storage.local.set.mock.calls.at(-1)[0][
        popup.HOST_STORE_KEY
      ];
      expect(Object.keys(written)).toHaveLength(popup.MAX_REMEMBERED_HOSTS);
      // Two oldest (host0, host1) evicted to make room for new.test
      // while still landing at the cap.
      expect(written).not.toHaveProperty("host0.test");
      expect(written).not.toHaveProperty("host1.test");
      expect(written).toHaveProperty("new.test");
    });

    it("re-touching an existing host does NOT evict anyone — same entry count, fresher timestamp", async () => {
      const { api, popup } = await setUp();
      vi.spyOn(Date, "now").mockReturnValue(10_000_000);
      const full = {};
      for (let i = 0; i < popup.MAX_REMEMBERED_HOSTS; i += 1) {
        full[`host${i}.test`] = { store: "x", lastUsedAt: i + 1 };
      }
      api.storage.local.get.mockResolvedValueOnce({
        [popup.HOST_STORE_KEY]: full,
      });
      // Re-touching host0 — the oldest — must keep it (not evict it)
      // because it's the entry being written.
      await popup.rememberStoreForHost("host0.test", "personal");
      const written = api.storage.local.set.mock.calls.at(-1)[0][
        popup.HOST_STORE_KEY
      ];
      expect(written).toHaveProperty("host0.test");
      expect(written["host0.test"].store).toBe("personal");
      expect(written["host0.test"].lastUsedAt).toBe(10_000_000);
      expect(Object.keys(written)).toHaveLength(popup.MAX_REMEMBERED_HOSTS);
    });
  });

  describe("reconcileLegacyStorage (item N)", () => {
    // The pre-fix-B schema put each host's choice under its own
    // `store-for-host:<hostname>` key plus a `pasejo:host-store-index`
    // array. The single-key schema replaced both; without an active
    // cleanup pass those legacy entries would sit in storage forever
    // on machines that ran an earlier build. The same pass also
    // cleans up dev-tools-introduced stale entries between popup
    // opens.

    it("removes every legacy `store-for-host:*` key", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        "store-for-host:example.com": "personal",
        "store-for-host:github.com": "work",
        [popup.HOST_STORE_KEY]: {
          "current.test": { store: "x", lastUsedAt: 1 },
        },
      });
      await popup.reconcileLegacyStorage();
      expect(api.storage.local.remove).toHaveBeenCalledWith([
        "store-for-host:example.com",
        "store-for-host:github.com",
      ]);
    });

    it("removes the legacy `pasejo:host-store-index` key", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.LEGACY_HOST_INDEX_KEY]: ["example.com", "github.com"],
        [popup.HOST_STORE_KEY]: {
          "current.test": { store: "x", lastUsedAt: 1 },
        },
      });
      await popup.reconcileLegacyStorage();
      expect(api.storage.local.remove).toHaveBeenCalledWith([
        popup.LEGACY_HOST_INDEX_KEY,
      ]);
    });

    it("removes the legacy `pasejo:settings` key of the retired basic-auth opt-in", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        "pasejo:settings": { basicAuth: true },
        [popup.HOST_STORE_KEY]: {
          "current.test": { store: "x", lastUsedAt: 1 },
        },
      });
      await popup.reconcileLegacyStorage();
      expect(api.storage.local.remove).toHaveBeenCalledWith(["pasejo:settings"]);
    });

    it("removes legacy keys AND the index in a single batched call", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.LEGACY_HOST_INDEX_KEY]: ["example.com"],
        "store-for-host:example.com": "personal",
        "store-for-host:github.com": "work",
        [popup.HOST_STORE_KEY]: {
          "current.test": { store: "x", lastUsedAt: 1 },
        },
        // A user-introduced foreign key that ISN'T our concern —
        // must be left alone so we don't clobber third-party state.
        "wtf.someoneElse.config": { foo: "bar" },
      });
      await popup.reconcileLegacyStorage();
      // Exactly one remove call carrying every legacy key we own.
      expect(api.storage.local.remove).toHaveBeenCalledTimes(1);
      const removed = api.storage.local.remove.mock.calls[0][0];
      expect(removed).toEqual(
        expect.arrayContaining([
          popup.LEGACY_HOST_INDEX_KEY,
          "store-for-host:example.com",
          "store-for-host:github.com",
        ]),
      );
      // The current schema key and unrelated foreign keys are
      // untouched.
      expect(removed).not.toContain(popup.HOST_STORE_KEY);
      expect(removed).not.toContain("wtf.someoneElse.config");
    });

    it("does not call remove when there are no legacy entries", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        [popup.HOST_STORE_KEY]: {
          "current.test": { store: "x", lastUsedAt: 1 },
        },
      });
      await popup.reconcileLegacyStorage();
      expect(api.storage.local.remove).not.toHaveBeenCalled();
    });

    it("treats a non-object storage payload as nothing-to-do (defensive)", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce(null);
      await popup.reconcileLegacyStorage();
      expect(api.storage.local.remove).not.toHaveBeenCalled();
    });

    it("no-ops without throwing when storage.local is unavailable", async () => {
      const { api, popup } = await setUp();
      api.storage.local = undefined;
      await expect(popup.reconcileLegacyStorage()).resolves.toBeUndefined();
    });

    it("swallows storage.get failures so popup open is never blocked", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockRejectedValueOnce(new Error("storage gone"));
      await expect(popup.reconcileLegacyStorage()).resolves.toBeUndefined();
      expect(api.storage.local.remove).not.toHaveBeenCalled();
    });

    it("swallows storage.remove failures so popup open is never blocked", async () => {
      const { api, popup } = await setUp();
      api.storage.local.get.mockResolvedValueOnce({
        "store-for-host:example.com": "x",
      });
      api.storage.local.remove.mockRejectedValueOnce(
        new Error("quota exceeded"),
      );
      await expect(popup.reconcileLegacyStorage()).resolves.toBeUndefined();
    });
  });

  describe("write serialisation (item B — the load-bearing race fix)", () => {
    // The bug: two `rememberStoreForHost` calls dispatched back-to-back
    // without `await` (the dropdown change handler is fire-and-forget)
    // both issue their `get` before either `set` lands. Both `get`s
    // see the same pre-image, both modify it, the second `set`
    // overwrites the first — losing one host's update.
    //
    // The fix: `rememberStoreForHost` queues onto a module-local promise
    // chain so within-popup writes are serialised. The test below
    // proves the queue does what it claims by interleaving two slow
    // `get`s and asserting that the second `get` happens AFTER the
    // first `set` (rather than before it).

    it("serialises two concurrent writes so the second observes the first's set", async () => {
      const { api, popup } = await setUp();
      vi.spyOn(Date, "now").mockReturnValue(5_000);

      const ops = [];
      const get1 = deferred();
      const get2 = deferred();
      api.storage.local.get = vi
        .fn()
        // First write's read — held until we explicitly resolve it.
        .mockImplementationOnce(() => {
          ops.push("get1");
          return get1.promise;
        })
        // Second write's read — held until the first write's set has
        // already fired (the queue must enforce this ordering).
        .mockImplementationOnce(() => {
          ops.push("get2");
          return get2.promise;
        });
      api.storage.local.set = vi.fn().mockImplementation(async (arg) => {
        ops.push(
          `set:${Object.keys(arg[popup.HOST_STORE_KEY] ?? {}).join(",")}`,
        );
      });

      // Two concurrent writes — exactly what the fire-and-forget
      // dropdown change handler does on rapid clicks. Without the
      // queue, both `get` calls would have happened before either
      // `set`, so `ops` would interleave to ['get1','get2',...].
      const w1 = popup.rememberStoreForHost("a.test", "store-a");
      const w2 = popup.rememberStoreForHost("b.test", "store-b");

      // Let the first `get` proceed and its `set` land before the
      // second queue slot is allowed to wake up.
      get1.resolve({});
      await flushAsync();
      // At this point: queue slot 1 has finished its set; queue slot 2
      // has fired its `get` (because the queue runs them sequentially
      // and the await on get2.promise is pending).
      get2.resolve({
        [popup.HOST_STORE_KEY]: {
          "a.test": { store: "store-a", lastUsedAt: 5_000 },
        },
      });
      await Promise.all([w1, w2]);

      // The ordering: get1 → set with a.test → get2 → set with both.
      // The crucial property is that `get2` appears AFTER `set:a.test`,
      // not before — that's exactly the serialisation guarantee.
      const get1Idx = ops.indexOf("get1");
      const set1Idx = ops.findIndex((o) => o === "set:a.test");
      const get2Idx = ops.indexOf("get2");
      const set2Idx = ops.findIndex((o, i) => i > set1Idx && o.startsWith("set:"));
      expect(get1Idx).toBeGreaterThanOrEqual(0);
      expect(set1Idx).toBeGreaterThan(get1Idx);
      expect(get2Idx).toBeGreaterThan(set1Idx);
      expect(set2Idx).toBeGreaterThan(get2Idx);

      // And the final stored map must contain BOTH hosts — the bug's
      // hallmark was b.test's entry replacing a.test's because both
      // had read the same pre-image. With the queue, the second write
      // sees a.test already stored and writes b.test alongside it.
      const lastWrite = api.storage.local.set.mock.calls.at(-1)[0][
        popup.HOST_STORE_KEY
      ];
      expect(lastWrite).toHaveProperty("a.test");
      expect(lastWrite).toHaveProperty("b.test");
    });

    it("a failed write does not poison the queue — later writes still run", async () => {
      const { api, popup } = await setUp();
      vi.spyOn(Date, "now").mockReturnValue(7_000);
      // First write fails at the `set` step.
      api.storage.local.get
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      api.storage.local.set
        .mockRejectedValueOnce(new Error("storage gone"))
        .mockResolvedValueOnce(undefined);

      const w1 = popup.rememberStoreForHost("a.test", "store-a");
      const w2 = popup.rememberStoreForHost("b.test", "store-b");
      await Promise.all([w1, w2]);

      // Two sets attempted: the first rejected, the second succeeded.
      expect(api.storage.local.set).toHaveBeenCalledTimes(2);
      // And the second write's payload reached the storage layer
      // intact — proving the queue's chain didn't get stuck on the
      // rejected first write.
      const secondCall = api.storage.local.set.mock.calls[1][0];
      expect(secondCall).toHaveProperty(popup.HOST_STORE_KEY);
      expect(secondCall[popup.HOST_STORE_KEY]).toHaveProperty("b.test");
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
          protocol_version: 2,
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
        response: { protocol_version: 2 },
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
      // Item M: the noun is repeated on the extension's side so the
      // trailing number reads as a clause ("extension speaks protocol
      // 1") rather than a sentence fragment ("extension speaks 1").
      expect(popup.elements.status.textContent).toMatch(
        /extension speaks protocol 2/,
      );
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
        response: { protocol_version: 2, stores: "broken" },
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

  describe("stale-result suppression (item J)", () => {
    it("bumps state.queryGeneration on every runQuery call", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = "personal";
      api.runtime.sendMessage.mockResolvedValue({
        ok: true,
        response: { results: [] },
      });
      const before = popup.state.queryGeneration;
      await popup.runQuery();
      const afterOne = popup.state.queryGeneration;
      await popup.runQuery();
      const afterTwo = popup.state.queryGeneration;
      expect(afterOne).toBe(before + 1);
      expect(afterTwo).toBe(before + 2);
    });

    it("drops a late single-store success that lost the race to a fresher call", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = "personal";
      const d1 = deferred();
      const d2 = deferred();
      api.runtime.sendMessage
        .mockReturnValueOnce(d1.promise)
        .mockReturnValueOnce(d2.promise);
      const q1 = popup.runQuery();
      const q2 = popup.runQuery();
      d2.resolve({
        ok: true,
        response: {
          results: [{ name: "fresh", match_kind: "name", score: 0.5 }],
        },
      });
      // Wait for q2's render to land before letting q1's stale reply
      // arrive, so the test mirrors the bug's worst case: stale data
      // arriving AFTER fresh data has already painted.
      await flushAsync();
      d1.resolve({
        ok: true,
        response: {
          results: [{ name: "stale", match_kind: "name", score: 0.5 }],
        },
      });
      await Promise.all([q1, q2]);
      const names = Array.from(
        popup.elements.results.querySelectorAll(".name"),
      ).map((n) => n.textContent);
      expect(names).toEqual(["fresh"]);
    });

    it("drops a late host-error reply that arrives after fresh results have rendered", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = "personal";
      const d1 = deferred();
      const d2 = deferred();
      api.runtime.sendMessage
        .mockReturnValueOnce(d1.promise)
        .mockReturnValueOnce(d2.promise);
      const q1 = popup.runQuery();
      const q2 = popup.runQuery();
      d2.resolve({
        ok: true,
        response: {
          results: [{ name: "alice", match_kind: "name", score: 0.5 }],
        },
      });
      await flushAsync();
      d1.resolve({
        ok: true,
        response: { error: "identity_locked" },
      });
      await Promise.all([q1, q2]);
      // Status should still reflect the fresh success ("1 match.") not
      // the stale identity-locked error from q1.
      expect(popup.elements.status.textContent).toMatch(/1 match/);
      expect(popup.elements.status.classList.contains("error")).toBe(false);
    });

    it("drops a late transport error that arrives after fresh results have rendered", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = "personal";
      const d1 = deferred();
      const d2 = deferred();
      api.runtime.sendMessage
        .mockReturnValueOnce(d1.promise)
        .mockReturnValueOnce(d2.promise);
      const q1 = popup.runQuery();
      const q2 = popup.runQuery();
      d2.resolve({
        ok: true,
        response: {
          results: [{ name: "alice", match_kind: "name", score: 0.5 }],
        },
      });
      await flushAsync();
      // The stale call's sendBackground rejects after fresh has
      // already rendered — without the gate, this would surface a
      // "Could not reach the host: …" alert and overwrite the success.
      d1.reject(new Error("host crashed"));
      await Promise.all([q1, q2]);
      expect(popup.elements.status.textContent).toMatch(/1 match/);
      expect(popup.elements.status.classList.contains("error")).toBe(false);
    });

    it("drops a late malformed-results reply that arrives after fresh results have rendered", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = "personal";
      const d1 = deferred();
      const d2 = deferred();
      api.runtime.sendMessage
        .mockReturnValueOnce(d1.promise)
        .mockReturnValueOnce(d2.promise);
      const q1 = popup.runQuery();
      const q2 = popup.runQuery();
      d2.resolve({
        ok: true,
        response: {
          results: [{ name: "alice", match_kind: "name", score: 0.5 }],
        },
      });
      await flushAsync();
      d1.resolve({ ok: true, response: { results: "broken" } });
      await Promise.all([q1, q2]);
      expect(popup.elements.status.textContent).toMatch(/1 match/);
      expect(popup.elements.status.classList.contains("error")).toBe(false);
    });

    it("drops a late multi-store stream reply that arrives after a fresher query started", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }, { name: "b" }];
      // Start q1 — its stream stays open with no replies until we say
      // so. Then start q2 with a fresh stream that resolves
      // immediately.
      const q1 = popup.runQuery();
      const q1Pair = api.__streamPairs.at(-1);
      const q2 = popup.runQuery();
      // q2 emits its fresh results and closes.
      const q2Pair = api.__streamPairs.at(-1);
      expect(q2Pair).not.toBe(q1Pair);
      q2Pair.backgroundPort.postMessage({
        type: "result",
        index: 0,
        response: {
          results: [{ name: "fresh-a", match_kind: "name", score: 0.9 }],
        },
      });
      q2Pair.backgroundPort.postMessage({
        type: "result",
        index: 1,
        response: {
          results: [{ name: "fresh-b", match_kind: "name", score: 0.7 }],
        },
      });
      q2Pair.backgroundPort.postMessage({ type: "done" });
      await flushAsync();
      // Now q1's stale stream delivers — these arrive AFTER fresh
      // results have been painted, so the generation gate must drop
      // them on the floor.
      q1Pair.backgroundPort.postMessage({
        type: "result",
        index: 0,
        response: {
          results: [{ name: "stale-a", match_kind: "name", score: 0.9 }],
        },
      });
      q1Pair.backgroundPort.postMessage({
        type: "result",
        index: 1,
        response: {
          results: [{ name: "stale-b", match_kind: "name", score: 0.7 }],
        },
      });
      q1Pair.backgroundPort.postMessage({ type: "done" });
      await Promise.all([q1, q2]);
      const names = Array.from(
        popup.elements.results.querySelectorAll(".name"),
      ).map((n) => n.textContent);
      // Fresh results only — the stale a/b must not have been added.
      expect(names.sort()).toEqual(["fresh-a", "fresh-b"]);
    });

    it("suppresses the 'Searching…' timer when the generation has moved on", async () => {
      const { api, popup } = await setUp();
      vi.useFakeTimers();
      popup.state.domain = "example.com";
      popup.state.store = "personal";
      // Pin sendMessage so q1 never settles on its own.
      api.runtime.sendMessage.mockReturnValueOnce(new Promise(() => {}));
      const q1 = popup.runQuery();
      // Manually bump the generation as if a fresher runQuery had
      // started (this is what the change-handler / refresh-handler
      // path would have done under real load).
      popup.state.queryGeneration += 1;
      await vi.advanceTimersByTimeAsync(250);
      // Without the gate the q1 timer would set
      // "Searching for example.com…"; with the gate it bails first.
      expect(popup.elements.status.textContent).toBe("");
      // Don't `await q1` — it never resolves because sendMessage
      // never returns. vitest tears the fake-timer context down for
      // us after the test.
      void q1;
    });

    it("still updates the status when the timer is NOT stale (positive control)", async () => {
      const { api, popup } = await setUp();
      vi.useFakeTimers();
      popup.state.domain = "example.com";
      popup.state.store = "personal";
      api.runtime.sendMessage.mockReturnValueOnce(new Promise(() => {}));
      const q1 = popup.runQuery();
      // Don't bump the generation — q1 is still the freshest.
      await vi.advanceTimersByTimeAsync(250);
      expect(popup.elements.status.textContent).toMatch(/Searching/);
      void q1;
    });
  });

  describe("runMultiStoreQuery (streaming pipeline)", () => {
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

    it("renders 'no matches' with skipped count when nothing matched anywhere", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }];
      const queryDone = popup.runQuery();
      await flushAsync();
      await driveStreamReplies(api, [
        { type: "result", index: 0, response: { results: [] } },
      ]);
      await queryDone;
      expect(popup.elements.status.textContent).toMatch(/No matches/);
    });

    it("treats a missing score on a result as zero when sorting across stores", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }, { name: "b" }];
      const queryDone = popup.runQuery();
      await flushAsync();
      await driveStreamReplies(api, [
        {
          type: "result",
          index: 0,
          response: {
            results: [
              { name: "high", match_kind: "name", score: 0.7 },
              { name: "no_score_b", match_kind: "name" },
            ],
          },
        },
        {
          type: "result",
          index: 1,
          response: {
            results: [
              { name: "no_score_a", match_kind: "name" },
              { name: "mid", match_kind: "name", score: 0.5 },
            ],
          },
        },
      ]);
      await queryDone;
      const names = Array.from(
        popup.elements.results.querySelectorAll(".name"),
      ).map((n) => n.textContent);
      // Descending score: 0.7, 0.5, then the two zero-scored entries
      // in stable order.
      expect(names[0]).toBe("high");
      expect(names[1]).toBe("mid");
      expect(names.slice(2).sort()).toEqual(["no_score_a", "no_score_b"]);
    });
  });

  describe("multi-store streaming path (item J + L)", () => {
    // The popup opens a long-lived `runtime.connect` port to the
    // background and consumes each store's reply AS IT ARRIVES,
    // updating the status counter and the results list incrementally.
    // This is what makes a YubiKey-blocked store stop gating the
    // fast stores on user-perceived latency.

    it("opens the streaming port with the agreed name and posts a `start` carrying every store as a separate request", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }, { name: "b" }];
      const queryDone = popup.runQuery();
      await flushAsync();
      expect(api.runtime.connect).toHaveBeenCalledWith({
        name: "query_multi_stream",
      });
      const pair = api.__streamPairs.at(-1);
      // The `start` message lands on the background side of the pair.
      const sent = pair.backgroundPort.onMessage.addListener.mock.calls
        ? pair.popupPort.postMessage.mock.calls[0][0]
        : null;
      expect(sent).toEqual({
        action: "start",
        requests: [
          { domain: "example.com", store: "a" },
          { domain: "example.com", store: "b" },
        ],
      });
      await driveStreamReplies(api, [
        { type: "result", index: 0, response: { results: [] } },
        { type: "result", index: 1, response: { results: [] } },
      ]);
      await queryDone;
    });

    it("merges results across stores and sorts the union by score", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }, { name: "b" }];
      const queryDone = popup.runQuery();
      await flushAsync();
      await driveStreamReplies(api, [
        {
          type: "result",
          index: 0,
          response: {
            results: [{ name: "low", store: "a", match_kind: "name", score: 0.5 }],
          },
        },
        {
          type: "result",
          index: 1,
          response: {
            results: [
              { name: "high", store: "b", match_kind: "url_field", score: 1 },
            ],
          },
        },
      ]);
      await queryDone;
      const names = Array.from(
        popup.elements.results.querySelectorAll(".name"),
      ).map((n) => n.textContent);
      expect(names).toEqual(["high", "low"]);
    });

    it("updates the status counter as each store replies and renders matches incrementally", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [
        { name: "a" },
        { name: "b" },
        { name: "c" },
      ];
      const queryDone = popup.runQuery();
      await flushAsync();
      // Initial state: 0/3 answered, no results rendered yet.
      expect(popup.elements.status.textContent).toMatch(
        /Searching for example\.com… \(0\/3 stores answered\)/,
      );
      expect(popup.elements.results.children.length).toBe(0);

      // First store replies.
      pushStreamReply(api, {
        type: "result",
        index: 0,
        response: {
          results: [{ name: "alpha-hit", match_kind: "name", score: 0.6 }],
        },
      });
      await flushAsync();
      expect(popup.elements.status.textContent).toMatch(
        /\(1\/3 stores answered\)/,
      );
      expect(popup.elements.results.children.length).toBe(1);
      expect(popup.elements.results.textContent).toMatch(/alpha-hit/);

      // Second store replies — list grows AND re-sorts (this entry
      // outranks alpha-hit).
      pushStreamReply(api, {
        type: "result",
        index: 1,
        response: {
          results: [{ name: "beta-hit", match_kind: "name", score: 0.9 }],
        },
      });
      await flushAsync();
      expect(popup.elements.status.textContent).toMatch(
        /\(2\/3 stores answered\)/,
      );
      const namesAfterTwo = Array.from(
        popup.elements.results.querySelectorAll(".name"),
      ).map((n) => n.textContent);
      expect(namesAfterTwo).toEqual(["beta-hit", "alpha-hit"]);

      // Third store replies with nothing — counter advances to 3/3,
      // and the final status switches to the settled "N matches." copy.
      pushStreamReply(api, {
        type: "result",
        index: 2,
        response: { results: [] },
      });
      pushStreamReply(api, { type: "done" });
      await queryDone;
      expect(popup.elements.status.textContent).toBe("2 matches.");
    });

    it("marks a per-store error response as skipped and names it in the final status", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "good" }, { name: "broken" }];
      const queryDone = popup.runQuery();
      await flushAsync();
      await driveStreamReplies(api, [
        {
          type: "result",
          index: 0,
          response: {
            results: [{ name: "x", match_kind: "name", score: 0.5 }],
          },
        },
        {
          type: "result",
          index: 1,
          response: { error: "identity_locked", hint: "touch your key" },
        },
      ]);
      await queryDone;
      expect(popup.elements.status.textContent).toMatch(
        /1 match.*1 store\(s\) skipped: broken/,
      );
    });

    it("marks a per-store non-array results field as skipped", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }];
      const queryDone = popup.runQuery();
      await flushAsync();
      await driveStreamReplies(api, [
        { type: "result", index: 0, response: { results: "broken" } },
      ]);
      await queryDone;
      expect(popup.elements.status.textContent).toMatch(/1 store\(s\) skipped/);
    });

    it("marks every store skipped when the background closes the stream before answering any slot", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }, { name: "b" }];
      const queryDone = popup.runQuery();
      await flushAsync();
      // Simulate the background tearing the stream port down without
      // any `result` messages — e.g. a `connectNative` failure.
      const pair = api.__streamPairs.at(-1);
      pair.backgroundPort.disconnect();
      await queryDone;
      expect(popup.elements.status.textContent).toMatch(/2 store\(s\) skipped/);
    });

    it("marks every store skipped when the background emits a top-level `error` message", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }];
      const queryDone = popup.runQuery();
      await flushAsync();
      // Top-level error: native messaging itself failed before any
      // per-slot reply was possible.
      const pair = api.__streamPairs.at(-1);
      pair.backgroundPort.postMessage({
        type: "error",
        error: "native messaging disabled",
      });
      await queryDone;
      expect(popup.elements.status.textContent).toMatch(/1 store\(s\) skipped/);
    });

    it("marks every store skipped when api.runtime.connect throws synchronously", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }, { name: "b" }];
      api.runtime.connect = vi.fn(() => {
        throw new Error("ports are unavailable here");
      });
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/2 store\(s\) skipped/);
    });

    it("marks every store skipped when api.runtime.connect returns a falsy value", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }];
      api.runtime.connect = vi.fn(() => null);
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/1 store\(s\) skipped/);
    });

    it("marks every still-pending slot skipped when postMessage(start) throws", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }, { name: "b" }];
      api.runtime.connect = vi.fn(() => {
        const port = {
          name: "query_multi_stream",
          onMessage: { addListener: vi.fn() },
          onDisconnect: { addListener: vi.fn() },
          postMessage: vi.fn(() => {
            throw new Error("port write failed");
          }),
          disconnect: vi.fn(),
        };
        api.__streamPairs.push({ popupPort: port, backgroundPort: port });
        return port;
      });
      await popup.runQuery();
      expect(popup.elements.status.textContent).toMatch(/2 store\(s\) skipped/);
    });

    it("dispatches a faster store's results before the slower store has replied — the slow store no longer gates the user-visible latency (J)", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "slow" }, { name: "fast" }];
      const queryDone = popup.runQuery();
      await flushAsync();
      // Fast store answers first, slow store hasn't replied yet — the
      // UI must already show the fast results AND the progress counter
      // must reflect 1-of-2 answered, before slow finishes.
      pushStreamReply(api, {
        type: "result",
        index: 1,
        response: {
          results: [{ name: "fast-hit", match_kind: "name", score: 0.8 }],
        },
      });
      await flushAsync();
      expect(popup.elements.results.children.length).toBe(1);
      expect(popup.elements.results.textContent).toMatch(/fast-hit/);
      expect(popup.elements.status.textContent).toMatch(/\(1\/2 stores answered\)/);
      // Now slow finishes — its match joins the list, and the status
      // settles.
      pushStreamReply(api, {
        type: "result",
        index: 0,
        response: {
          results: [{ name: "slow-hit", match_kind: "name", score: 0.6 }],
        },
      });
      pushStreamReply(api, { type: "done" });
      await queryDone;
      const names = Array.from(
        popup.elements.results.querySelectorAll(".name"),
      ).map((n) => n.textContent);
      expect(names).toEqual(["fast-hit", "slow-hit"]);
    });

    it("ignores result messages whose `index` is not an integer (defensive)", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }];
      const queryDone = popup.runQuery();
      await flushAsync();
      // Garbage index — must be silently dropped, must not crash.
      pushStreamReply(api, {
        type: "result",
        index: "abc",
        response: { results: [{ name: "ignored", match_kind: "name" }] },
      });
      // Then the real result for index 0.
      pushStreamReply(api, {
        type: "result",
        index: 0,
        response: { results: [{ name: "real", match_kind: "name", score: 0.5 }] },
      });
      pushStreamReply(api, { type: "done" });
      await queryDone;
      const names = Array.from(
        popup.elements.results.querySelectorAll(".name"),
      ).map((n) => n.textContent);
      expect(names).toEqual(["real"]);
    });

    it("ignores a duplicate result for an already-settled slot (defensive)", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }];
      const queryDone = popup.runQuery();
      await flushAsync();
      pushStreamReply(api, {
        type: "result",
        index: 0,
        response: { results: [{ name: "first", match_kind: "name", score: 0.5 }] },
      });
      pushStreamReply(api, {
        type: "result",
        index: 0,
        response: { results: [{ name: "second", match_kind: "name", score: 0.9 }] },
      });
      pushStreamReply(api, { type: "done" });
      await queryDone;
      const names = Array.from(
        popup.elements.results.querySelectorAll(".name"),
      ).map((n) => n.textContent);
      // Only the first result lands; the duplicate is dropped so a
      // misbehaving host can't re-render the same slot.
      expect(names).toEqual(["first"]);
    });

    it("tolerates port.disconnect throwing after the stream completes", async () => {
      // The popup's safeDisconnect wraps disconnect in a try/catch
      // so a port that has already been torn down by the background
      // doesn't crash the popup. Drive that branch by handing the
      // popup a port whose `disconnect` throws.
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }];
      let messageListener;
      api.runtime.connect = vi.fn(() => {
        const port = {
          name: "query_multi_stream",
          onMessage: {
            addListener: vi.fn((l) => {
              messageListener = l;
            }),
          },
          onDisconnect: { addListener: vi.fn() },
          postMessage: vi.fn(),
          disconnect: vi.fn(() => {
            throw new Error("port is already closed");
          }),
        };
        api.__streamPairs.push({ popupPort: port, backgroundPort: port });
        return port;
      });
      const queryDone = popup.runQuery();
      await flushAsync();
      // The popup has installed an onMessage listener on the stubbed
      // port. Push a real result followed by `done` — the popup's
      // `done` path calls `port.disconnect()` which throws. The
      // throw must not propagate.
      messageListener({
        type: "result",
        index: 0,
        response: {
          results: [{ name: "x", match_kind: "name", score: 0.5 }],
        },
      });
      messageListener({ type: "done" });
      await queryDone;
      expect(popup.elements.status.textContent).toMatch(/1 match/);
    });

    it("drops result messages whose index is out of bounds (review8 item I)", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }];
      const queryDone = popup.runQuery();
      await flushAsync();
      // Indices outside `[0, total)` never reach the consumer: they
      // would inflate the `answered` counter past `total` and push a
      // phantom `store#N` into the skipped list. Negative and
      // past-the-end values are both rejected at the stream layer.
      pushStreamReply(api, {
        type: "result",
        index: 7,
        response: { error: "identity_locked" },
      });
      pushStreamReply(api, {
        type: "result",
        index: -1,
        response: { error: "identity_locked" },
      });
      // Real result for index 0 settles the legitimate slot.
      pushStreamReply(api, {
        type: "result",
        index: 0,
        response: { results: [{ name: "ok", match_kind: "name", score: 0.5 }] },
      });
      pushStreamReply(api, { type: "done" });
      await queryDone;
      // Only the legitimate store is accounted for: one match, no
      // phantom skipped entries.
      expect(popup.elements.status.textContent).toBe("1 match.");
      expect(popup.elements.status.textContent).not.toMatch(/store#/);
    });

    it("pings the stream port every 20 s while the batch is in flight and stops after done (review8 item H)", async () => {
      const { api, popup } = await setUp();
      vi.useFakeTimers();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }];
      const queryDone = popup.runQuery();
      await vi.advanceTimersByTimeAsync(0);
      const pair = api.__streamPairs.at(-1);
      const pings = () =>
        pair.popupPort.postMessage.mock.calls.filter(
          ([msg]) => msg?.action === "keepalive",
        ).length;
      expect(pings()).toBe(0);
      // First keepalive fires before Chromium's ~30 s service-worker
      // idle deadline would.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(pings()).toBe(1);
      // Settle the batch before the background's 30 s per-request
      // timer fires (which would settle it for us and muddy the
      // ping accounting).
      pair.backgroundPort.postMessage({
        type: "result",
        index: 0,
        response: { results: [] },
      });
      pair.backgroundPort.postMessage({ type: "done" });
      await vi.advanceTimersByTimeAsync(0);
      await queryDone;
      // The interval is cleared on settlement — no pings pile up
      // after the batch is done.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(pings()).toBe(1);
    });

    it("swallows a keepalive postMessage throw when the port died between pings", async () => {
      const { api, popup } = await setUp();
      vi.useFakeTimers();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }];
      let messageListener;
      let postCount = 0;
      api.runtime.connect = vi.fn(() => {
        const port = {
          name: "query_multi_stream",
          onMessage: {
            addListener: vi.fn((l) => {
              messageListener = l;
            }),
          },
          onDisconnect: { addListener: vi.fn() },
          postMessage: vi.fn(() => {
            postCount += 1;
            // The `start` goes through; every later write (the
            // keepalive) finds the port dead.
            if (postCount > 1) {
              throw new Error("port is gone");
            }
          }),
          disconnect: vi.fn(),
        };
        api.__streamPairs.push({ popupPort: port, backgroundPort: port });
        return port;
      });
      const queryDone = popup.runQuery();
      await vi.advanceTimersByTimeAsync(0);
      // The keepalive fires into the dead port and must not blow up
      // the interval callback (an uncaught throw inside setInterval
      // surfaces as an unhandled error in real browsers).
      await vi.advanceTimersByTimeAsync(20_000);
      // The batch can still settle normally through the message path.
      messageListener({
        type: "result",
        index: 0,
        response: { results: [] },
      });
      messageListener({ type: "done" });
      await vi.advanceTimersByTimeAsync(0);
      await queryDone;
      expect(popup.elements.status.textContent).toMatch(/No matches/);
    });

    it("labels a nameless store entry as `store#N` in the skipped list", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      // `loadStores` validates that `stores` is an array but not the
      // per-entry shape — a malformed host roster can carry an entry
      // with no `name`. The skipped-stores line falls back to a
      // positional placeholder instead of printing "undefined".
      popup.state.stores = [{}];
      const queryDone = popup.runQuery();
      await flushAsync();
      pushStreamReply(api, {
        type: "result",
        index: 0,
        response: { error: "identity_locked" },
      });
      pushStreamReply(api, { type: "done" });
      await queryDone;
      expect(popup.elements.status.textContent).toMatch(/skipped: store#0/);
    });

    it("ignores stream messages that aren't well-formed objects", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = popup.ALL_STORES;
      popup.state.protocolOk = true;
      popup.state.stores = [{ name: "a" }];
      const queryDone = popup.runQuery();
      await flushAsync();
      // Junk messages — must be silently dropped.
      pushStreamReply(api, null);
      pushStreamReply(api, "not an object");
      pushStreamReply(api, 42);
      pushStreamReply(api, { type: "unknown_kind", foo: "bar" });
      // Real result lands afterwards.
      pushStreamReply(api, {
        type: "result",
        index: 0,
        response: { results: [{ name: "real", match_kind: "name", score: 0.5 }] },
      });
      pushStreamReply(api, { type: "done" });
      await queryDone;
      const names = Array.from(
        popup.elements.results.querySelectorAll(".name"),
      ).map((n) => n.textContent);
      expect(names).toEqual(["real"]);
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
    it("renders name, kind badge, and optional username/store fields, never a code or password", async () => {
      const { popup } = await setUp();
      // A host that broke the metadata-only contract still gets no
      // secret value onto the row.
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
      expect(secondaries).toEqual(["alice", "store: personal"]);
      expect(li.textContent).not.toContain("hunter2");
      expect(li.textContent).not.toContain("123456");
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
      stubFrames(api, [
        { frameId: 0, fill: { ok: true, filled: { username: true, password: true } } },
      ]);
      api.tabs.query.mockResolvedValueOnce([
        { id: 7, url: "https://example.com" },
      ]);
      const li = popup.renderMatch({
        name: "alice",
        username: "alice",
        match_kind: "name",
        score: 0.5,
      });
      popup.elements.results.appendChild(li);
      li.click();
      await flushAsync();
      expect(api.scripting.executeScript).toHaveBeenCalled();
    });

    it("Enter and Space on the row trigger fill, other keys do not", async () => {
      const { api, popup } = await setUp();
      stubFrames(api, [
        { frameId: 0, fill: { ok: true, filled: { username: true, password: true } } },
      ]);
      api.tabs.query.mockResolvedValue([{ id: 7, url: "https://example.com" }]);
      const li = popup.renderMatch({
        name: "alice",
        username: "alice",
        match_kind: "name",
        score: 0.5,
      });
      popup.elements.results.appendChild(li);
      const e1 = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
      li.dispatchEvent(e1);
      await flushAsync();
      expect(api.scripting.executeScript).toHaveBeenCalled();

      api.scripting.executeScript.mockClear();
      popup.state.filling = false;
      const e2 = new KeyboardEvent("keydown", { key: " ", bubbles: true });
      li.dispatchEvent(e2);
      await flushAsync();
      expect(api.scripting.executeScript).toHaveBeenCalled();

      api.scripting.executeScript.mockClear();
      popup.state.filling = false;
      const e3 = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
      li.dispatchEvent(e3);
      await flushAsync();
      expect(api.scripting.executeScript).not.toHaveBeenCalled();
    });

    it("keydown on the inner Fill button does NOT bubble into a second fill", async () => {
      const { api, popup } = await setUp();
      stubFrames(api, [
        { frameId: 0, fill: { ok: true, filled: { username: true, password: true } } },
      ]);
      const li = popup.renderMatch({
        name: "alice",
        username: "alice",
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
      expect(api.scripting.executeScript).not.toHaveBeenCalled();
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

  describe("injectFillScript", () => {
    it("injects content/fill.js into every frame of the tab", async () => {
      const { api, popup } = await setUp();
      api.scripting.executeScript = vi.fn().mockResolvedValue([]);
      await popup.injectFillScript(7);
      expect(api.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId: 7, allFrames: true },
        files: ["content/fill.js"],
      });
    });

    it("returns the ids of the frames whose injection evaluated to true", async () => {
      const { api, popup } = await setUp();
      api.scripting.executeScript = vi.fn().mockResolvedValue([
        { frameId: 0, result: true },
        { frameId: 3, result: true, documentId: "doc-3" },
        { frameId: 4, error: { message: "no access" } },
        { frameId: 5, result: false },
        { result: true },
        null,
      ]);
      await expect(popup.injectFillScript(7)).resolves.toEqual([0, 3]);
    });

    it("returns null when the browser refuses the injection outright", async () => {
      const { api, popup } = await setUp();
      api.scripting.executeScript = vi
        .fn()
        .mockRejectedValue(new Error("Cannot access contents of the page"));
      await expect(popup.injectFillScript(7)).resolves.toBeNull();
    });

    it("returns an empty list for a non-array result", async () => {
      const { api, popup } = await setUp();
      api.scripting.executeScript = vi.fn().mockResolvedValue(undefined);
      await expect(popup.injectFillScript(7)).resolves.toEqual([]);
    });
  });

  describe("frame port collection", () => {
    it("refuses a pasejo-frame port while no fill is collecting", async () => {
      const { api } = await setUp();
      api.__connectFromContent("pasejo-frame", {
        tab: { id: 7 },
        frameId: 0,
        url: "https://example.com/",
      });
      const pair = api.__streamPairs.at(-1);
      expect(pair.backgroundPort.disconnect).toHaveBeenCalled();
    });

    it("ignores ports with any other name", async () => {
      const { api } = await setUp();
      api.__connectFromContent("something-else", {
        tab: { id: 7 },
        frameId: 0,
      });
      const pair = api.__streamPairs.at(-1);
      expect(pair.backgroundPort.disconnect).not.toHaveBeenCalled();
    });

    it("refuses ports from another tab, without a frame id, or a second port per frame", async () => {
      const { api, popup } = await setUp();
      const collector = popup.createFrameCollector(7);
      const ports = [
        { tab: { id: 8 }, frameId: 0 },
        { tab: { id: 7 } },
        undefined,
        { tab: { id: 7 }, frameId: 0 },
        { tab: { id: 7 }, frameId: 0 },
      ].map((sender) => {
        const port = {
          sender,
          onMessage: { addListener: vi.fn() },
          onDisconnect: { addListener: vi.fn() },
          disconnect: vi.fn(),
        };
        collector.accept(port);
        return port;
      });
      expect(ports.map((p) => p.disconnect.mock.calls.length)).toEqual([
        1, 1, 1, 0, 1,
      ]);
    });

    it("waitFor resolves with ready frames in the requested order and ignores a second ready", async () => {
      const { popup } = await setUp();
      const collector = popup.createFrameCollector(7);
      const make = (frameId) => {
        const port = {
          sender: { tab: { id: 7 }, frameId },
          listeners: [],
          onMessage: { addListener: (l) => port.listeners.push(l) },
          onDisconnect: { addListener: vi.fn() },
          disconnect: vi.fn(),
        };
        collector.accept(port);
        return port;
      };
      const top = make(0);
      const child = make(2);
      const waiting = collector.waitFor([2, 0], 1_000);
      child.listeners[0]({ type: "ready", editableFocused: true });
      child.listeners[0]({ type: "ready", focused: true });
      top.listeners[0]({ type: "other" });
      top.listeners[0](null);
      top.listeners[0]({ type: "ready", focused: true });
      const frames = await waiting;
      expect(frames.map((f) => f.frameId)).toEqual([2, 0]);
      expect(frames[0]).toMatchObject({ focused: false, editableFocused: true });
      expect(frames[1]).toMatchObject({ focused: true, editableFocused: false });
    });

    it("waitFor drops frames that disconnected and stops waiting for them", async () => {
      const { popup } = await setUp();
      const collector = popup.createFrameCollector(7);
      let disconnect;
      const port = {
        sender: { tab: { id: 7 }, frameId: 1 },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: (l) => (disconnect = l) },
        disconnect: vi.fn(),
      };
      collector.accept(port);
      const waiting = collector.waitFor([1], 60_000);
      disconnect();
      await expect(waiting).resolves.toEqual([]);
    });

    it("waitFor gives up on silent frames after the timeout", async () => {
      const { popup } = await setUp();
      vi.useFakeTimers();
      const collector = popup.createFrameCollector(7);
      const waiting = collector.waitFor([0, 1], 2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(waiting).resolves.toEqual([]);
    });

    it("close disconnects every collected port", async () => {
      const { popup } = await setUp();
      const collector = popup.createFrameCollector(7);
      const port = {
        sender: { tab: { id: 7 }, frameId: 0 },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        disconnect: vi.fn(() => {
          throw new Error("already gone");
        }),
      };
      collector.accept(port);
      expect(() => collector.close()).not.toThrow();
      expect(port.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe("orderFramesForFill", () => {
    it("keeps the given order when no frame stands out", async () => {
      const { popup } = await setUp();
      const frames = [{ frameId: 0 }, { frameId: 1 }];
      expect(popup.orderFramesForFill(frames)).toEqual(frames);
    });

    it("puts the frame holding focus first", async () => {
      const { popup } = await setUp();
      const frames = [
        { frameId: 0 },
        { frameId: 1, editableFocused: true },
        { frameId: 2, focused: true },
      ];
      expect(popup.orderFramesForFill(frames).map((f) => f.frameId)).toEqual([
        2, 0, 1,
      ]);
    });

    it("falls back to the frame whose focused element is fillable", async () => {
      const { popup } = await setUp();
      const frames = [{ frameId: 0 }, { frameId: 1, editableFocused: true }];
      expect(popup.orderFramesForFill(frames).map((f) => f.frameId)).toEqual([
        1, 0,
      ]);
    });
  });

  describe("requestFill", () => {
    function fakeFramePort() {
      const port = {
        message: [],
        disconnect: [],
        onMessage: { addListener: (l) => port.message.push(l) },
        onDisconnect: { addListener: (l) => port.disconnect.push(l) },
        postMessage: vi.fn(),
      };
      return port;
    }

    it("resolves with the frame's fill-result and ignores other messages", async () => {
      const { popup } = await setUp();
      const port = fakeFramePort();
      const reply = popup.requestFill({ port }, { type: "fill" });
      port.message[0]({ type: "ready" });
      port.message[0](null);
      port.message[0]({ type: "fill-result", ok: true, filled: {} });
      port.message[0]({ type: "fill-result", ok: false });
      await expect(reply).resolves.toEqual({
        type: "fill-result",
        ok: true,
        filled: {},
      });
      expect(port.postMessage).toHaveBeenCalledWith({ type: "fill" });
    });

    it("coerces a non-boolean ok to false", async () => {
      const { popup } = await setUp();
      const port = fakeFramePort();
      const reply = popup.requestFill({ port }, { type: "fill" });
      port.message[0]({ type: "fill-result", ok: "yes" });
      await expect(reply).resolves.toMatchObject({ ok: false });
    });

    it("resolves ok:false when the frame goes away", async () => {
      const { popup } = await setUp();
      const port = fakeFramePort();
      const reply = popup.requestFill({ port }, { type: "fill" });
      port.disconnect[0]();
      await expect(reply).resolves.toEqual({ ok: false });
    });

    it("resolves ok:false when posting throws", async () => {
      const { popup } = await setUp();
      const port = fakeFramePort();
      port.postMessage = vi.fn(() => {
        throw new Error("gone");
      });
      await expect(
        popup.requestFill({ port }, { type: "fill" }),
      ).resolves.toEqual({ ok: false });
    });

    it("resolves ok:false when the frame stays silent", async () => {
      const { popup } = await setUp();
      vi.useFakeTimers();
      const port = fakeFramePort();
      const reply = popup.requestFill({ port }, { type: "fill" });
      await vi.advanceTimersByTimeAsync(popup.FRAME_FILL_TIMEOUT_MS);
      await expect(reply).resolves.toEqual({ ok: false });
    });
  });

  describe("fillAcrossFrames", () => {
    it("walks frames in order and returns the first ok reply", async () => {
      const { api, popup } = await setUp();
      const filled = stubFrames(api, [
        { frameId: 0, fill: { ok: false } },
        { frameId: 1, fill: { ok: true, filled: { username: true, password: true } } },
        { frameId: 2, fill: { ok: true } },
      ]);
      const reply = await popup.fillAcrossFrames(PAGE, revealAs(), allowAll);
      expect(reply.ok).toBe(true);
      // Stops at the first ok=true (frame 1); frame 2 is not tried.
      expect(filled).toEqual([0, 1]);
    });

    it("skips frames that disconnect mid-fill and tries the next", async () => {
      const { api, popup } = await setUp();
      const filled = stubFrames(api, [
        { frameId: 0, fill: "disconnect" },
        { frameId: 1, fill: { ok: true } },
      ]);
      const reply = await popup.fillAcrossFrames(PAGE, revealAs(), allowAll);
      expect(reply.ok).toBe(true);
      expect(filled).toEqual([0, 1]);
    });

    it("returns { ok: false } when no frame reports success", async () => {
      const { api, popup } = await setUp();
      stubFrames(api, [{ frameId: 0, fill: { ok: false } }]);
      const reply = await popup.fillAcrossFrames(PAGE, revealAs(), allowAll);
      expect(reply.ok).toBe(false);
    });

    it("reports noAccess when the browser refuses the injection", async () => {
      const { api, popup } = await setUp();
      api.scripting.executeScript = vi
        .fn()
        .mockRejectedValue(new Error("Cannot access a chrome:// URL"));
      await expect(
        popup.fillAcrossFrames(PAGE, revealAs(), allowAll),
      ).resolves.toEqual({ ok: false, noAccess: true });
    });

    it("tries the focused frame BEFORE the top frame", async () => {
      const { api, popup } = await setUp();
      const filled = stubFrames(api, [
        { frameId: 0, fill: { ok: true } },
        { frameId: 1, editableFocused: true, fill: { ok: true } },
      ]);
      await popup.fillAcrossFrames(PAGE, revealAs(), allowAll);
      expect(filled).toEqual([1]);
    });

    it("does not try the preferred frame twice when it fails", async () => {
      const { api, popup } = await setUp();
      const filled = stubFrames(api, [
        { frameId: 0, focused: true, fill: { ok: false } },
        { frameId: 1, fill: { ok: true } },
      ]);
      await popup.fillAcrossFrames(PAGE, revealAs(), allowAll);
      expect(filled).toEqual([0, 1]);
    });

    it("never sends a fill to a frame that did not report ready", async () => {
      const { api, popup } = await setUp();
      vi.useFakeTimers();
      const filled = stubFrames(api, [
        { frameId: 0, ready: false, fill: { ok: true } },
      ]);
      const reply = popup.fillAcrossFrames(PAGE, revealAs(), allowAll);
      await vi.advanceTimersByTimeAsync(popup.FRAME_HANDSHAKE_TIMEOUT_MS);
      await expect(reply).resolves.toEqual({ ok: false, refused: 0 });
      expect(filled).toEqual([]);
    });

    it("closes every frame port and stops collecting once done", async () => {
      const { api, popup } = await setUp();
      stubFrames(api, [{ frameId: 0, fill: { ok: true } }]);
      await popup.fillAcrossFrames(PAGE, revealAs(), allowAll);
      const framePair = api.__streamPairs.at(-1);
      expect(framePair.backgroundPort.disconnect).toHaveBeenCalled();
      // A late port is refused now that no fill is collecting.
      api.__connectFromContent("pasejo-frame", { tab: { id: 7 }, frameId: 0 });
      expect(api.__streamPairs.at(-1).backgroundPort.disconnect).toHaveBeenCalled();
    });

    it("leaves a newer fill's collector in place when an older one finishes", async () => {
      const { api, popup } = await setUp();
      const first = deferred();
      api.scripting.executeScript = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce([]);
      const older = popup.fillAcrossFrames(PAGE, revealAs(), allowAll);
      const newer = popup.fillAcrossFrames(PAGE, revealAs(), allowAll);
      await newer;
      first.resolve([]);
      await older;
      // Neither attempt left a collector behind.
      api.__connectFromContent("pasejo-frame", { tab: { id: 7 }, frameId: 0 });
      expect(api.__streamPairs.at(-1).backgroundPort.disconnect).toHaveBeenCalled();
    });
  });

  describe("fillAcrossFrames: credential release", () => {
    it("fills the credential the reveal released, not anything from the match", async () => {
      const { api, popup } = await setUp();
      const filled = stubFrames(api, [
        { frameId: 0, fill: { ok: true, filled: { password: true } } },
      ]);
      const reply = await popup.fillAcrossFrames(
        PAGE,
        revealAs({ ...CREDENTIAL, otp: "123456" }),
        allowAll,
      );
      expect(api.__fillMessages).toEqual([
        { type: "fill", username: "alice", password: "hunter2", otp: "123456" },
      ]);
      expect(reply.credential.otp).toBe("123456");
    });

    it("reveals once, however many frames it tries", async () => {
      const { api, popup } = await setUp();
      stubFrames(api, [
        { frameId: 0, fill: { ok: false } },
        { frameId: 1, fill: { ok: false } },
        { frameId: 2, fill: { ok: true } },
      ]);
      const reveal = revealAs();
      await popup.fillAcrossFrames(PAGE, reveal, allowAll);
      expect(reveal).toHaveBeenCalledTimes(1);
    });

    it("reports the released credential when every frame refused the fill", async () => {
      const { api, popup } = await setUp();
      stubFrames(api, [{ frameId: 0, fill: { ok: false } }]);
      const reply = await popup.fillAcrossFrames(PAGE, revealAs(), allowAll);
      expect(reply).toEqual({ ok: false, refused: 0, credential: CREDENTIAL });
    });

    it("does not reveal when the browser refuses the injection", async () => {
      const { api, popup } = await setUp();
      api.scripting.executeScript = vi.fn().mockRejectedValue(new Error("no"));
      const reveal = revealAs();
      await popup.fillAcrossFrames(PAGE, reveal, allowAll);
      expect(reveal).not.toHaveBeenCalled();
    });

    it("does not reveal when the top frame shows another origin", async () => {
      const { api, popup } = await setUp();
      stubFrames(api, [{ frameId: 0, url: "https://evil.test/", fill: { ok: true } }]);
      const reveal = revealAs();
      const reply = await popup.fillAcrossFrames(PAGE, reveal, allowAll);
      expect(reply).toEqual({ ok: false, pageChanged: true });
      expect(reveal).not.toHaveBeenCalled();
    });

    it("does not reveal when no frame may receive the credential", async () => {
      const { api, popup } = await setUp();
      const filled = stubFrames(api, [{ frameId: 0, fill: { ok: true } }]);
      const reveal = revealAs();
      const reply = await popup.fillAcrossFrames(PAGE, reveal, async () => false);
      expect(reply).toEqual({ ok: false, refused: 1 });
      expect(reveal).not.toHaveBeenCalled();
      expect(filled).toEqual([]);
    });

    it("stops without filling when the reveal fails", async () => {
      const { api, popup } = await setUp();
      const filled = stubFrames(api, [{ frameId: 0, fill: { ok: true } }]);
      const failure = { hostError: { error: "not_matched", store: "personal" } };
      const reply = await popup.fillAcrossFrames(
        PAGE,
        vi.fn(async () => failure),
        allowAll,
      );
      expect(reply).toEqual({ ok: false, revealFailure: failure });
      expect(filled).toEqual([]);
    });

    it("skips a frame that went away while the reveal was pending", async () => {
      const { api, popup } = await setUp();
      const filled = stubFrames(api, [
        { frameId: 0, fill: { ok: true } },
        { frameId: 1, fill: { ok: true } },
      ]);
      const reveal = vi.fn(async () => {
        // The top frame navigates while the host decrypts.
        api.__streamPairs
          .find((pair) => pair.backgroundPort.sender?.frameId === 0)
          .popupPort.disconnect();
        return { credential: CREDENTIAL };
      });
      const reply = await popup.fillAcrossFrames(PAGE, reveal, allowAll);
      expect(reply.ok).toBe(true);
      expect(filled).toEqual([1]);
    });
  });

  describe("fields the page hides or covers", () => {
    it("keeps the first known reason a frame gave for refusing the fill", async () => {
      const { api, popup } = await setUp();
      stubFrames(api, [
        { frameId: 0, fill: { ok: false, reason: "bogus" } },
        { frameId: 1, fill: { ok: false, reason: "covered" } },
        { frameId: 2, fill: { ok: false, reason: "hidden" } },
      ]);
      const reply = await popup.fillAcrossFrames(PAGE, revealAs(), allowAll);
      expect(reply).toMatchObject({ ok: false, reason: "covered" });
    });

    it("drops a reason it has no message for", async () => {
      const { api, popup } = await setUp();
      stubFrames(api, [{ frameId: 0, fill: { ok: false, reason: "toString" } }]);
      const reply = await popup.fillAcrossFrames(PAGE, revealAs(), allowAll);
      expect(reply.reason).toBeUndefined();
    });

    for (const [reason, text] of [
      ["hidden", "Nothing filled. The login field for alice is hidden on this page."],
      [
        "offscreen",
        "Nothing filled. The login field for alice is outside the visible part of the page.",
      ],
      [
        "covered",
        "Nothing filled. Something on the page lies over the login field for alice.",
      ],
    ]) {
      it(`explains a fill refused because the field is ${reason}`, async () => {
        const { api, popup } = await setUp();
        stubFrames(api, [{ frameId: 0, fill: { ok: false, reason } }]);
        await popup.fillIntoActiveTab({ name: "alice", store: "personal" });
        expect(popup.elements.status.textContent).toBe(text);
        expect(popup.elements.status.classList.contains("error")).toBe(true);
        expect(popup.state.filling).toBe(false);
      });
    }

    it("prefers the field's reason over skipped frames of other sites", async () => {
      const { api, popup } = await setUp();
      stubHost(api);
      stubFrames(api, [
        { frameId: 0, fill: { ok: false, reason: "covered" } },
        { frameId: 1, url: "https://evil.test/", fill: { ok: true } },
      ]);
      await popup.fillIntoActiveTab({ name: "alice", store: "personal" });
      expect(popup.elements.status.textContent).toMatch(/lies over the login field/);
    });
  });

  describe("fillIntoActiveTab: release at click time", () => {
    const match = Object.freeze({
      name: "example.com/alice",
      store: "personal",
      username: "alice",
      url: "https://example.com/login",
      match_kind: "url_field",
      score: 1,
    });

    it("asks the host to reveal the picked secret for the page's host", async () => {
      const { api, popup } = await setUp();
      stubHost(api);
      const filled = stubFrames(api, [
        { frameId: 0, fill: { ok: true, filled: { username: true, password: true } } },
      ]);
      await popup.fillIntoActiveTab(match);
      expect(revealRequests(api)).toEqual([
        {
          type: "reveal",
          store: "personal",
          name: "example.com/alice",
          domain: "example.com",
        },
      ]);
      expect(api.__fillMessages[0].password).toBe("hunter2");
      expect(popup.elements.status.textContent).toBe("Filled example.com/alice.");
    });

    it("never reveals while listing matches", async () => {
      const { api, popup } = await setUp();
      stubHost(api, { results: { "example.com": [match] } });
      popup.state.domain = "example.com";
      popup.state.store = "personal";
      await popup.runQuery();
      expect(popup.elements.results.children).toHaveLength(1);
      expect(revealRequests(api)).toEqual([]);
    });

    it("does not reveal when the tab changed since the popup opened", async () => {
      const { api, popup } = await setUp();
      stubHost(api);
      api.tabs.query.mockResolvedValueOnce([{ id: 7, url: "https://evil.test/" }]);
      await popup.fillIntoActiveTab(match);
      expect(revealRequests(api)).toEqual([]);
    });

    it("renders the host's refusal and fills nothing", async () => {
      const { api, popup } = await setUp();
      stubHost(api, { reveal: { error: "not_matched", store: "personal" } });
      const filled = stubFrames(api, [{ frameId: 0, fill: { ok: true } }]);
      await popup.fillIntoActiveTab(match);
      expect(filled).toEqual([]);
      expect(popup.elements.status.textContent).toBe(
        "The host did not release this credential for this site. Refresh and pick the match again.",
      );
      expect(popup.elements.status.classList.contains("error")).toBe(true);
      expect(popup.state.filling).toBe(false);
    });

    it("renders the host error a locked identity produces on reveal", async () => {
      const { api, popup } = await setUp();
      stubHost(api, {
        reveal: { error: "identity_locked", store: "personal", hint: "no key" },
      });
      stubFrames(api, [{ frameId: 0, fill: { ok: true } }]);
      await popup.fillIntoActiveTab(match);
      expect(popup.elements.status.textContent).toMatch(/^Could not decrypt/);
    });

    it("reports a reveal that never reached the host", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage = vi
        .fn()
        .mockResolvedValue({ ok: false, error: "host gone" });
      const filled = stubFrames(api, [{ frameId: 0, fill: { ok: true } }]);
      await popup.fillIntoActiveTab(match);
      expect(filled).toEqual([]);
      expect(popup.elements.status.textContent).toMatch(/host gone/);
      expect(popup.state.filling).toBe(false);
    });

    it("treats a reveal reply without a credential as undecodable", async () => {
      const { api, popup } = await setUp();
      stubHost(api, { reveal: { results: [] } });
      const filled = stubFrames(api, [{ frameId: 0, fill: { ok: true } }]);
      await popup.fillIntoActiveTab(match);
      expect(filled).toEqual([]);
      expect(popup.elements.status.textContent).toMatch(/could not decode/);
    });

    it("shows the released code on the row and keeps the popup open when the page took none", async () => {
      const { api, popup } = await setUp();
      stubHost(api, {
        reveal: (message) => ({
          credential: { ...CREDENTIAL, name: message.name, otp: "123456" },
        }),
      });
      stubFrames(api, [
        { frameId: 0, fill: { ok: true, filled: { username: true, password: true, otp: false } } },
      ]);
      const close = vi.spyOn(window, "close").mockImplementation(() => {});
      const row = popup.renderMatch(match);
      popup.elements.results.appendChild(row);
      expect(row.querySelector(".otp")).toBeNull();
      vi.useFakeTimers();
      const done = popup.fillIntoActiveTab(match, row);
      await vi.runAllTimersAsync();
      await done;
      expect(row.querySelector(".otp").textContent).toBe("OTP: 123456");
      expect(popup.elements.status.textContent).toBe(
        "Filled example.com/alice. Its one-time code is shown below.",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(close).not.toHaveBeenCalled();
      expect(popup.state.filling).toBe(false);
    });

    it("replaces the code a previous fill showed instead of adding a second one", async () => {
      const { api, popup } = await setUp();
      let code = 111111;
      stubHost(api, {
        reveal: () => ({ credential: { ...CREDENTIAL, otp: String(code++) } }),
      });
      stubFrames(api, [{ frameId: 0, fill: { ok: true, filled: { password: true } } }]);
      vi.spyOn(window, "close").mockImplementation(() => {});
      const row = popup.renderMatch(match);
      await popup.fillIntoActiveTab(match, row);
      await popup.fillIntoActiveTab(match, row);
      const codes = Array.from(row.querySelectorAll(".otp")).map(
        (el) => el.textContent,
      );
      expect(codes).toEqual(["OTP: 111112"]);
    });

    it("shows the released code when the fill found no field at all", async () => {
      const { api, popup } = await setUp();
      stubHost(api, {
        reveal: () => ({ credential: { ...CREDENTIAL, otp: "654321" } }),
      });
      stubFrames(api, [{ frameId: 0, fill: { ok: false } }]);
      const row = popup.renderMatch(match);
      await popup.fillIntoActiveTab(match, row);
      expect(row.querySelector(".otp").textContent).toBe("OTP: 654321");
      expect(popup.elements.status.textContent).toBe(
        "No frame on the page had a fillable password input. Its one-time code is shown below.",
      );
    });

    it("does not show a code the page already received", async () => {
      const { api, popup } = await setUp();
      stubHost(api, {
        reveal: () => ({ credential: { ...CREDENTIAL, otp: "123456" } }),
      });
      stubFrames(api, [
        { frameId: 0, fill: { ok: true, filled: { username: true, password: true, otp: true } } },
      ]);
      const close = vi.spyOn(window, "close").mockImplementation(() => {});
      const row = popup.renderMatch(match);
      vi.useFakeTimers();
      const done = popup.fillIntoActiveTab(match, row);
      await vi.runAllTimersAsync();
      await done;
      expect(row.querySelector(".otp")).toBeNull();
      await vi.advanceTimersByTimeAsync(600);
      expect(close).toHaveBeenCalled();
    });

    it("shows no code when the fill was not started from a row", async () => {
      const { api, popup } = await setUp();
      stubHost(api, {
        reveal: () => ({ credential: { ...CREDENTIAL, otp: "123456" } }),
      });
      stubFrames(api, [{ frameId: 0, fill: { ok: true, filled: { password: true } } }]);
      vi.spyOn(window, "close").mockImplementation(() => {});
      await popup.fillIntoActiveTab(match);
      expect(popup.elements.status.textContent).toBe("Filled example.com/alice.");
    });

    it("passes the row to the fill when the row is clicked", async () => {
      const { api, popup } = await setUp();
      stubHost(api, {
        reveal: () => ({ credential: { ...CREDENTIAL, otp: "123456" } }),
      });
      stubFrames(api, [{ frameId: 0, fill: { ok: false } }]);
      const row = popup.renderMatch(match);
      popup.elements.results.appendChild(row);
      row.click();
      await flushAsync();
      await flushAsync();
      expect(row.querySelector(".otp").textContent).toBe("OTP: 123456");
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
        { id: 7, url: "https://example.com/login" },
      ]);
      stubFrames(api, [{ frameId: 0, fill: { ok: true, filled: { username: true, password: false } } }]);
      await popup.fillIntoActiveTab({ name: "alice", username: "alice" });
      expect(popup.elements.status.textContent).toMatch(
        /Filled username for alice/,
      );
      expect(popup.elements.status.textContent).toMatch(/no password field/);
    });

    it("renders the full-fill success message", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([
        { id: 7, url: "https://example.com/login" },
      ]);
      stubFrames(api, [{ frameId: 0, fill: { ok: true, filled: { username: true, password: true } } }]);
      await popup.fillIntoActiveTab({ name: "alice", username: "alice" });
      expect(popup.elements.status.textContent).toBe("Filled alice.");
    });

    it("notes the one-time code in the success message of a full fill", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([
        { id: 7, url: "https://example.com/login" },
      ]);
      stubFrames(api, [{ frameId: 0, fill: { ok: true, filled: { username: true, password: true, otp: true } } }]);
      await popup.fillIntoActiveTab({ name: "alice", username: "alice" });
      expect(popup.elements.status.textContent).toBe(
        "Filled alice and its one-time code.",
      );
    });

    it("notes the one-time code in the partial-fill (username-only) message", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([
        { id: 7, url: "https://example.com/login" },
      ]);
      stubFrames(api, [{ frameId: 0, fill: {
            ok: true,
            filled: { username: true, password: false, otp: true },
          } }]);
      await popup.fillIntoActiveTab({ name: "alice", username: "alice" });
      expect(popup.elements.status.textContent).toMatch(
        /Filled username and its one-time code for alice/,
      );
      expect(popup.elements.status.textContent).toMatch(/no password field/);
    });

    it("reports a standalone 2FA fill (one-time code only)", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([
        { id: 7, url: "https://example.com/login" },
      ]);
      stubFrames(api, [{ frameId: 0, fill: {
            ok: true,
            filled: { username: false, password: false, otp: true },
          } }]);
      await popup.fillIntoActiveTab({ name: "alice" });
      expect(popup.elements.status.textContent).toBe(
        "Filled the one-time code for alice.",
      );
    });

    it("renders the generic 'no fillable input' error when every frame says ok:false", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([
        { id: 7, url: "https://example.com/login" },
      ]);
      stubFrames(api, [{ frameId: 0, fill: { ok: false } }]);
      await popup.fillIntoActiveTab({ name: "alice", username: "alice" });
      expect(popup.elements.status.textContent).toMatch(/No frame/);
      expect(popup.state.filling).toBe(false);
    });

    it("explains that the browser keeps the extension off the page when injection is refused", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([
        { id: 7, url: "https://example.com/login" },
      ]);
      api.scripting.executeScript = vi
        .fn()
        .mockRejectedValue(new Error("Cannot access contents of the page"));
      await popup.fillIntoActiveTab({ name: "alice", username: "alice" });
      expect(popup.elements.status.textContent).toMatch(
        /pasejo cannot fill this page/,
      );
      expect(popup.elements.status.classList.contains("error")).toBe(true);
      expect(popup.state.filling).toBe(false);
    });
  });

  describe("page and frame origins", () => {
    it("originOf returns the URL's origin, or \"null\" when it has none", async () => {
      const { popup } = await setUp();
      expect(popup.originOf("https://Example.com:8443/a?b#c")).toBe(
        "https://example.com:8443",
      );
      expect(popup.originOf("not a url")).toBe("null");
      expect(popup.originOf(undefined)).toBe("null");
    });

    it("isSamePage needs the recorded tab id and origin", async () => {
      const { popup } = await setUp();
      const page = { tabId: 7, origin: "https://example.com" };
      expect(
        popup.isSamePage(page, { id: 7, origin: "https://example.com" }),
      ).toBe(true);
      expect(
        popup.isSamePage(page, { id: 8, origin: "https://example.com" }),
      ).toBe(false);
      expect(
        popup.isSamePage(page, { id: 7, origin: "https://evil.test" }),
      ).toBe(false);
      expect(
        popup.isSamePage(page, { id: 7, origin: "http://example.com" }),
      ).toBe(false);
      expect(popup.isSamePage(null, { id: 7, origin: "null" })).toBe(false);
      expect(
        popup.isSamePage({ tabId: 7, origin: "null" }, { id: 7, origin: "null" }),
      ).toBe(false);
    });

    it("senderOrigin prefers the browser's sender.origin over sender.url", async () => {
      const { popup } = await setUp();
      expect(
        popup.senderOrigin({
          origin: "https://example.com",
          url: "about:blank",
        }),
      ).toBe("https://example.com");
      expect(popup.senderOrigin({ url: "https://sso.example.com/x" })).toBe(
        "https://sso.example.com",
      );
      expect(popup.senderOrigin({ url: "about:srcdoc" })).toBe("null");
    });

    it("originHostname accepts only http(s) origins", async () => {
      const { popup } = await setUp();
      expect(popup.originHostname("https://Login.Example.com")).toBe(
        "login.example.com",
      );
      expect(popup.originHostname("http://[::1]:8080")).toBe("::1");
      expect(popup.originHostname("null")).toBeNull();
      expect(popup.originHostname("chrome-extension://abc")).toBeNull();
    });

    it("storedUrlHostname reads a URL field the way the host does", async () => {
      const { popup } = await setUp();
      expect(popup.storedUrlHostname("https://login.example.com/x")).toBe(
        "login.example.com",
      );
      expect(popup.storedUrlHostname("  login.example.com/path")).toBe(
        "login.example.com",
      );
      expect(popup.storedUrlHostname(undefined)).toBeNull();
      expect(popup.storedUrlHostname("http://")).toBeNull();
    });
  });

  describe("frameMatchesCredential", () => {
    const match = Object.freeze({
      name: "example.com/alice",
      store: "personal",
      url: "https://example.com/login",
    });

    function hostReplies(api, resultsByDomain) {
      api.runtime.sendMessage = vi.fn(async (message) => ({
        ok: true,
        response: { results: resultsByDomain[message.domain] ?? [] },
      }));
    }

    it("allows the page's own host without asking the host", async () => {
      const { api, popup } = await setUp();
      const allowed = await popup.frameMatchesCredential(
        { origin: "https://example.com" },
        match,
        PAGE,
        new Map(),
      );
      expect(allowed).toBe(true);
      expect(api.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("allows the exact host of the secret's stored URL without asking the host", async () => {
      const { api, popup } = await setUp();
      const allowed = await popup.frameMatchesCredential(
        { origin: "https://login.example.com" },
        { ...match, url: "https://login.example.com/sso" },
        PAGE,
        new Map(),
      );
      expect(allowed).toBe(true);
      expect(api.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("refuses an opaque or non-http(s) frame origin", async () => {
      const { api, popup } = await setUp();
      for (const origin of ["null", "file://", "data:text/html,x"]) {
        expect(
          await popup.frameMatchesCredential({ origin }, match, PAGE, new Map()),
        ).toBe(false);
      }
      expect(api.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("allows another host when the host returns the same secret for it", async () => {
      const { api, popup } = await setUp();
      hostReplies(api, {
        "sso.example.com": [
          { name: "example.com/alice", store: "personal", score: 0.9 },
        ],
      });
      const allowed = await popup.frameMatchesCredential(
        { origin: "https://sso.example.com" },
        match,
        PAGE,
        new Map(),
      );
      expect(allowed).toBe(true);
      expect(api.runtime.sendMessage).toHaveBeenCalledWith({
        type: "query",
        domain: "sso.example.com",
        store: "personal",
      });
    });

    it("refuses another host when the host returns a different secret or store", async () => {
      const { api, popup } = await setUp();
      hostReplies(api, {
        "evil.test": [
          { name: "evil.test/alice", store: "personal" },
          { name: "example.com/alice", store: "work" },
          null,
        ],
      });
      const allowed = await popup.frameMatchesCredential(
        { origin: "https://evil.test" },
        match,
        PAGE,
        new Map(),
      );
      expect(allowed).toBe(false);
    });

    it("refuses another host when the host query fails or replies with an error", async () => {
      const { api, popup } = await setUp();
      api.runtime.sendMessage = vi
        .fn()
        .mockRejectedValueOnce(new Error("host down"))
        .mockResolvedValueOnce({
          ok: true,
          response: { error: "identity_locked" },
        });
      expect(
        await popup.frameMatchesCredential(
          { origin: "https://a.test" },
          match,
          PAGE,
          new Map(),
        ),
      ).toBe(false);
      expect(
        await popup.frameMatchesCredential(
          { origin: "https://b.test" },
          { ...match, store: undefined },
          PAGE,
          new Map(),
        ),
      ).toBe(false);
      expect(api.runtime.sendMessage).toHaveBeenLastCalledWith({
        type: "query",
        domain: "b.test",
        store: null,
      });
    });

    it("asks the host once per frame host within one fill", async () => {
      const { api, popup } = await setUp();
      hostReplies(api, {});
      const lookups = new Map();
      for (let i = 0; i < 3; i += 1) {
        await popup.frameMatchesCredential(
          { origin: "https://ads.test" },
          match,
          PAGE,
          lookups,
        );
      }
      expect(api.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("fill delivery to frames of other sites", () => {
    const match = Object.freeze({
      name: "example.com/alice",
      store: "personal",
      username: "alice",
      url: "https://example.com/login",
    });

    it("never sends the credential to a cross-origin iframe the secret does not match, on a legitimate page", async () => {
      const { api, popup } = await setUp();
      stubHost(api);
      // The legitimate top frame has no login form; an embedded frame
      // from another site does, and would happily take a password.
      const filled = stubFrames(api, [
        { frameId: 0, url: "https://example.com/login", fill: { ok: false } },
        {
          frameId: 1,
          url: "https://evil.test/frame",
          editableFocused: true,
          fill: { ok: true, filled: { username: true, password: true } },
        },
      ]);
      await popup.fillIntoActiveTab(match);
      expect(filled).toEqual([0]);
      expect(api.runtime.sendMessage).toHaveBeenCalledWith({
        type: "query",
        domain: "evil.test",
        store: "personal",
      });
      expect(popup.elements.status.textContent).toBe(
        "Nothing filled. Frames from sites that example.com/alice does not match were skipped.",
      );
      expect(popup.state.filling).toBe(false);
    });

    it("judges a frame by its browser-reported origin, not its URL", async () => {
      const { api, popup } = await setUp();
      stubHost(api);
      // An about:blank frame the attacker origin created reports its
      // inherited origin, which is what counts.
      const filled = stubFrames(api, [
        {
          frameId: 0,
          url: "https://example.com/login",
          origin: "https://example.com",
          fill: { ok: false },
        },
        {
          frameId: 4,
          url: "about:blank",
          origin: "https://evil.test",
          fill: { ok: true },
        },
      ]);
      await popup.fillIntoActiveTab(match);
      expect(filled).toEqual([0]);
    });

    it("fills a same-site SSO iframe the host confirms for the secret", async () => {
      const { api, popup } = await setUp();
      stubHost(api, {
        results: {
          "sso.example.com": [{ name: "example.com/alice", store: "personal" }],
        },
      });
      const filled = stubFrames(api, [
        { frameId: 0, url: "https://example.com/login", fill: { ok: false } },
        {
          frameId: 2,
          url: "https://sso.example.com/frame",
          fill: { ok: true, filled: { username: true, password: true } },
        },
      ]);
      await popup.fillIntoActiveTab(match);
      expect(filled).toEqual([0, 2]);
      expect(popup.elements.status.textContent).toBe(
        "Filled example.com/alice.",
      );
    });

    it("refuses to fill when the tab navigated to another origin between popup open and fill", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([
        { id: 7, url: "https://evil.test/login" },
      ]);
      const filled = stubFrames(api, [
        { frameId: 0, url: "https://evil.test/login", fill: { ok: true } },
      ]);
      await popup.fillIntoActiveTab(match);
      expect(api.scripting.executeScript).not.toHaveBeenCalled();
      expect(filled).toEqual([]);
      expect(popup.elements.status.textContent).toMatch(/The page changed/);
      expect(popup.state.filling).toBe(false);
    });

    it("refuses to fill when the user switched to another tab", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([
        { id: 8, url: "https://example.com/login" },
      ]);
      await popup.fillIntoActiveTab(match);
      expect(api.scripting.executeScript).not.toHaveBeenCalled();
      expect(popup.elements.status.textContent).toMatch(/The page changed/);
    });

    it("refuses to fill when the top frame navigated after the tab check", async () => {
      const { api, popup } = await setUp();
      // The tab still reported example.com, but by the time the fill
      // script ran the top document was on another origin.
      const filled = stubFrames(api, [
        { frameId: 0, url: "https://evil.test/login", fill: { ok: true } },
        { frameId: 1, url: "https://example.com/frame", fill: { ok: true } },
      ]);
      await popup.fillIntoActiveTab(match);
      expect(filled).toEqual([]);
      expect(popup.elements.status.textContent).toMatch(/The page changed/);
      expect(popup.state.filling).toBe(false);
    });

    it("still fills when the tab moved to another path on the same origin", async () => {
      const { api, popup } = await setUp();
      api.tabs.query.mockResolvedValueOnce([
        { id: 7, url: "https://example.com/login/step-2" },
      ]);
      const filled = stubFrames(api, [
        {
          frameId: 0,
          url: "https://example.com/login/step-2",
          fill: { ok: true, filled: { username: true, password: true } },
        },
      ]);
      await popup.fillIntoActiveTab(match);
      expect(filled).toEqual([0]);
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
            protocol_version: 2,
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
        [popup.HOST_STORE_KEY]: {
          "example.com": { store: "work", lastUsedAt: 100 },
        },
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
            protocol_version: 2,
            stores: [{ name: "personal", default: true }],
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          response: { results: [] },
        });
      api.storage.local.get.mockResolvedValue({});
      await popup.refreshStoresAndQuery();
      // The popup now uses a single map under one storage key — the
      // lookup is by storage key, not by per-host key. We assert the
      // ONE storage key the recall path reads and let coerceHostStoreMap
      // + the hostname lookup handle the rest.
      expect(api.storage.local.get).toHaveBeenCalledWith(popup.HOST_STORE_KEY);
    });

    it("respects an intermediate dropdown change that lands while loadStores is in flight (item K)", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = "a";
      // chrome.storage holds the OLD pick — modelling the race where
      // the change handler's `rememberStoreForHost` hasn't yet
      // propagated by the time the refresh's `pickPreferredStore`
      // would read it.
      api.storage.local.get.mockResolvedValue({
        [popup.HOST_STORE_KEY]: {
          "example.com": { store: "a", lastUsedAt: 100 },
        },
      });
      const loadStoresDeferred = deferred();
      api.runtime.sendMessage
        // list_stores reply is gated until the test resolves it.
        .mockReturnValueOnce(loadStoresDeferred.promise)
        // Query that the post-refresh `runQuery` issues.
        .mockResolvedValue({ ok: true, response: { results: [] } });

      const refreshDone = popup.refreshStoresAndQuery();
      // Simulate the user clicking the dropdown mid-refresh: the
      // production change handler writes the new pick synchronously
      // to `state.store` before any await.
      popup.state.store = "b";

      loadStoresDeferred.resolve({
        ok: true,
        response: {
          protocol_version: 2,
          stores: [
            { name: "a", default: true },
            { name: "b", default: false },
          ],
        },
      });
      await refreshDone;

      // The user's intermediate pick survives — both in state and in
      // the dropdown DOM, and the post-refresh query carries the
      // user's choice rather than the previously remembered one.
      expect(popup.state.store).toBe("b");
      const optionB = Array.from(popup.elements.store.options).find(
        (o) => o.value === "b",
      );
      expect(optionB.selected).toBe(true);
      const lastSent = api.runtime.sendMessage.mock.calls.at(-1)[0];
      expect(lastSent).toEqual({
        type: "query",
        domain: "example.com",
        store: "b",
      });
    });

    it("falls back to the remembered preference when the user did NOT change the dropdown during refresh (positive control for item K)", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = "a";
      api.storage.local.get.mockResolvedValue({
        [popup.HOST_STORE_KEY]: {
          "example.com": { store: "work", lastUsedAt: 100 },
        },
      });
      api.runtime.sendMessage
        .mockResolvedValueOnce({
          ok: true,
          response: {
            protocol_version: 2,
            stores: [
              { name: "personal", default: true },
              { name: "work", default: false },
            ],
          },
        })
        .mockResolvedValue({ ok: true, response: { results: [] } });

      await popup.refreshStoresAndQuery();

      // The user didn't touch the dropdown, so the remembered "work"
      // wins (rather than `state.store`'s "a" — which was a stale
      // snapshot from before the refresh).
      expect(popup.state.store).toBe("work");
    });

    it("falls back to the remembered preference when the user's intermediate pick names a store that has since been removed (item K, defensive)", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      popup.state.store = "a";
      api.storage.local.get.mockResolvedValue({
        [popup.HOST_STORE_KEY]: {
          "example.com": { store: "a", lastUsedAt: 100 },
        },
      });
      const loadStoresDeferred = deferred();
      api.runtime.sendMessage
        .mockReturnValueOnce(loadStoresDeferred.promise)
        .mockResolvedValue({ ok: true, response: { results: [] } });

      const refreshDone = popup.refreshStoresAndQuery();
      // User picks a store that the refreshed roster has since
      // dropped (e.g. they had it open in a stale popup while
      // someone re-keyed the config).
      popup.state.store = "ghost-store";

      loadStoresDeferred.resolve({
        ok: true,
        response: {
          protocol_version: 2,
          stores: [
            { name: "a", default: true },
            { name: "b", default: false },
          ],
        },
      });
      await refreshDone;

      // "ghost-store" isn't in the refreshed list, so the refresh
      // falls back through `pickPreferredStore` and lands on the
      // remembered "a".
      expect(popup.state.store).toBe("a");
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
          protocol_version: 2,
          stores: [{ name: "personal", default: true }],
          results: [],
        },
      });
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

    it("on popup open runs the legacy-storage cleanup in parallel with refreshStoresAndQuery (item N)", async () => {
      delete globalThis.PASEJO;
      delete globalThis.chrome;
      const api = makeApiMock();
      api.tabs.query = vi
        .fn()
        .mockResolvedValue([{ id: 1, url: "https://example.com" }]);
      api.runtime.sendMessage = vi.fn().mockResolvedValue({
        ok: true,
        response: {
          protocol_version: 2,
          stores: [{ name: "personal", default: true }],
          results: [],
        },
      });
      // First storage.local.get returns the legacy-and-current
      // mixed state a machine that ran a pre-fix-B build would
      // have. Later gets (recall path) are answered with whatever
      // the current schema holds — which the seeding pass above
      // also includes — so the popup still resolves the per-host
      // preference.
      api.storage.local.get = vi.fn().mockResolvedValue({
        "store-for-host:example.com": "personal",
        "pasejo:host-store-index": ["example.com"],
        "pasejo:host-stores": {
          "example.com": { store: "personal", lastUsedAt: 1 },
        },
      });
      api.storage.local.set = vi.fn();
      api.storage.local.remove = vi.fn();
      globalThis.chrome = api;
      buildPopupDom(document);
      loadClassicScript("src/protocol.js");
      loadClassicScript("src/popup/popup.js", { expose: EXPOSED });
      await flushAsync();
      await flushAsync();
      // The legacy keys were removed in one call carrying both.
      expect(api.storage.local.remove).toHaveBeenCalledTimes(1);
      const removed = api.storage.local.remove.mock.calls[0][0];
      expect(removed).toEqual(
        expect.arrayContaining([
          "store-for-host:example.com",
          "pasejo:host-store-index",
        ]),
      );
      // The canonical key was NOT removed.
      expect(removed).not.toContain("pasejo:host-stores");
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
      const setCall = api.storage.local.set.mock.calls.at(-1)[0];
      expect(setCall).toHaveProperty(popup.HOST_STORE_KEY);
      expect(setCall[popup.HOST_STORE_KEY]["example.com"]?.store).toBe("b");
      expect(api.runtime.sendMessage).toHaveBeenCalled();
    });

    it("refresh re-runs loadStores → runQuery and disables the button while in flight", async () => {
      const { api, popup } = await setUp();
      popup.state.domain = "example.com";
      api.runtime.sendMessage
        .mockResolvedValueOnce({
          ok: true,
          response: {
            protocol_version: 2,
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

  describe("secrets whose policy asks for confirmation", () => {
    const match = Object.freeze({
      name: "bank/alice",
      store: "personal",
      username: "alice",
      url: "https://example.com",
      match_kind: "url_field",
      score: 1,
      confirm: true,
    });

    function rowFor(popup, entry = match) {
      const row = popup.renderMatch(entry);
      popup.elements.results.appendChild(row);
      return row;
    }

    function okFrames(api) {
      return stubFrames(api, [
        { frameId: 0, fill: { ok: true, filled: { username: true, password: true } } },
      ]);
    }

    it("asks on the row before anything is revealed", async () => {
      const { api, popup } = await setUp();
      stubHost(api);
      const filled = okFrames(api);
      const row = rowFor(popup);
      row.click();
      await flushAsync();
      expect(revealRequests(api)).toEqual([]);
      expect(filled).toEqual([]);
      expect(api.scripting.executeScript).not.toHaveBeenCalled();
      const prompt = row.querySelector(".confirm");
      expect(prompt.textContent).toContain(
        "Fill bank/alice into example.com? This secret asks to be confirmed every time.",
      );
      const [confirm, cancel] = prompt.querySelectorAll("button");
      expect(confirm.textContent).toBe("Fill now");
      expect(cancel.textContent).toBe("Cancel");
      expect(document.activeElement).toBe(cancel);
    });

    it("keeps the confirm button disabled long enough that a double-click cannot confirm", async () => {
      const { api, popup } = await setUp();
      stubHost(api);
      const filled = okFrames(api);
      vi.useFakeTimers();
      const row = rowFor(popup);
      row.querySelector(".actions button").click();
      const confirm = row.querySelector(".confirm button");
      expect(confirm.getAttribute("aria-disabled")).toBe("true");
      confirm.click();
      await vi.advanceTimersByTimeAsync(popup.CONFIRM_ARM_DELAY_MS - 1);
      expect(revealRequests(api)).toEqual([]);
      expect(row.querySelector(".confirm")).not.toBeNull();
      expect(confirm.getAttribute("aria-disabled")).toBe("true");
      await vi.advanceTimersByTimeAsync(1);
      expect(confirm.hasAttribute("aria-disabled")).toBe(false);
      confirm.click();
      await vi.runAllTimersAsync();
      expect(revealRequests(api)).toHaveLength(1);
      expect(filled).toEqual([0]);
      expect(row.querySelector(".confirm")).toBeNull();
      expect(popup.elements.status.textContent).toBe("Filled bank/alice.");
    });

    it("cancel closes the prompt, releases nothing and returns focus to the row", async () => {
      const { api, popup } = await setUp();
      stubHost(api);
      const filled = okFrames(api);
      vi.useFakeTimers();
      const row = rowFor(popup);
      row.click();
      const cancel = row.querySelectorAll(".confirm button")[1];
      cancel.click();
      await vi.runAllTimersAsync();
      expect(row.querySelector(".confirm")).toBeNull();
      expect(document.activeElement).toBe(row);
      expect(revealRequests(api)).toEqual([]);
      expect(filled).toEqual([]);
    });

    it("keeps one prompt when the row is activated again", async () => {
      const { api, popup } = await setUp();
      stubHost(api);
      okFrames(api);
      const row = rowFor(popup);
      row.click();
      row.click();
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await flushAsync();
      expect(row.querySelectorAll(".confirm")).toHaveLength(1);
      expect(revealRequests(api)).toEqual([]);
    });

    it("moves the prompt when another row asks for confirmation", async () => {
      const { api, popup } = await setUp();
      stubHost(api);
      okFrames(api);
      const first = rowFor(popup);
      const second = rowFor(popup, { ...match, name: "bank/bob" });
      first.click();
      second.click();
      await flushAsync();
      expect(first.querySelector(".confirm")).toBeNull();
      expect(second.querySelector(".confirm").textContent).toContain(
        "Fill bank/bob into example.com?",
      );
    });

    it("drops an open prompt when the results are listed again", async () => {
      const { api, popup } = await setUp();
      stubHost(api, { results: { "example.com": [match] } });
      okFrames(api);
      vi.useFakeTimers();
      const row = rowFor(popup);
      row.click();
      const confirm = row.querySelector(".confirm button");
      popup.state.domain = "example.com";
      popup.state.store = "personal";
      await popup.runQuery();
      await vi.runAllTimersAsync();
      expect(confirm.isConnected).toBe(false);
      expect(confirm.getAttribute("aria-disabled")).toBe("true");
    });

    it("asks instead of filling when the fill is started without a confirmation", async () => {
      const { api, popup } = await setUp();
      stubHost(api);
      okFrames(api);
      await popup.fillIntoActiveTab(match);
      expect(revealRequests(api)).toEqual([]);
      expect(api.tabs.query).not.toHaveBeenCalled();
      expect(popup.state.filling).toBe(false);
    });

    it("treats any value of the flag other than false as asking", async () => {
      const { popup } = await setUp();
      expect(popup.needsConfirmation({ confirm: true })).toBe(true);
      expect(popup.needsConfirmation({ confirm: "always" })).toBe(true);
      expect(popup.needsConfirmation({ confirm: false })).toBe(false);
      expect(popup.needsConfirmation({})).toBe(false);
    });

    it("fills a secret without the flag on the first click", async () => {
      const { api, popup } = await setUp();
      stubHost(api);
      const filled = okFrames(api);
      const row = rowFor(popup, { ...match, confirm: false });
      row.click();
      await vi.waitFor(() => expect(filled).toEqual([0]));
      expect(row.querySelector(".confirm")).toBeNull();
      expect(revealRequests(api)).toHaveLength(1);
    });
  });
});
