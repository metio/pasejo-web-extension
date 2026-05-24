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
const { Copy: COPY_ACTION } = ACTION;

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

    let settled = false;
    const settle = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        port.disconnect();
      } catch (_) {
        // Already disconnected.
      }
      fn(value);
    };

    port.onMessage.addListener((message) => settle(resolve, message));
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

// The popup is the only caller; it sends typed requests and awaits the
// host's reply. Returning a Promise from the listener tells Firefox to
// keep the channel open; for Chromium we additionally return `true` so
// `sendResponse` stays usable until we call it.
api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    sendResponse({ error: "invalid message" });
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
        .catch((err) =>
          sendResponse({ ok: false, error: err?.message ?? String(err) }),
        );
      return true;
    }
    case "list_stores": {
      sendNativeRequest({ action: ACTION.ListStores })
        .then((response) => sendResponse({ ok: true, response }))
        .catch((err) =>
          sendResponse({ ok: false, error: err?.message ?? String(err) }),
        );
      return true;
    }
    case "copy": {
      sendNativeRequest({
        action: COPY_ACTION,
        store: message.store ?? null,
        path: message.path,
        what: message.what,
      })
        .then((response) => sendResponse({ ok: true, response }))
        .catch((err) =>
          sendResponse({ ok: false, error: err?.message ?? String(err) }),
        );
      return true;
    }
    default:
      sendResponse({ ok: false, error: `unknown message type: ${message.type}` });
      return false;
  }
});
