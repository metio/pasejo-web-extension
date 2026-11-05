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
import {
  invokeBackgroundListener,
  makeApiMock,
} from "./helpers/mock-api.js";

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

// Opens the streaming port the popup uses for multi-store queries and
// posts the `start` message immediately. Returns the popup-facing
// port plus an array that captures every reply the background pushed
// back through it (each entry is one of `{type:"result"|"done"|"error"}`,
// in the order it arrived). Tests that need the native-port side
// reach for `lastConnectedPort(api)` the same way as before.
function openQueryStream(api, requests) {
  const port = api.runtime.connect({ name: "query_multi_stream" });
  const messages = [];
  port.onMessage.addListener((msg) => messages.push(msg));
  port.postMessage({ action: "start", requests });
  return { port, messages };
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

    it("rejects payloads that exceed the maximum nesting depth (item S)", async () => {
      // MAX_DEPTH is the deepest accepted depth value (depths 0..6
      // pass; an attempt to recurse into depth 7 trips). The seven
      // nested objects below put the leaf scalar at depth 7.
      const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
      const reply = await exchange(deep);
      expect(reply.ok).toBe(false);
      // The new wording reads "exceeds maximum nesting depth of 6"
      // so the threshold and the rejection are unambiguous in the
      // same message. Pinned to lock the wording in place — a
      // future revert to "deeper than 6 levels" would re-introduce
      // the off-by-one ambiguity the original review flagged.
      expect(reply.error).toMatch(/exceeds maximum nesting depth of 6/);
    });

    it("accepts a payload that hits exactly MAX_DEPTH (boundary check, item S)", async () => {
      // The leaf scalar here lives at depth 6 (one less than the
      // failing fixture above), which is exactly the deepest
      // accepted value. The reply must pass — the original
      // ambiguous "deeper than 6 levels" wording could be misread
      // as "depth 6 itself is rejected"; this test pins the
      // inclusive boundary.
      const exact = { a: { b: { c: { d: { e: { f: 1 } } } } } };
      const reply = await exchange(exact);
      expect(reply.ok).toBe(true);
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

  describe("validateResponseAgainstAction (item D — type guards at the IPC boundary)", () => {
    // Both `sendNativeRequest` (single) and `sendNativeBatch` (multi)
    // route every host reply through the per-action type validator
    // AFTER the shape limits clear. A type mismatch surfaces to the
    // popup as a synthesized `{error: "decode_error", hint: ...}`
    // envelope rather than the transport-error category that
    // shape failures use — same as the popup's existing
    // Array.isArray guards, but enforced at the IPC boundary so the
    // single source of truth lives in the background.

    async function exchangeListStores(payload) {
      const resultPromise = invokeBackgroundListener(api, {
        type: "list_stores",
      });
      const port = lastConnectedPort(api);
      port.__emitMessage(payload);
      return resultPromise;
    }

    async function exchangeQuery(payload) {
      const resultPromise = invokeBackgroundListener(api, {
        type: "query",
        domain: "example.com",
      });
      const port = lastConnectedPort(api);
      port.__emitMessage(payload);
      return resultPromise;
    }

    it("accepts a list_stores reply whose `stores` is an array", async () => {
      const reply = await exchangeListStores({
        protocol_version: 1,
        stores: [{ name: "a", default: true }],
      });
      expect(reply.ok).toBe(true);
      expect(reply.response.stores[0].name).toBe("a");
    });

    it("synthesises decode_error when list_stores returns `stores` as a non-array", async () => {
      const reply = await exchangeListStores({
        protocol_version: 1,
        stores: "broken",
      });
      expect(reply.ok).toBe(true);
      expect(reply.response).toEqual({
        error: "decode_error",
        hint: "`stores` is not an array",
      });
    });

    it("synthesises decode_error when list_stores returns `protocol_version` as a non-number", async () => {
      const reply = await exchangeListStores({
        protocol_version: "one",
        stores: [],
      });
      expect(reply.ok).toBe(true);
      expect(reply.response).toEqual({
        error: "decode_error",
        hint: "`protocol_version` is not a number",
      });
    });

    it("accepts a list_stores reply that omits stores entirely (optional field)", async () => {
      const reply = await exchangeListStores({ protocol_version: 1 });
      expect(reply.ok).toBe(true);
      expect(reply.response).toEqual({ protocol_version: 1 });
    });

    it("accepts a list_stores reply that omits protocol_version (popup catches that case)", async () => {
      // The host SHOULD always send protocol_version on list_stores
      // replies — but the absence is a different failure mode than a
      // wrong type, and the popup's `isCompatibleProtocol` already
      // surfaces it as a clear "unknown protocol" message. The
      // type guard only fires when the field is present-but-wrong.
      const reply = await exchangeListStores({ stores: [] });
      expect(reply.ok).toBe(true);
      expect(reply.response).toEqual({ stores: [] });
    });

    it("accepts a query reply whose `results` is an array", async () => {
      const reply = await exchangeQuery({ results: [{ name: "alice" }] });
      expect(reply.ok).toBe(true);
      expect(reply.response.results[0].name).toBe("alice");
    });

    it("synthesises decode_error when query returns `results` as a non-array", async () => {
      const reply = await exchangeQuery({ results: "broken" });
      expect(reply.ok).toBe(true);
      expect(reply.response).toEqual({
        error: "decode_error",
        hint: "`results` is not an array",
      });
    });

    it("accepts a query reply that omits results entirely (popup defaults to [])", async () => {
      const reply = await exchangeQuery({});
      expect(reply.ok).toBe(true);
      expect(reply.response).toEqual({});
    });

    it("passes a host-error reply through any action without type checks", async () => {
      // The error envelope (`{error, hint}`) is the host's universal
      // failure shape; the validator must let it through regardless of
      // which action was sent so the popup's `renderHostError` can
      // render the host's preferred error copy.
      const errorReply = {
        error: "identity_locked",
        hint: "touch your YubiKey",
      };
      const listReply = await exchangeListStores(errorReply);
      expect(listReply.ok).toBe(true);
      expect(listReply.response).toEqual(errorReply);
      const queryReply = await exchangeQuery(errorReply);
      expect(queryReply.ok).toBe(true);
      expect(queryReply.response).toEqual(errorReply);
    });

    it("synthesises decode_error when the reply is not an object (top-level scalar)", async () => {
      // Shape validation accepts a bare string (no recursion into it
      // beyond the length check); the type guard catches the
      // "not an object" gap because every action's contract assumes
      // an object reply with named fields.
      const reply = await exchangeListStores("not-an-object");
      expect(reply.ok).toBe(true);
      expect(reply.response).toEqual({
        error: "decode_error",
        hint: "host reply is not an object",
      });
    });

    it("synthesises decode_error when the reply is null (shape walk treats null as terminal)", async () => {
      const reply = await exchangeListStores(null);
      // Background's `sendBackground`-equivalent doesn't unwrap null
      // host responses — the listener has its own response-shape
      // guard. Verify the validator catches it cleanly rather than
      // letting it propagate as a TypeError.
      expect(reply.ok).toBe(true);
      expect(reply.response).toEqual({
        error: "decode_error",
        hint: "host reply is not an object",
      });
    });

    it("streaming: a slot whose reply has the wrong `results` type becomes decode_error WITHOUT poisoning siblings", () => {
      // The load-bearing batch test: in a multi-store query, one store
      // returning garbage must not skip every other store. The host's
      // worker-thread parallelism already isolates failures at the
      // decrypt step; this guard pins the same isolation at the
      // type-validation step under the new streaming model.
      const { messages } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
        { domain: "b.test", store: "b" },
      ]);
      const nativePort = lastConnectedPort(api);
      nativePort.__emitMessage({ request_id: 1, results: [{ name: "good" }] });
      nativePort.__emitMessage({ request_id: 2, results: "broken" });
      const results = messages.filter((m) => m.type === "result");
      expect(results.find((r) => r.index === 0).response.results[0].name).toBe(
        "good",
      );
      expect(results.find((r) => r.index === 1).response).toEqual({
        error: "decode_error",
        hint: "`results` is not an array",
      });
      expect(messages.at(-1)).toEqual({ type: "done" });
    });

    it("streaming: a host-error envelope on one slot still passes through (action-typed validator lets error shapes through)", () => {
      const { messages } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
        { domain: "b.test", store: "b" },
      ]);
      const nativePort = lastConnectedPort(api);
      nativePort.__emitMessage({ request_id: 1, results: [{ name: "good" }] });
      nativePort.__emitMessage({
        request_id: 2,
        error: "identity_locked",
        hint: "touch your key",
      });
      const results = messages.filter((m) => m.type === "result");
      expect(results.find((r) => r.index === 0).response.results[0].name).toBe(
        "good",
      );
      expect(results.find((r) => r.index === 1).response).toEqual({
        error: "identity_locked",
        hint: "touch your key",
      });
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

    it("query_multi_stream with an empty requests array emits `done` immediately without opening a native port", () => {
      const { messages } = openQueryStream(api, []);
      expect(messages).toEqual([{ type: "done" }]);
      expect(api.runtime.connectNative).not.toHaveBeenCalled();
    });

    it("query_multi_stream fans out N requests with sequential request_ids and emits one `result` per reply, paired by id back to the input index", () => {
      const { messages } = openQueryStream(api, [
        { domain: "a.test", store: "alpha" },
        { domain: "b.test", store: "beta" },
        { domain: "c.test", store: "gamma" },
      ]);
      const nativePort = lastConnectedPort(api);
      // Verify the actions plus monotonic request_ids on the native
      // side.
      expect(nativePort.postMessage.mock.calls.map(([msg]) => msg)).toEqual([
        { request_id: 1, action: "query", domain: "a.test", store: "alpha" },
        { request_id: 2, action: "query", domain: "b.test", store: "beta" },
        { request_id: 3, action: "query", domain: "c.test", store: "gamma" },
      ]);
      // Replies arrive in arbitrary order; each becomes a `result`
      // message addressed to the matching input index.
      nativePort.__emitMessage({ request_id: 2, results: [{ name: "beta-hit" }] });
      nativePort.__emitMessage({ request_id: 1, results: [{ name: "alpha-hit" }] });
      nativePort.__emitMessage({ request_id: 3, results: [{ name: "gamma-hit" }] });
      const results = messages.filter((m) => m.type === "result");
      expect(results).toHaveLength(3);
      const byIndex = Object.fromEntries(
        results.map((r) => [r.index, r.response]),
      );
      expect(byIndex[0].results[0].name).toBe("alpha-hit");
      expect(byIndex[1].results[0].name).toBe("beta-hit");
      expect(byIndex[2].results[0].name).toBe("gamma-hit");
      // request_id is stripped from each per-store payload.
      for (const r of results) {
        expect(r.response).not.toHaveProperty("request_id");
      }
      expect(messages.at(-1)).toEqual({ type: "done" });
      expect(nativePort.disconnect).toHaveBeenCalled();
    });

    it("query_multi_stream defaults `store` to null when caller omits it", () => {
      openQueryStream(api, [{ domain: "x.test" }]);
      const nativePort = lastConnectedPort(api);
      expect(nativePort.postMessage.mock.calls[0][0]).toEqual({
        request_id: 1,
        action: "query",
        domain: "x.test",
        store: null,
      });
    });

    it("query_multi_stream treats a native disconnect as transport_error for every still-pending slot", () => {
      const { messages } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
        { domain: "b.test", store: "b" },
        { domain: "c.test", store: "c" },
      ]);
      const nativePort = lastConnectedPort(api);
      // Only one reply lands before the native side disconnects.
      nativePort.__emitMessage({ request_id: 2, results: [{ name: "b" }] });
      api.runtime.lastError = { message: "host crashed" };
      nativePort.__emitDisconnect();
      const results = messages.filter((m) => m.type === "result");
      const byIndex = Object.fromEntries(
        results.map((r) => [r.index, r.response]),
      );
      expect(byIndex[0]).toEqual({
        error: "transport_error",
        hint: "host crashed",
      });
      expect(byIndex[1].results[0].name).toBe("b");
      expect(byIndex[2]).toEqual({
        error: "transport_error",
        hint: "host crashed",
      });
      expect(messages.at(-1)).toEqual({ type: "done" });
    });

    it("query_multi_stream disconnects with the fallback message when lastError is unset", () => {
      const { messages } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
      ]);
      const nativePort = lastConnectedPort(api);
      api.runtime.lastError = undefined;
      nativePort.__emitDisconnect();
      const result = messages.find((m) => m.type === "result");
      expect(result.response.hint).toBe(
        "native host disconnected before reply",
      );
    });

    it("query_multi_stream emits a top-level `error` and disconnects when a reply violates the size limits", () => {
      const { messages } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
      ]);
      const nativePort = lastConnectedPort(api);
      const huge = "x".repeat(64 * 1024 + 1);
      nativePort.__emitMessage({ request_id: 1, hint: huge });
      const error = messages.find((m) => m.type === "error");
      expect(error).toBeDefined();
      expect(error.error).toMatch(/longer than/);
      // Shape violations poison the whole stream — no `done`, just the
      // top-level error and a teardown of both ports. The background
      // closes the stream from its side (`backgroundPort.disconnect`);
      // the popup observes this through its onDisconnect listener
      // rather than via its own `.disconnect` spy.
      expect(nativePort.disconnect).toHaveBeenCalled();
      expect(
        api.__streamPairs.at(-1).backgroundPort.disconnect,
      ).toHaveBeenCalled();
    });

    it("query_multi_stream drops a reply whose request_id is not pending (out-of-band or repeated)", async () => {
      vi.useFakeTimers();
      const { messages } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
      ]);
      const nativePort = lastConnectedPort(api);
      // Wrong request_id — the backstop is the per-request timer.
      nativePort.__emitMessage({ request_id: 99, results: [] });
      // Also: non-integer.
      nativePort.__emitMessage({ request_id: "abc", results: [] });
      // Also: missing.
      nativePort.__emitMessage({ results: [] });
      // Also: not even an object.
      nativePort.__emitMessage(42);
      // Nothing has resolved the only pending slot yet. Advance time
      // to fire the per-request timeout.
      await vi.advanceTimersByTimeAsync(30_000);
      const results = messages.filter((m) => m.type === "result");
      expect(results).toHaveLength(1);
      expect(results[0].response.error).toBe("transport_error");
      expect(results[0].response.hint).toMatch(/request 1 did not get a response/);
    });

    it("query_multi_stream marks a single request transport_error when postMessage throws for it", () => {
      // First postMessage throws; second succeeds. The thrown call's
      // slot ends up as transport_error; the second resolves normally
      // when its reply arrives.
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
      const { messages } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
        { domain: "b.test", store: "b" },
      ]);
      const nativePort = lastConnectedPort(api);
      const onMessage = nativePort.onMessage.addListener.mock.calls[0][0];
      onMessage({ request_id: 2, results: [] });
      const byIndex = Object.fromEntries(
        messages
          .filter((m) => m.type === "result")
          .map((r) => [r.index, r.response]),
      );
      expect(byIndex[0]).toEqual({
        error: "transport_error",
        hint: "write failed",
      });
      expect(byIndex[1].results).toEqual([]);
    });

    it("query_multi_stream propagates a connectNative throw to the popup as a top-level error", () => {
      api.runtime.connectNative = vi.fn(() => {
        throw new Error("native messaging disabled");
      });
      const { messages } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
      ]);
      expect(messages.find((m) => m.type === "error")).toEqual({
        type: "error",
        error: "native messaging disabled",
      });
    });

    it("query_multi_stream surfaces a clean error when connectNative returns null", () => {
      api.runtime.connectNative = vi.fn(() => null);
      const { messages } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
      ]);
      expect(messages.find((m) => m.type === "error")).toEqual({
        type: "error",
        error: "native messaging port could not be opened",
      });
    });

    it("query_multi_stream rejects a malformed start message and disconnects", () => {
      const port = api.runtime.connect({ name: "query_multi_stream" });
      const messages = [];
      port.onMessage.addListener((msg) => messages.push(msg));
      // Send a message that isn't `{action: "start"}`.
      port.postMessage({ action: "fnord" });
      expect(messages).toEqual([
        {
          type: "error",
          error: "expected a `start` message with a requests array",
        },
      ]);
      // The background tears the stream down from its own side.
      expect(
        api.__streamPairs.at(-1).backgroundPort.disconnect,
      ).toHaveBeenCalled();
    });

    it("query_multi_stream silently ignores keepalive pings on a started port (review8 item H)", () => {
      const { messages } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
      ]);
      // The popup sends these periodically to reset Chromium's
      // service-worker idle deadline. They carry no protocol meaning
      // — the background must neither error nor re-dispatch.
      api.__streamPairs.at(-1).popupPort.postMessage({
        action: "keepalive",
      });
      expect(messages.filter((m) => m.type === "error")).toHaveLength(0);
      expect(api.runtime.connectNative).toHaveBeenCalledTimes(1);
      // The batch still settles normally afterwards.
      lastConnectedPort(api).__emitMessage({ request_id: 1, results: [] });
      expect(messages.at(-1)).toEqual({ type: "done" });
    });

    it("query_multi_stream ignores a second `start` message on the same port", () => {
      const { messages } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
      ]);
      const nativePort = lastConnectedPort(api);
      // Second start arrives on the same port — silently dropped.
      api.__streamPairs.at(-1).popupPort.postMessage({
        action: "start",
        requests: [{ domain: "another.test", store: "b" }],
      });
      // Only the first batch's native port was opened (one connectNative
      // call total).
      expect(api.runtime.connectNative).toHaveBeenCalledTimes(1);
      // First batch settles normally.
      nativePort.__emitMessage({ request_id: 1, results: [] });
      expect(messages.find((m) => m.type === "done")).toBeDefined();
    });

    it("query_multi_stream ignores ports opened with the wrong name (defence against future listeners)", () => {
      const port = api.runtime.connect({ name: "some_other_channel" });
      // No background listener should claim this port. Sending a start
      // message produces no replies, no native port opened.
      port.postMessage({ action: "start", requests: [{ domain: "a.test" }] });
      expect(api.runtime.connectNative).not.toHaveBeenCalled();
    });

    it("query_multi_stream tears down the native side when the popup port disconnects mid-flight", () => {
      const { port: popupPort } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
        { domain: "b.test", store: "b" },
      ]);
      const nativePort = lastConnectedPort(api);
      // Popup closes (e.g. user dismisses the popup) before any reply.
      popupPort.disconnect();
      expect(nativePort.disconnect).toHaveBeenCalled();
    });

    it("query_multi_stream silently drops native replies that arrive after the popup port disconnects", () => {
      const { messages, port: popupPort } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
      ]);
      const nativePort = lastConnectedPort(api);
      popupPort.disconnect();
      const before = messages.length;
      // A stale reply arriving after teardown must not crash and must
      // not surface to the popup.
      nativePort.__emitMessage({ request_id: 1, results: [] });
      expect(messages.length).toBe(before);
    });

    it("query_multi_stream without a requests array (non-array `requests` field) degenerates to an empty batch", () => {
      const port = api.runtime.connect({ name: "query_multi_stream" });
      const messages = [];
      port.onMessage.addListener((msg) => messages.push(msg));
      port.postMessage({ action: "start", requests: "broken" });
      expect(messages).toEqual([{ type: "done" }]);
      expect(api.runtime.connectNative).not.toHaveBeenCalled();
    });

    it("query_multi_stream tolerates port.disconnect() throwing on cleanup", () => {
      // Native port that throws when we tear it down on success. The
      // batch must still emit its `done` message — disconnect throws
      // are silently swallowed.
      const onMessageListeners = [];
      api.runtime.connectNative = vi.fn(() => {
        const port = {
          name: "wtf.metio.pasejo",
          onMessage: {
            addListener: vi.fn((l) => onMessageListeners.push(l)),
          },
          onDisconnect: { addListener: vi.fn() },
          postMessage: vi.fn(),
          disconnect: vi.fn(() => {
            throw new Error("port is already closed");
          }),
        };
        api.__ports.push(port);
        return port;
      });
      const { messages } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
      ]);
      const [onMessage] = onMessageListeners;
      onMessage({ request_id: 1, results: [] });
      expect(messages.at(-1)).toEqual({ type: "done" });
    });

    it("query_multi_stream tolerates streamPort.disconnect throwing on the malformed-start path", () => {
      // The malformed-start handler routes through `safeDisconnectPort`
      // which catches a throw from `disconnect`. Drive that branch
      // by handing the background an onConnect listener-fired port
      // whose `disconnect` throws.
      let messageListener;
      const streamPort = {
        name: "query_multi_stream",
        onMessage: {
          addListener: vi.fn((l) => {
            messageListener = l;
          }),
        },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(() => {
          throw new Error("already closed");
        }),
      };
      const [onConnect] = api.__onConnectListeners;
      onConnect(streamPort);
      // Malformed start → background posts `{type:"error"}` then
      // routes through safeDisconnectPort. The throw must not
      // propagate.
      expect(() => messageListener({ action: "fnord" })).not.toThrow();
      expect(streamPort.postMessage).toHaveBeenCalledWith({
        type: "error",
        error: "expected a `start` message with a requests array",
      });
      expect(streamPort.disconnect).toHaveBeenCalled();
    });

    it("query_multi_stream after the popup port disconnects: late native replies hit the `abandoned` guard and don't leak through safePostMessage", () => {
      // Popup disconnects mid-flight. The background marks the stream
      // `abandoned` and tears the native port down. If a malformed
      // native reply was already in flight, the listener's shape-
      // validation catch path routes through `safePostMessage` —
      // the `abandoned` guard there must drop the message rather
      // than try to postMessage on a port the popup has closed. The
      // second teardown call from that catch path also exercises
      // teardown's idempotent early-return.
      const { port: popupPort } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
      ]);
      const nativePort = lastConnectedPort(api);
      popupPort.disconnect();
      // The mock's port pair fires the background side's onDisconnect
      // listener, which sets `abandoned = true` and calls `teardown`.
      // A malformed reply now arriving still fires the message
      // listener (Chrome's real port can deliver messages that were
      // already in flight before the disconnect propagated).
      const huge = "x".repeat(64 * 1024 + 1);
      // No throw despite the catch path running with `abandoned=true`
      // and the inner teardown call being a second one.
      expect(() => nativePort.__emitMessage({ request_id: 1, hint: huge })).not.toThrow();
    });

    it("query_multi_stream tolerates streamPort.postMessage throwing (popup port already closed)", () => {
      // Empty `requests` triggers safePostMessage({type:"done"}). If
      // the popup port has already been torn down by the time we
      // get there, postMessage throws — and the catch in
      // safePostMessage swallows it so the background doesn't crash.
      let messageListener;
      const streamPort = {
        name: "query_multi_stream",
        onMessage: {
          addListener: vi.fn((l) => {
            messageListener = l;
          }),
        },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(() => {
          throw new Error("popup port already closed");
        }),
        disconnect: vi.fn(),
      };
      const [onConnect] = api.__onConnectListeners;
      onConnect(streamPort);
      expect(() =>
        messageListener({ action: "start", requests: [] }),
      ).not.toThrow();
      expect(streamPort.postMessage).toHaveBeenCalled();
    });

    it("query_multi_stream tolerates a duplicate reply for an already-settled request_id", () => {
      const { messages } = openQueryStream(api, [
        { domain: "a.test", store: "a" },
      ]);
      const nativePort = lastConnectedPort(api);
      nativePort.__emitMessage({ request_id: 1, results: [{ name: "first" }] });
      // Late duplicate — must be silently dropped, must not re-emit.
      nativePort.__emitMessage({ request_id: 1, results: [{ name: "second" }] });
      const results = messages.filter((m) => m.type === "result");
      expect(results).toHaveLength(1);
      expect(results[0].response.results[0].name).toBe("first");
      // And `done` arrives exactly once.
      expect(messages.filter((m) => m.type === "done")).toHaveLength(1);
    });

    it("query_multi_stream ignores a per-request timeout that fires after the slot has settled (review7 item A)", () => {
      // The race the `pending.has` guard inside `settle` exists to
      // catch: a per-request setTimeout callback can already be in
      // the browser's macrotask queue when the message-path calls
      // `clearTimeout`. The cancellation is too late — the queued
      // callback still runs. Without the guard, that stale callback
      // emits a second `result` for the same slot with a
      // `transport_error` payload, and the popup would render the
      // affected store as skipped even though it had returned
      // results.
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
        const { messages } = openQueryStream(api, [
          { domain: "a.test", store: "a" },
        ]);
        const nativePort = lastConnectedPort(api);
        nativePort.__emitMessage({
          request_id: 1,
          results: [{ name: "real" }],
        });
        // The slot is settled; the captured per-request timer would
        // be a no-op in a real browser if clearTimeout caught it in
        // time — but in the race it fires anyway.
        expect(capturedTimers).toHaveLength(1);
        capturedTimers[0]();
        // Exactly one `result` was emitted, carrying the real reply,
        // and the stale-timer's transport_error did NOT overwrite it.
        const results = messages.filter((m) => m.type === "result");
        expect(results).toHaveLength(1);
        expect(results[0].response).toEqual({ results: [{ name: "real" }] });
        expect(results[0].response.error).toBeUndefined();
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
