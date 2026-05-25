// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

// Chromium service workers do not load classic scripts from the
// manifest, so we pull the shared protocol module in explicitly. Firefox
// event pages list both files in `background.scripts` and `importScripts`
// is not defined there — fall back silently in that case.
try {
  if (typeof importScripts === "function") {
    importScripts("protocol.js");
  }
} catch (_) {
  // Firefox event page: protocol.js was loaded by the manifest already.
}

const { NATIVE_HOST, ACTION, api } = globalThis.PASEJO;

// Upper bound on how long we wait for a single host response before
// giving up. The host's slowest legitimate path is a pull hook that
// fetches from a remote (git pull, rclone, …); 30 s covers that for any
// reasonable network round-trip without leaving the popup hanging
// forever when the host is genuinely stuck (frozen compositor, runaway
// hook, etc.).
const NATIVE_TIMEOUT_MS = 30_000;

// Defensive bounds on the structure of host responses. The host is
// trusted (it's our own binary on the user's machine) but a buggy
// build, a corrupted store, or a host-binary version skew could still
// produce values that would freeze the popup if rendered as-is. These
// limits are generous compared to any plausible legitimate value:
// passwords/passphrases top out well below 8 KB, store rosters are at
// most a handful of entries, and the protocol is shallow. The string
// limit is measured in UTF-16 code units (what `String.prototype.length`
// returns), which slightly under-counts UTF-8 byte length — a few KB
// of slack on top of an already-generous 64K cap.
const MAX_STRING_LEN = 64 * 1024;
const MAX_ARRAY_LEN = 10_000;
const MAX_OBJECT_KEYS = 1024;
const MAX_DEPTH = 6;

/// Walks the host's reply enforcing the limits above. Throws on
/// violation so `sendNativeRequest`'s `.catch` branch reports it as a
/// transport error the popup can render. Cheaper than a JSON-schema
/// validator and tight enough for our flat protocol.
function validateResponseShape(value, depth) {
  if (depth > MAX_DEPTH) {
    throw new Error(`host response nests deeper than ${MAX_DEPTH} levels`);
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LEN) {
      throw new Error(
        `host response contains a string longer than ${MAX_STRING_LEN} code units`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LEN) {
      throw new Error(
        `host response contains an array longer than ${MAX_ARRAY_LEN} entries`,
      );
    }
    for (const item of value) {
      validateResponseShape(item, depth + 1);
    }
    return;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > MAX_OBJECT_KEYS) {
      throw new Error(
        `host response contains an object with more than ${MAX_OBJECT_KEYS} keys`,
      );
    }
    for (const key of keys) {
      validateResponseShape(value[key], depth + 1);
    }
  }
  // Numbers, booleans, null, undefined: nothing to bound.
}

// One-shot native request that connects, sends, awaits a single reply
// (or a disconnect), and tears down. Connecting per request keeps the
// host's lifetime tied to actual user activity — service workers in MV3
// are killed at unpredictable times, so a long-lived port would have to
// be re-opened anyway, and the host is cheap to spawn.
function sendNativeRequest(request) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = api.runtime.connectNative(NATIVE_HOST);
    } catch (err) {
      reject(err);
      return;
    }
    if (!port) {
      // The WebExtensions spec says `connectNative` returns a `Port` or
      // throws, but if a buggy browser ever returns null/undefined the
      // subsequent `port.onMessage` deref would surface a bare
      // TypeError to the popup ("Cannot read properties of null …") and
      // leave the response timer scheduled until it fires. Reject with
      // a self-describing message and bail before either happens.
      reject(new Error("native messaging port could not be opened"));
      return;
    }

    let settled = false;
    const settle = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch (_) {
        // Already disconnected.
      }
      fn(value);
    };

    const timer = setTimeout(() => {
      settle(
        reject,
        new Error(
          `pasejo browser host did not respond within ${NATIVE_TIMEOUT_MS / 1000}s`,
        ),
      );
    }, NATIVE_TIMEOUT_MS);

    port.onMessage.addListener((message) => {
      try {
        validateResponseShape(message, 0);
      } catch (err) {
        settle(reject, err);
        return;
      }
      settle(resolve, message);
    });
    port.onDisconnect.addListener(() => {
      const err = api.runtime.lastError;
      settle(
        reject,
        new Error(err?.message ?? "native host disconnected before reply"),
      );
    });

    try {
      port.postMessage(request);
    } catch (err) {
      settle(reject, err);
    }
  });
}

// Multi-store batch over a single connection. Opens one port, fans out
// every request with a unique `request_id`, collects responses out of
// order, and resolves once each request has either landed a reply or
// a per-request timeout has expired. The point is failure isolation:
// a YubiKey-blocked decrypt on store A holds back only its own
// response, while store B / C / D return immediately. Under the v1
// per-port model the same scenario blocked the popup for the full
// 30 s timeout AND lost every other store's results (the timeout
// killed the shared port).
//
// The returned `responses` array is aligned 1:1 with the `requests`
// argument: index i is either the host's reply for `requests[i]` or
// an error envelope `{ error, hint }` when that specific request timed
// out or the connection failed.
function sendNativeBatch(requests) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(requests) || requests.length === 0) {
      resolve([]);
      return;
    }

    let port;
    try {
      port = api.runtime.connectNative(NATIVE_HOST);
    } catch (err) {
      reject(err);
      return;
    }
    if (!port) {
      reject(new Error("native messaging port could not be opened"));
      return;
    }

    const responses = new Array(requests.length);
    const pending = new Set(requests.map((_, idx) => idx + 1));
    const timers = new Map();
    let teardownDone = false;

    const teardown = () => {
      if (teardownDone) {
        return;
      }
      teardownDone = true;
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      try {
        port.disconnect();
      } catch (_) {
        // Already disconnected.
      }
    };

    // Records a per-request outcome. Invariants the callers maintain:
    //   * `idx` always points at a still-pending slot — the message
    //     handler checks `pending.has` before calling; the disconnect
    //     handler iterates the *current* pending set; the per-request
    //     timer and the postMessage catch each fire exactly once per
    //     slot and the first one to fire is the one that holds the
    //     slot. Any second call for the same `idx` would be a bug,
    //     and we want the noise rather than a silent swallow.
    const finalize = (idx, payload) => {
      const requestId = idx + 1;
      pending.delete(requestId);
      responses[idx] = payload;
      const timer = timers.get(requestId);
      clearTimeout(timer);
      timers.delete(requestId);
      if (pending.size === 0) {
        teardown();
        resolve(responses);
      }
    };

    port.onMessage.addListener((message) => {
      try {
        validateResponseShape(message, 0);
      } catch (err) {
        // A malformed message poisons the whole batch: we can't trust
        // any subsequent reply on this port either.
        teardown();
        reject(err);
        return;
      }
      const requestId =
        message && typeof message === "object"
          ? Number(message.request_id)
          : Number.NaN;
      if (!Number.isInteger(requestId) || !pending.has(requestId)) {
        // Out-of-band reply (wrong id, repeat, or v1 host that doesn't
        // echo request_id). Drop it — the per-request timer is the
        // backstop.
        return;
      }
      const { request_id: _omit, ...payload } = message;
      finalize(requestId - 1, payload);
    });
    port.onDisconnect.addListener(() => {
      const err = api.runtime.lastError;
      const message = err?.message ?? "native host disconnected before reply";
      // Mark every still-pending request as transport-failed; resolve
      // with what we collected so far. The popup will surface those as
      // skipped stores.
      for (const id of [...pending]) {
        finalize(id - 1, { error: "transport_error", hint: message });
      }
      teardown();
      resolve(responses);
    });

    for (let i = 0; i < requests.length; i += 1) {
      const requestId = i + 1;
      const timer = setTimeout(() => {
        finalize(i, {
          error: "transport_error",
          hint: `request ${requestId} did not get a response within ${NATIVE_TIMEOUT_MS / 1000}s`,
        });
      }, NATIVE_TIMEOUT_MS);
      timers.set(requestId, timer);
      try {
        port.postMessage({ request_id: requestId, ...requests[i] });
      } catch (err) {
        // postMessage failed for one request; record it as failed and
        // keep going. Most plausibly the port is already dead, in
        // which case the onDisconnect handler will tidy up the rest.
        finalize(i, {
          error: "transport_error",
          hint: err.message,
        });
      }
    }
  });
}

// The popup is the only caller; it sends typed requests and awaits the
// host's reply. Returning a Promise from the listener tells Firefox to
// keep the channel open; for Chromium we additionally return `true` so
// `sendResponse` stays usable until we call it.
api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    sendResponse({ ok: false, error: "invalid message" });
    return false;
  }

  switch (message.type) {
    case "query": {
      sendNativeRequest({
        action: ACTION.Query,
        domain: message.domain,
        store: message.store ?? null,
      })
        .then((response) => sendResponse({ ok: true, response }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    case "list_stores": {
      sendNativeRequest({ action: ACTION.ListStores })
        .then((response) => sendResponse({ ok: true, response }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    case "query_multi": {
      // The popup constructs one entry per store and the background
      // fans them all out over a single native connection. Each entry
      // is a `query` request payload; the background adds `request_id`.
      const requests = (message.requests ?? []).map((r) => ({
        action: ACTION.Query,
        domain: r.domain,
        store: r.store ?? null,
      }));
      sendNativeBatch(requests)
        .then((responses) => sendResponse({ ok: true, responses }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    default:
      sendResponse({ ok: false, error: `unknown message type: ${message.type}` });
      return false;
  }
});
