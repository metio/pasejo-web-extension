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
import { invokeBackgroundListener, makeApiMock } from "./helpers/mock-api.js";

// Returns the listener-captured port (created by the first
// `connectNative` call) so a test can drive its messages /
// disconnects.
function lastConnectedPort(api) {
  const port = api.__ports.at(-1);
  if (!port) {
    throw new Error("no native port was opened");
  }
  return port;
}

describe("background.js", () => {
  let api;

  beforeEach(() => {
    delete globalThis.PASEJO;
    delete globalThis.browser;
    delete globalThis.chrome;
    api = makeApiMock();
    globalThis.chrome = api;
    loadClassicScript("src/protocol.js");
    loadClassicScript("src/background.js");
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.PASEJO;
    delete globalThis.browser;
    delete globalThis.chrome;
  });

  describe("validateResponseShape", () => {
    // The function is hidden in module scope after `vm.runInThisContext`
    // executes background.js, but it's reachable indirectly: every reply
    // delivered through `port.__emitMessage` flows through it, and the
    // promise from `sendNativeRequest` resolves or rejects based on the
    // outcome. Each test below exercises one limit by sending the
    // matching payload and asserting on the resulting reply shape.

    async function exchange(payload) {
      const resultPromise = invokeBackgroundListener(api, {
        type: "list_stores",
      });
      const port = lastConnectedPort(api);
      port.__emitMessage(payload);
      return resultPromise;
    }

    it("accepts a flat well-shaped reply", async () => {
      const reply = await exchange({
        protocol_version: 1,
        stores: [{ name: "personal", default: true }],
      });
      expect(reply).toEqual({ ok: true, response: expect.any(Object) });
      expect(reply.response.stores[0].name).toBe("personal");
    });

    it("rejects strings longer than the 64K cap", async () => {
      const huge = "x".repeat(64 * 1024 + 1);
      const reply = await exchange({ hint: huge });
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/longer than/);
    });

    it("rejects arrays longer than 10K entries", async () => {
      const arr = new Array(10_001).fill(0);
      const reply = await exchange({ stores: arr });
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/array longer than/);
    });

    it("rejects objects with more than 1024 keys", async () => {
      const big = {};
      for (let i = 0; i < 1025; i += 1) {
        big[`k${i}`] = i;
      }
      const reply = await exchange({ extras: big });
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/more than 1024 keys/);
    });

    it("rejects payloads nesting deeper than 6 levels", async () => {
      // depth 0..6 is 7 levels; one nested object at depth 7 trips.
      const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
      const reply = await exchange(deep);
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/deeper than 6/);
    });

    it("ignores numbers, booleans, and null when walking the tree", async () => {
      const reply = await exchange({
        protocol_version: 1,
        n: 42,
        b: true,
        nil: null,
        u: undefined,
      });
      expect(reply.ok).toBe(true);
    });
  });

  describe("native message dispatch", () => {
    it("translates a `query` message into the correct host request", async () => {
      const replyPromise = invokeBackgroundListener(api, {
        type: "query",
        domain: "example.com",
        store: "personal",
      });
      const port = lastConnectedPort(api);
      expect(api.runtime.connectNative).toHaveBeenCalledWith("wtf.metio.pasejo");
      expect(port.postMessage).toHaveBeenCalledWith({
        action: "query",
        domain: "example.com",
        store: "personal",
      });
      port.__emitMessage({ results: [] });
      const reply = await replyPromise;
      expect(reply).toEqual({ ok: true, response: { results: [] } });
    });

    it("defaults the `store` field to null when caller omits it", async () => {
      const replyPromise = invokeBackgroundListener(api, {
        type: "query",
        domain: "example.com",
      });
      const port = lastConnectedPort(api);
      expect(port.postMessage.mock.calls[0][0].store).toBeNull();
      port.__emitMessage({ results: [] });
      await replyPromise;
    });

    it("translates `list_stores` into a list_stores action", async () => {
      const replyPromise = invokeBackgroundListener(api, {
        type: "list_stores",
      });
      const port = lastConnectedPort(api);
      expect(port.postMessage).toHaveBeenCalledWith({ action: "list_stores" });
      port.__emitMessage({ protocol_version: 1, stores: [] });
      const reply = await replyPromise;
      expect(reply.response.stores).toEqual([]);
    });

    it("returns an error reply for unknown message types", async () => {
      const reply = await invokeBackgroundListener(api, { type: "delete_all" });
      expect(reply).toEqual({
        ok: false,
        error: "unknown message type: delete_all",
      });
      expect(api.runtime.connectNative).not.toHaveBeenCalled();
    });

    it("returns an error reply for non-object messages", async () => {
      const replyA = await invokeBackgroundListener(api, null);
      expect(replyA).toEqual({ ok: false, error: "invalid message" });
      const replyB = await invokeBackgroundListener(api, "ping");
      expect(replyB).toEqual({ ok: false, error: "invalid message" });
    });

    it("rejects the listener call when the native host disconnects before a reply", async () => {
      const replyPromise = invokeBackgroundListener(api, {
        type: "list_stores",
      });
      const port = lastConnectedPort(api);
      api.runtime.lastError = { message: "host crashed" };
      port.__emitDisconnect();
      const reply = await replyPromise;
      expect(reply.ok).toBe(false);
      expect(reply.error).toBe("host crashed");
    });

    it("uses a fallback message when `lastError` is unset on disconnect", async () => {
      const replyPromise = invokeBackgroundListener(api, {
        type: "list_stores",
      });
      const port = lastConnectedPort(api);
      api.runtime.lastError = undefined;
      port.__emitDisconnect();
      const reply = await replyPromise;
      expect(reply.error).toBe("native host disconnected before reply");
    });

    it("times out after 30 seconds when the host stays silent", async () => {
      vi.useFakeTimers();
      const replyPromise = invokeBackgroundListener(api, {
        type: "list_stores",
      });
      vi.advanceTimersByTime(30_000);
      const reply = await replyPromise;
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/did not respond within 30s/);
      const port = lastConnectedPort(api);
      expect(port.disconnect).toHaveBeenCalled();
    });

    it("propagates a connectNative throw as the listener's error", async () => {
      api.runtime.connectNative = vi.fn(() => {
        throw new Error("native messaging is disabled");
      });
      const reply = await invokeBackgroundListener(api, {
        type: "list_stores",
      });
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/native messaging is disabled/);
    });

    it("rejects with a clean message when connectNative returns null (item O)", async () => {
      // The WebExtensions spec says connectNative returns a Port or
      // throws, but a buggy/locked-down browser could return null. The
      // null guard short-circuits before the `port.onMessage` deref so
      // the popup gets a self-describing error instead of a bare
      // "Cannot read properties of null …" TypeError.
      api.runtime.connectNative = vi.fn(() => null);
      const reply = await invokeBackgroundListener(api, {
        type: "list_stores",
      });
      expect(reply).toEqual({
        ok: false,
        error: "native messaging port could not be opened",
      });
    });

    it("does not leak the 30s response timer when connectNative returns null", async () => {
      vi.useFakeTimers();
      api.runtime.connectNative = vi.fn(() => null);
      const reply = await invokeBackgroundListener(api, {
        type: "list_stores",
      });
      expect(reply.ok).toBe(false);
      // Before the null-port guard, the timeout `setTimeout` was
      // scheduled before the TypeError fired, so a stray timer sat
      // pending until it harmlessly fired 30s later. The guard short-
      // circuits earlier, so no timer should be in flight.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects with the same clean message when connectNative returns undefined", async () => {
      api.runtime.connectNative = vi.fn(() => undefined);
      const reply = await invokeBackgroundListener(api, {
        type: "list_stores",
      });
      expect(reply.error).toBe("native messaging port could not be opened");
    });

    it("propagates a postMessage throw as the listener's error", async () => {
      api.runtime.connectNative = vi.fn(() => {
        const port = {
          onMessage: { addListener: vi.fn() },
          onDisconnect: { addListener: vi.fn() },
          postMessage: vi.fn(() => {
            throw new Error("port write failed");
          }),
          disconnect: vi.fn(),
        };
        api.__ports.push(port);
        return port;
      });
      const reply = await invokeBackgroundListener(api, {
        type: "list_stores",
      });
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/port write failed/);
    });

    it("ignores subsequent messages once the promise has settled", async () => {
      const replyPromise = invokeBackgroundListener(api, {
        type: "list_stores",
      });
      const port = lastConnectedPort(api);
      port.__emitMessage({ protocol_version: 1, stores: [] });
      // A second emission after settle must not affect the resolved value
      // or throw on the listener.
      port.__emitMessage({ protocol_version: 99 });
      const reply = await replyPromise;
      expect(reply.response.stores).toEqual([]);
    });
  });

  describe("disconnect after a successful reply", () => {
    it("does not re-resolve the listener call", async () => {
      const replyPromise = invokeBackgroundListener(api, {
        type: "list_stores",
      });
      const port = lastConnectedPort(api);
      port.__emitMessage({ protocol_version: 1, stores: [] });
      port.__emitDisconnect();
      const reply = await replyPromise;
      expect(reply.ok).toBe(true);
    });

    it("query_multi with an empty requests array resolves immediately without opening a port", async () => {
      const reply = await invokeBackgroundListener(api, {
        type: "query_multi",
        requests: [],
      });
      expect(reply).toEqual({ ok: true, responses: [] });
      expect(api.runtime.connectNative).not.toHaveBeenCalled();
    });

    it("query_multi fans out N requests with sequential request_ids and pairs replies by id", async () => {
      const replyPromise = invokeBackgroundListener(api, {
        type: "query_multi",
        requests: [
          { domain: "a.test", store: "alpha" },
          { domain: "b.test", store: "beta" },
          { domain: "c.test", store: "gamma" },
        ],
      });
      const port = lastConnectedPort(api);
      // Verify the actions plus monotonic request_ids.
      expect(port.postMessage.mock.calls.map(([msg]) => msg)).toEqual([
        { request_id: 1, action: "query", domain: "a.test", store: "alpha" },
        { request_id: 2, action: "query", domain: "b.test", store: "beta" },
        { request_id: 3, action: "query", domain: "c.test", store: "gamma" },
      ]);
      // Replies arrive in arbitrary order; the helper has to align them
      // back to the input order on the way out.
      port.__emitMessage({ request_id: 2, results: [{ name: "beta-hit" }] });
      port.__emitMessage({ request_id: 1, results: [{ name: "alpha-hit" }] });
      port.__emitMessage({ request_id: 3, results: [{ name: "gamma-hit" }] });
      const reply = await replyPromise;
      expect(reply.ok).toBe(true);
      expect(reply.responses[0].results[0].name).toBe("alpha-hit");
      expect(reply.responses[1].results[0].name).toBe("beta-hit");
      expect(reply.responses[2].results[0].name).toBe("gamma-hit");
      // request_id is stripped from each per-store payload.
      for (const r of reply.responses) {
        expect(r).not.toHaveProperty("request_id");
      }
      expect(port.disconnect).toHaveBeenCalled();
    });

    it("query_multi defaults `store` to null when caller omits it", async () => {
      const replyPromise = invokeBackgroundListener(api, {
        type: "query_multi",
        requests: [{ domain: "x.test" }],
      });
      const port = lastConnectedPort(api);
      expect(port.postMessage.mock.calls[0][0]).toEqual({
        request_id: 1,
        action: "query",
        domain: "x.test",
        store: null,
      });
      port.__emitMessage({ request_id: 1, results: [] });
      await replyPromise;
    });

    it("query_multi treats a port disconnect as transport_error for every still-pending request", async () => {
      const replyPromise = invokeBackgroundListener(api, {
        type: "query_multi",
        requests: [
          { domain: "a.test", store: "a" },
          { domain: "b.test", store: "b" },
          { domain: "c.test", store: "c" },
        ],
      });
      const port = lastConnectedPort(api);
      // Only one reply lands before the disconnect.
      port.__emitMessage({ request_id: 2, results: [{ name: "b" }] });
      api.runtime.lastError = { message: "host crashed" };
      port.__emitDisconnect();
      const reply = await replyPromise;
      expect(reply.ok).toBe(true);
      expect(reply.responses[0]).toEqual({
        error: "transport_error",
        hint: "host crashed",
      });
      expect(reply.responses[1].results[0].name).toBe("b");
      expect(reply.responses[2]).toEqual({
        error: "transport_error",
        hint: "host crashed",
      });
    });

    it("query_multi disconnects with the fallback message when lastError is unset", async () => {
      const replyPromise = invokeBackgroundListener(api, {
        type: "query_multi",
        requests: [{ domain: "a.test", store: "a" }],
      });
      const port = lastConnectedPort(api);
      api.runtime.lastError = undefined;
      port.__emitDisconnect();
      const reply = await replyPromise;
      expect(reply.responses[0].hint).toBe(
        "native host disconnected before reply",
      );
    });

    it("query_multi rejects the whole batch when a reply violates the size limits", async () => {
      const replyPromise = invokeBackgroundListener(api, {
        type: "query_multi",
        requests: [{ domain: "a.test", store: "a" }],
      });
      const port = lastConnectedPort(api);
      const huge = "x".repeat(64 * 1024 + 1);
      port.__emitMessage({ request_id: 1, hint: huge });
      const reply = await replyPromise;
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/longer than/);
      expect(port.disconnect).toHaveBeenCalled();
    });

    it("query_multi drops a reply whose request_id is not pending (out-of-band or repeated)", async () => {
      vi.useFakeTimers();
      const replyPromise = invokeBackgroundListener(api, {
        type: "query_multi",
        requests: [{ domain: "a.test", store: "a" }],
      });
      const port = lastConnectedPort(api);
      // Wrong request_id — the backstop is the per-request timer.
      port.__emitMessage({ request_id: 99, results: [] });
      // Also: non-integer.
      port.__emitMessage({ request_id: "abc", results: [] });
      // Also: missing.
      port.__emitMessage({ results: [] });
      // Also: not even an object.
      port.__emitMessage(42);
      // Nothing has resolved the only pending slot yet. Advance time
      // to fire the per-request timeout.
      await vi.advanceTimersByTimeAsync(30_000);
      const reply = await replyPromise;
      expect(reply.ok).toBe(true);
      expect(reply.responses[0].error).toBe("transport_error");
      expect(reply.responses[0].hint).toMatch(/request 1 did not get a response/);
    });

    it("query_multi marks a single request transport_error when postMessage throws for it", async () => {
      // First postMessage throws; second succeeds. The thrown call's
      // slot ends up as transport_error; the second resolves normally.
      let call = 0;
      api.runtime.connectNative = vi.fn(() => {
        const port = {
          name: "wtf.metio.pasejo",
          onMessage: { addListener: vi.fn() },
          onDisconnect: { addListener: vi.fn() },
          postMessage: vi.fn(() => {
            call += 1;
            if (call === 1) {
              throw new Error("write failed");
            }
          }),
          disconnect: vi.fn(),
        };
        api.__ports.push(port);
        return port;
      });
      const replyPromise = invokeBackgroundListener(api, {
        type: "query_multi",
        requests: [
          { domain: "a.test", store: "a" },
          { domain: "b.test", store: "b" },
        ],
      });
      const port = lastConnectedPort(api);
      // Drive the second slot's reply through the listener directly.
      const onMessage = port.onMessage.addListener.mock.calls[0][0];
      onMessage({ request_id: 2, results: [] });
      const reply = await replyPromise;
      expect(reply.responses[0]).toEqual({
        error: "transport_error",
        hint: "write failed",
      });
      expect(reply.responses[1].results).toEqual([]);
    });

    it("query_multi propagates a connectNative throw to the caller as ok:false", async () => {
      api.runtime.connectNative = vi.fn(() => {
        throw new Error("native messaging disabled");
      });
      const reply = await invokeBackgroundListener(api, {
        type: "query_multi",
        requests: [{ domain: "a.test", store: "a" }],
      });
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/disabled/);
    });

    it("query_multi rejects with a clean message when connectNative returns null", async () => {
      api.runtime.connectNative = vi.fn(() => null);
      const reply = await invokeBackgroundListener(api, {
        type: "query_multi",
        requests: [{ domain: "a.test", store: "a" }],
      });
      expect(reply).toEqual({
        ok: false,
        error: "native messaging port could not be opened",
      });
    });

    it("query_multi without a requests array degenerates to an empty batch", async () => {
      const reply = await invokeBackgroundListener(api, {
        type: "query_multi",
      });
      expect(reply).toEqual({ ok: true, responses: [] });
    });

    it("query_multi tolerates port.disconnect() throwing on cleanup", async () => {
      // A port that survives a write+read round but throws when we
      // tear it down on success. The batch must still resolve cleanly
      // — disconnect throws are silently swallowed.
      const onMessageListeners = [];
      const onDisconnectListeners = [];
      api.runtime.connectNative = vi.fn(() => {
        const port = {
          name: "wtf.metio.pasejo",
          onMessage: {
            addListener: vi.fn((l) => onMessageListeners.push(l)),
          },
          onDisconnect: {
            addListener: vi.fn((l) => onDisconnectListeners.push(l)),
          },
          postMessage: vi.fn(),
          disconnect: vi.fn(() => {
            throw new Error("port is already closed");
          }),
        };
        api.__ports.push(port);
        return port;
      });
      const replyPromise = invokeBackgroundListener(api, {
        type: "query_multi",
        requests: [{ domain: "a.test", store: "a" }],
      });
      const [onMessage] = onMessageListeners;
      onMessage({ request_id: 1, results: [] });
      const reply = await replyPromise;
      expect(reply.ok).toBe(true);
      expect(reply.responses[0].results).toEqual([]);
    });

    it("query_multi tolerates a duplicate reply for an already-settled request_id", async () => {
      const replyPromise = invokeBackgroundListener(api, {
        type: "query_multi",
        requests: [{ domain: "a.test", store: "a" }],
      });
      const port = lastConnectedPort(api);
      port.__emitMessage({ request_id: 1, results: [{ name: "first" }] });
      // Late duplicate — must be silently dropped, must not re-resolve.
      port.__emitMessage({ request_id: 1, results: [{ name: "second" }] });
      const reply = await replyPromise;
      expect(reply.responses[0].results[0].name).toBe("first");
    });

    it("query_multi ignores a per-request timeout that fires after the slot has settled (review7 item A)", async () => {
      // The race the fix targets: a per-request setTimeout callback
      // can already be in the browser's macrotask queue when
      // `finalize` runs `clearTimeout` from the message-path. The
      // cancellation is too late — the queued callback still runs.
      // Without the `pending.has` guard inside `finalize`, that stale
      // callback overwrites `responses[idx]` with `transport_error`
      // AFTER the batch has already resolved with the real reply,
      // mutating the array the popup is reading.
      //
      // vitest's fake-timer engine respects clearTimeout
      // synchronously, so the natural race doesn't reproduce there.
      // We instead stub `setTimeout` to capture every scheduled
      // callback without firing it, and `clearTimeout` to be a no-op
      // (so the timer "stays in the queue" the way the buggy real
      // browser does), then manually invoke the captured callback
      // after the slot has been settled by a real reply.
      const capturedTimers = [];
      const origSetTimeout = globalThis.setTimeout;
      const origClearTimeout = globalThis.clearTimeout;
      globalThis.setTimeout = (cb) => {
        capturedTimers.push(cb);
        return capturedTimers.length;
      };
      globalThis.clearTimeout = () => {};
      try {
        const replyPromise = invokeBackgroundListener(api, {
          type: "query_multi",
          requests: [{ domain: "a.test", store: "a" }],
        });
        const port = lastConnectedPort(api);
        port.__emitMessage({
          request_id: 1,
          results: [{ name: "real" }],
        });
        // The slot is settled; the captured per-request timer would
        // be a no-op in a real browser if clearTimeout caught it in
        // time — but in the race it fires anyway.
        expect(capturedTimers).toHaveLength(1);
        capturedTimers[0]();
        const reply = await replyPromise;
        expect(reply.ok).toBe(true);
        expect(reply.responses[0]).toEqual({ results: [{ name: "real" }] });
        // CRITICAL: the real reply must NOT have been overwritten
        // with the stale-timer's transport_error payload.
        expect(reply.responses[0].error).toBeUndefined();
      } finally {
        globalThis.setTimeout = origSetTimeout;
        globalThis.clearTimeout = origClearTimeout;
      }
    });

    it("tolerates `port.disconnect()` throwing on the cleanup path", async () => {
      // Once a port has already been torn down by the browser, calling
      // `disconnect` a second time can throw — `settle` swallows that
      // because the channel is already gone.
      const port = {
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(() => {
          throw new Error("port is already closed");
        }),
      };
      api.runtime.connectNative = vi.fn(() => {
        api.__ports.push(port);
        return port;
      });
      const replyPromise = invokeBackgroundListener(api, {
        type: "list_stores",
      });
      // Listener registered on the port:
      const onMessage = port.onMessage.addListener.mock.calls[0][0];
      // Should not throw even though `disconnect` does:
      onMessage({ protocol_version: 1, stores: [] });
      const reply = await replyPromise;
      expect(reply.ok).toBe(true);
    });
  });
});

describe("background.js with importScripts available (service-worker context)", () => {
  let api;

  beforeEach(() => {
    delete globalThis.PASEJO;
    delete globalThis.importScripts;
    api = makeApiMock();
    globalThis.chrome = api;
    // Reproduce the Chromium service-worker contract: importScripts is a
    // synchronous function that loads the referenced file into the same
    // global. Our stub stands in for protocol.js by installing the
    // PASEJO namespace itself.
    globalThis.importScripts = vi.fn(() => {
      loadClassicScript("src/protocol.js");
    });
    loadClassicScript("src/background.js");
  });

  afterEach(() => {
    delete globalThis.PASEJO;
    delete globalThis.importScripts;
    delete globalThis.browser;
    delete globalThis.chrome;
  });

  it("calls importScripts('protocol.js') when the function is defined", () => {
    expect(globalThis.importScripts).toHaveBeenCalledWith("protocol.js");
    expect(globalThis.PASEJO).toBeDefined();
  });
});

describe("background.js when importScripts throws (defensive)", () => {
  beforeEach(() => {
    delete globalThis.PASEJO;
    delete globalThis.importScripts;
    globalThis.chrome = makeApiMock();
    globalThis.importScripts = vi.fn(() => {
      throw new Error("network failure loading protocol.js");
    });
    // Pre-install PASEJO so the subsequent `const { … } =
    // globalThis.PASEJO` destructure doesn't crash — mirrors the Firefox
    // event-page contract where the manifest had already loaded
    // protocol.js into the same scope.
    loadClassicScript("src/protocol.js");
  });

  afterEach(() => {
    delete globalThis.PASEJO;
    delete globalThis.importScripts;
    delete globalThis.browser;
    delete globalThis.chrome;
  });

  it("swallows the throw and still registers the dispatch listener", () => {
    expect(() => loadClassicScript("src/background.js")).not.toThrow();
  });
});
