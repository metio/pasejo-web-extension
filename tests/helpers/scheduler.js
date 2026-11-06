// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { setImmediate as nextMacrotask } from "node:timers";

// Replaces the global timer functions with a queue that runs nothing on
// its own. A test fires exactly the timers it names (`fire`), so time
// passes only where a model step says it does. `tag()` is evaluated when
// a timer is armed and stored with it, to tell apart timers of the same
// delay.
export function installScheduler({ tag = () => null } = {}) {
  const saved = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const timers = new Map();
  let nextId = 1;
  const arm = (repeat) => (fn, ms = 0, ...args) => {
    const id = nextId++;
    timers.set(id, { fn, ms, args, repeat, tag: tag() });
    return id;
  };
  const clear = (id) => {
    timers.delete(id);
  };
  globalThis.setTimeout = arm(false);
  globalThis.setInterval = arm(true);
  globalThis.clearTimeout = clear;
  globalThis.clearInterval = clear;
  return {
    // Runs every armed timer `pred` accepts, in the order they were armed.
    // An interval stays armed; a timeout is removed before it runs.
    fire(pred) {
      const due = [...timers.entries()].filter(([, timer]) => pred(timer));
      for (const [id, timer] of due) {
        if (!timers.has(id)) {
          continue;
        }
        if (!timer.repeat) {
          timers.delete(id);
        }
        timer.fn(...timer.args);
      }
      return due.length;
    },
    pending() {
      return [...timers.values()];
    },
    restore() {
      Object.assign(globalThis, saved);
      timers.clear();
    },
  };
}

// Lets every promise chain the last event started run to completion. No
// code under test waits on a timer the scheduler would have to fire, so a
// few macrotask hops drain everything.
export async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => nextMacrotask(resolve));
  }
}
