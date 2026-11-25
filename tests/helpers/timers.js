// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

// Records every real timer the code under test schedules and clears the
// ones still pending on release. A timer that outlives its test fires
// after vitest has torn the DOM environment down, where `window` and
// `document` no longer exist, and fails the whole run with an unhandled
// error. Timers under `vi.useFakeTimers()` never reach the wrapper, so
// the clock of a fake-timer test stays untouched.
export function trackRealTimers(scope = globalThis) {
  const realSetTimeout = scope.setTimeout;
  const realClearTimeout = scope.clearTimeout;
  const pending = new Set();
  scope.setTimeout = function trackedSetTimeout(callback, delay, ...args) {
    const id = realSetTimeout.call(
      this,
      (...callbackArgs) => {
        pending.delete(id);
        callback(...callbackArgs);
      },
      delay,
      ...args,
    );
    pending.add(id);
    return id;
  };
  scope.clearTimeout = function trackedClearTimeout(id) {
    pending.delete(id);
    return realClearTimeout.call(this, id);
  };
  return function release() {
    for (const id of pending) {
      realClearTimeout.call(scope, id);
    }
    const cleared = pending.size;
    pending.clear();
    scope.setTimeout = realSetTimeout;
    scope.clearTimeout = realClearTimeout;
    return cleared;
  };
}
