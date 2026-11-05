// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { vi } from "vitest";

// The real English message catalog backs the mock's `i18n.getMessage`, so
// tests assert the same strings the extension ships and stay in lockstep
// with `_locales/en/messages.json` automatically. Vite resolves the JSON
// import to the parsed object.
import EN_MESSAGES from "../../src/_locales/en/messages.json";

// Faithful re-implementation of `chrome.i18n.getMessage`: resolves named
// `$PLACEHOLDER$` tokens against the entry's `placeholders` table, whose
// `content` (`$1`, `$2`, …) indexes into the caller's substitution array.
// Unknown keys return "" like the real API.
function getMessage(key, substitutions) {
  const entry = EN_MESSAGES[key];
  if (!entry) {
    return "";
  }
  const subs =
    substitutions == null
      ? []
      : Array.isArray(substitutions)
        ? substitutions
        : [substitutions];
  const placeholders = entry.placeholders ?? {};
  return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (match, name) => {
    const placeholder = placeholders[name.toLowerCase()];
    if (!placeholder) {
      return match;
    }
    return placeholder.content.replace(
      /\$(\d)/g,
      (_, digit) => subs[Number(digit) - 1] ?? "",
    );
  });
}

// Builds a fresh in-memory mock of the WebExtensions `chrome` /
// `browser` API surface that the extension touches. Each call returns a
// brand-new mock so tests don't share state. The returned object is
// intentionally hand-rolled (rather than driving real ports) so tests
// can step the event loop deterministically.
export function makeApiMock() {
  const onMessageListeners = [];
  const onConnectListeners = [];
  const ports = [];
  // Pairs created by `runtime.connect`: each entry holds the popup-
  // side port and the background-side port so a test can drive either
  // end (`__streamPairs.at(-1).popupPort.__emitMessage(...)` or
  // `.backgroundPort.postMessage(...)`).
  const streamPairs = [];
  return {
    runtime: {
      // Captured so tests can invoke the registered listener directly.
      onMessage: {
        addListener: vi.fn((listener) => onMessageListeners.push(listener)),
        listeners: onMessageListeners,
      },
      onConnect: {
        addListener: vi.fn((listener) => onConnectListeners.push(listener)),
        listeners: onConnectListeners,
      },
      sendMessage: vi.fn(),
      connectNative: vi.fn((name) => {
        const port = makePortMock(name);
        ports.push(port);
        return port;
      }),
      // Popup-side counterpart to `connectNative`: opens a paired port
      // and synchronously fires every registered `onConnect` listener
      // with the background-facing half. The returned port is the
      // popup-facing half.
      connect: vi.fn((options = {}) => {
        const pair = makePortPair(options.name);
        streamPairs.push(pair);
        for (const listener of onConnectListeners) {
          listener(pair.backgroundPort);
        }
        return pair.popupPort;
      }),
      lastError: undefined,
    },
    tabs: {
      query: vi.fn(),
      sendMessage: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(),
        set: vi.fn(),
        remove: vi.fn(),
      },
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([]),
    },
    i18n: {
      getMessage: vi.fn(getMessage),
    },
    // Inspection helpers (not on the real API surface).
    __ports: ports,
    __onMessageListeners: onMessageListeners,
    __onConnectListeners: onConnectListeners,
    __streamPairs: streamPairs,
    // Content-script side of `runtime.connect`: opens a paired port whose
    // extension-facing half carries `sender` (as the browser stamps it),
    // fires every `onConnect` listener with that half, and returns the
    // content-facing half.
    __connectFromContent(name, sender) {
      const pair = makePortPair(name);
      pair.backgroundPort.sender = sender;
      streamPairs.push(pair);
      for (const listener of onConnectListeners) {
        listener(pair.backgroundPort);
      }
      return pair.popupPort;
    },
  };
}

// Native-messaging Port stand-in. Captures the listeners the host code
// registers so tests can emit messages and disconnects on demand.
export function makePortMock(name = "wtf.metio.pasejo") {
  const onMessageListeners = [];
  const onDisconnectListeners = [];
  return {
    name,
    onMessage: {
      addListener: vi.fn((l) => onMessageListeners.push(l)),
    },
    onDisconnect: {
      addListener: vi.fn((l) => onDisconnectListeners.push(l)),
    },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    __emitMessage(message) {
      for (const l of onMessageListeners) {
        l(message);
      }
    },
    __emitDisconnect() {
      for (const l of onDisconnectListeners) {
        l();
      }
    },
  };
}

// Returns the popup-facing and background-facing halves of a paired
// extension port. `postMessage` on one delivers to the other's
// `onMessage` listeners; `disconnect` on either side fires the
// other's `onDisconnect` listeners. Mirrors the real
// `runtime.connect` contract closely enough for the streaming
// query path to be testable end-to-end.
function makePortPair(name = "") {
  const popupListeners = { message: [], disconnect: [] };
  const backgroundListeners = { message: [], disconnect: [] };
  let disconnected = false;

  const makeSide = (mineListeners, peerListeners, peer) => ({
    name,
    onMessage: {
      addListener: vi.fn((l) => mineListeners.message.push(l)),
    },
    onDisconnect: {
      addListener: vi.fn((l) => mineListeners.disconnect.push(l)),
    },
    postMessage: vi.fn((message) => {
      if (disconnected) {
        return;
      }
      for (const l of peerListeners.message) {
        l(message);
      }
    }),
    disconnect: vi.fn(() => {
      if (disconnected) {
        return;
      }
      disconnected = true;
      for (const l of peerListeners.disconnect) {
        l(peer);
      }
    }),
    // Test-only emitters mirror the native-port mock's API surface
    // so tests can synthesise messages or disconnects without going
    // through the paired side.
    __emitMessage(message) {
      for (const l of mineListeners.message) {
        l(message);
      }
    },
    __emitDisconnect() {
      if (disconnected) {
        return;
      }
      disconnected = true;
      for (const l of mineListeners.disconnect) {
        l();
      }
    },
  });

  const popupPort = makeSide(popupListeners, backgroundListeners, null);
  const backgroundPort = makeSide(backgroundListeners, popupListeners, null);
  return { popupPort, backgroundPort };
}

// Convenience: invokes the listener that `background.js` registered
// on the popup→background channel and returns the response synchronously
// when the listener decides not to defer, or the Promise of the response
// when the listener returns `true` (asks the channel to stay open).
export function invokeBackgroundListener(api, message) {
  const [listener] = api.__onMessageListeners;
  if (!listener) {
    throw new Error("background listener was never registered");
  }
  return new Promise((resolve) => {
    const kept = listener(message, { id: "test" }, resolve);
    if (kept !== true) {
      // Listener replied synchronously through `sendResponse`; in that
      // case `resolve` has already been invoked.
    }
  });
}
