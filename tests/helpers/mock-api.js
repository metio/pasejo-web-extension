// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { vi } from "vitest";

// Builds a fresh in-memory mock of the WebExtensions `chrome` /
// `browser` API surface that the extension touches. Each call returns a
// brand-new mock so tests don't share state. The returned object is
// intentionally hand-rolled (rather than driving real ports) so tests
// can step the event loop deterministically.
export function makeApiMock() {
  const onMessageListeners = [];
  const ports = [];
  return {
    runtime: {
      // Captured so tests can invoke the registered listener directly.
      onMessage: {
        addListener: vi.fn((listener) => onMessageListeners.push(listener)),
        listeners: onMessageListeners,
      },
      sendMessage: vi.fn(),
      connectNative: vi.fn((name) => {
        const port = makePortMock(name);
        ports.push(port);
        return port;
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
    webNavigation: {
      getAllFrames: vi.fn(),
    },
    // Inspection helpers (not on the real API surface).
    __ports: ports,
    __onMessageListeners: onMessageListeners,
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
