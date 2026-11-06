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
// Maximum nesting depth (inclusive) at which a value is still
// accepted. The outermost reply is depth 0; each nested object /
// array adds one. The reject fires when an attempt to enter depth
// `MAX_DEPTH + 1` is made. Matches the inclusive `> N` rejection
// shape used by the size constants above so all four limits read
// the same way: "anything larger than this is invalid". 6 covers
// `ResponseEnvelope` → payload → field (e.g. `stores`) → entry
// object → field value with headroom.
const MAX_DEPTH = 6;

// Walks the host's reply enforcing the size/depth limits above —
// purely structural, no per-action type knowledge. Throws on violation
// so the caller can convert that into a transport-error reply.
// Pairs with `validateResponseAgainstAction` below: this guard caps the
// blast radius of a pathological payload (oversized arrays, deep
// nesting); the per-action guard pins each field's type to the schema
// the popup expects. Cheaper than a JSON-schema validator and tight
// enough for our flat protocol.
function validateResponseShape(value, depth) {
  if (depth > MAX_DEPTH) {
    throw new Error(
      `host response exceeds maximum nesting depth of ${MAX_DEPTH}`,
    );
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

// Per-action validator table. Each entry takes the
// already-shape-validated response and throws on a type that doesn't
// match its action's contract. Lookup-by-action keeps the validator
// closed over the schema of its own action rather than spreading
// schema knowledge through a long if/else ladder, and gives us a
// single place to add a new action's validator the day a new action
// ships.
const ACTION_VALIDATORS = {
  [ACTION.ListStores](response) {
    if (
      response.protocol_version !== undefined &&
      typeof response.protocol_version !== "number"
    ) {
      throw new Error("`protocol_version` is not a number");
    }
    if (response.stores !== undefined && !Array.isArray(response.stores)) {
      throw new Error("`stores` is not an array");
    }
  },
  [ACTION.Query](response) {
    if (response.results !== undefined && !Array.isArray(response.results)) {
      throw new Error("`results` is not an array");
    }
    // Present only when nothing matched: the stored domains the queried
    // one resembles, which the popup names in its warning.
    if (
      response.lookalikes !== undefined &&
      !(
        Array.isArray(response.lookalikes) &&
        response.lookalikes.every((domain) => typeof domain === "string")
      )
    ) {
      throw new Error("`lookalikes` is not an array of strings");
    }
  },
  // A reveal is the one reply that carries a password, so it is the one
  // reply whose credential the popup must be able to fill as-is.
  [ACTION.Reveal](response) {
    const credential = response.credential;
    if (
      !credential ||
      typeof credential !== "object" ||
      Array.isArray(credential)
    ) {
      throw new Error("`credential` is not an object");
    }
    for (const field of ["name", "store", "username", "password"]) {
      if (typeof credential[field] !== "string") {
        throw new Error(`\`credential.${field}\` is not a string`);
      }
    }
    if (credential.otp !== undefined && typeof credential.otp !== "string") {
      throw new Error("`credential.otp` is not a string");
    }
  },
};

// Enforces the per-action response schema at the IPC boundary so the
// popup never has to defend against a host that returns the right
// fields with the wrong types. An error-shaped reply
// (`{error: "..."}`) is accepted regardless of action because the
// host can reply with an error to any request and that path is
// handled by the popup's `renderHostError`. Unknown action tokens
// fall through unchecked — the dispatch surface above is the
// trust boundary: every callsite uses an `ACTION.*` literal that has
// a validator below, so an action without a registered
// validator can only appear after a deliberate code change that
// will surface in review. The popup keeps its own `Array.isArray`
// guards as belt-and-braces; they're effectively unreachable when
// this validator runs, but they protect against a future code path
// that ever reaches the popup without going through here.
function validateResponseAgainstAction(actionToken, response) {
  if (!response || typeof response !== "object") {
    throw new Error("host reply is not an object");
  }
  if (typeof response.error === "string") {
    // Error envelopes have their own contract; the popup's
    // `renderHostError` reads `error` and `hint`. No further field
    // checks here — let the popup tolerate (or ignore) any extra
    // fields the host attached.
    return;
  }
  const validator = ACTION_VALIDATORS[actionToken];
  if (validator) {
    validator(response);
  }
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
        // Shape violation (oversized strings/arrays, deep nesting):
        // the reply is pathological enough that we'd rather report
        // it as a transport error than try to render the contents.
        settle(reject, err);
        return;
      }
      try {
        validateResponseAgainstAction(request.action, message);
      } catch (err) {
        // The reply is well-sized but the field types are wrong for
        // the action that was sent. Synthesize a host-error envelope
        // so the popup renders the user-friendly decode-error copy
        // it already shows for host-reported decode failures, rather
        // than the transport-error fallback.
        settle(resolve, { error: "decode_error", hint: err.message });
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

// Streams a multi-store batch over a single native connection. Opens
// one native port, fans out every request with a unique
// `request_id`, and pushes each reply back to the popup-facing
// `streamPort` as a `{type:"result", index, response}` message AS
// SOON AS that store's reply lands. When every slot has settled
// (real reply, decode failure, per-request timeout, or
// disconnect-induced transport error) emits a final
// `{type:"done"}` and disconnects the native side.
//
// The point of the streaming API (rather than the previous
// resolve-with-array model) is user-perceived latency: the popup
// can render each store's matches as they arrive instead of
// awaiting the slowest store's 30-second timeout. A user with four
// fast stores and one YubiKey-blocked store sees the four fast
// results land in the popup within their natural latency, while
// the YubiKey slot stays "searching" with a visible progress
// counter until the user touches the key or the timer fires.
//
// `streamPort` is the runtime.connect port that the popup opened;
// its onDisconnect fires when the popup window closes, which is
// the signal to tear the native port down and abandon any
// still-pending requests. Without this the native host process
// (and any YubiKey prompt it triggered) would outlive the popup.
// Best-effort `port.disconnect()` wrapper. Both the onConnect's
// malformed-start path and every bail inside `streamNativeBatch`
// route through here so the "port is already gone" case (which can
// throw on real Chrome) is handled in exactly one place.
function safeDisconnectPort(port) {
  try {
    port.disconnect();
  } catch (_) {
    // Already disconnected.
  }
}

function streamNativeBatch(streamPort, requests) {
  let abandoned = false;
  const safePostMessage = (message) => {
    if (abandoned) {
      return;
    }
    try {
      streamPort.postMessage(message);
    } catch (_) {
      // Popup port already disconnected — fall through to teardown
      // via the onDisconnect handler.
    }
  };
  const safeDisconnect = () => safeDisconnectPort(streamPort);

  if (!Array.isArray(requests) || requests.length === 0) {
    safePostMessage({ type: "done" });
    safeDisconnect();
    return;
  }

  let nativePort;
  try {
    nativePort = api.runtime.connectNative(NATIVE_HOST);
  } catch (err) {
    safePostMessage({ type: "error", error: err.message });
    safeDisconnect();
    return;
  }
  if (!nativePort) {
    safePostMessage({
      type: "error",
      error: "native messaging port could not be opened",
    });
    safeDisconnect();
    return;
  }

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
      nativePort.disconnect();
    } catch (_) {
      // Already disconnected.
    }
  };

  // Records a per-request outcome and pushes it to the popup. The
  // first `pending.has` check is load-bearing — it guards against
  // the per-request timer's callback firing AFTER the slot has
  // already been settled by a real reply (clearTimeout doesn't
  // cancel a callback that's already in the macrotask queue, so
  // the message path and the timer path can race). Same backstop
  // the previous batch implementation had; carried forward because
  // it still applies under the streaming model.
  const settle = (idx, payload) => {
    if (abandoned) {
      return;
    }
    const requestId = idx + 1;
    if (!pending.has(requestId)) {
      return;
    }
    pending.delete(requestId);
    const timer = timers.get(requestId);
    clearTimeout(timer);
    timers.delete(requestId);
    safePostMessage({ type: "result", index: idx, response: payload });
    if (pending.size === 0) {
      teardown();
      safePostMessage({ type: "done" });
      safeDisconnect();
    }
  };

  nativePort.onMessage.addListener((message) => {
    try {
      validateResponseShape(message, 0);
    } catch (err) {
      // A malformed message poisons the whole batch: we can't trust
      // any subsequent reply on this port either. Tell the popup
      // and tear everything down.
      teardown();
      safePostMessage({ type: "error", error: err.message });
      safeDisconnect();
      return;
    }
    const requestId =
      message && typeof message === "object"
        ? Number(message.request_id)
        : Number.NaN;
    if (!Number.isInteger(requestId) || !pending.has(requestId)) {
      // Out-of-band reply: a duplicate, a host that failed to echo
      // `request_id` (a contract violation — every reply must carry
      // the id from its corresponding request), or an id we never
      // sent. Drop it; the per-request timer is the backstop that
      // settles the still-pending slot.
      return;
    }
    const { request_id: _omit, ...payload } = message;
    try {
      validateResponseAgainstAction(requests[requestId - 1].action, payload);
    } catch (err) {
      // Per-slot decode failure: synthesize the same host-error
      // envelope `sendNativeRequest` does, but scoped to just this
      // request. The rest of the batch is unaffected — a misbehaving
      // store doesn't poison its siblings, and the popup renders
      // the decode-error copy for the affected slot the same way it
      // would for a host-reported decode failure.
      settle(requestId - 1, {
        error: "decode_error",
        hint: err.message,
      });
      return;
    }
    settle(requestId - 1, payload);
  });
  nativePort.onDisconnect.addListener(() => {
    const err = api.runtime.lastError;
    const reason = err?.message ?? "native host disconnected before reply";
    // Mark every still-pending request as transport-failed and
    // close the popup port. The popup will surface those as
    // skipped stores.
    for (const id of [...pending]) {
      settle(id - 1, { error: "transport_error", hint: reason });
    }
  });

  // Popup-side disconnect: the user closed the popup or navigated
  // away. Tear down the native port (and with it any in-flight
  // YubiKey prompt) so the host process can exit; further replies
  // from the native side land in a disconnected port and are
  // silently dropped.
  streamPort.onDisconnect.addListener(() => {
    abandoned = true;
    teardown();
  });

  for (let i = 0; i < requests.length; i += 1) {
    const requestId = i + 1;
    const timer = setTimeout(() => {
      settle(i, {
        error: "transport_error",
        hint: `request ${requestId} did not get a response within ${NATIVE_TIMEOUT_MS / 1000}s`,
      });
    }, NATIVE_TIMEOUT_MS);
    timers.set(requestId, timer);
    try {
      nativePort.postMessage({ request_id: requestId, ...requests[i] });
    } catch (err) {
      // postMessage failed for one request; record it as failed and
      // keep going. Most plausibly the port is already dead, in
      // which case the onDisconnect handler will tidy up the rest.
      settle(i, {
        error: "transport_error",
        hint: err.message,
      });
    }
  }
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
    case "reveal": {
      // Only the three fields the host re-checks are forwarded: the host
      // releases the credential when `name` in `store` matches `domain`.
      sendNativeRequest({
        action: ACTION.Reveal,
        store: message.store,
        name: message.name,
        domain: message.domain,
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
    default:
      sendResponse({ ok: false, error: `unknown message type: ${message.type}` });
      return false;
  }
});

// Multi-store queries use a long-lived port instead of `sendMessage`
// so the background can stream each store's reply to the popup as
// it lands, rather than buffering N replies until the slowest one
// resolves. The popup opens the port via
// `runtime.connect({ name: "query_multi_stream" })` and sends one
// `{action:"start", requests:[...]}` message; the background then
// pushes a `{type:"result", index, response}` per reply and a final
// `{type:"done"}` once every slot has settled. Closing the popup
// disconnects the port, which signals the background to tear the
// native side down so the host process can exit even if a YubiKey
// prompt was in flight.
const STREAM_PORT_NAME = "query_multi_stream";

api.runtime.onConnect.addListener((streamPort) => {
  if (streamPort.name !== STREAM_PORT_NAME) {
    // Ports we didn't open belong to other listeners (today there are
    // none). Ignore silently so we don't claim a name we don't own.
    return;
  }
  let started = false;
  streamPort.onMessage.addListener((message) => {
    if (started) {
      // Post-`start` traffic is dropped. This covers two cases: the
      // popup's periodic `{action:"keepalive"}` pings (sent purely to
      // reset Chromium's service-worker idle deadline — receiving the
      // message IS the desired effect), and a buggy second `start`,
      // which must not re-arm the fan-out and double-spawn the
      // native host.
      return;
    }
    if (!message || typeof message !== "object" || message.action !== "start") {
      streamPort.postMessage({
        type: "error",
        error: "expected a `start` message with a requests array",
      });
      safeDisconnectPort(streamPort);
      return;
    }
    started = true;
    const requests = (Array.isArray(message.requests) ? message.requests : [])
      .map((r) => ({
        action: ACTION.Query,
        domain: r.domain,
        store: r.store ?? null,
      }));
    streamNativeBatch(streamPort, requests);
  });
});
