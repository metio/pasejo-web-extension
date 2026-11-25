// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRealTimers } from "./helpers/timers.js";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function wait(ms) {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

describe("trackRealTimers", () => {
  afterEach(() => {
    vi.useRealTimers();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  it("clears a timer still pending on release", async () => {
    const release = trackRealTimers();
    const callback = vi.fn();
    setTimeout(callback, 5);
    expect(release()).toBe(1);
    await wait(20);
    expect(callback).not.toHaveBeenCalled();
  });

  it("lets a timer fire before release and forgets it", async () => {
    const release = trackRealTimers();
    const callback = vi.fn();
    setTimeout(callback, 1, "arg");
    await wait(20);
    expect(callback).toHaveBeenCalledWith("arg");
    expect(release()).toBe(0);
  });

  it("forgets a timer the code cleared itself", () => {
    const release = trackRealTimers();
    const id = setTimeout(() => {}, 1000);
    clearTimeout(id);
    expect(release()).toBe(0);
  });

  it("restores the real functions on release", () => {
    const release = trackRealTimers();
    expect(globalThis.setTimeout).not.toBe(realSetTimeout);
    release();
    expect(globalThis.setTimeout).toBe(realSetTimeout);
    expect(globalThis.clearTimeout).toBe(realClearTimeout);
  });

  it("leaves timers under fake timers to the fake clock", () => {
    const release = trackRealTimers();
    vi.useFakeTimers();
    const callback = vi.fn();
    setTimeout(callback, 50);
    vi.useRealTimers();
    expect(release()).toBe(0);
  });
});
