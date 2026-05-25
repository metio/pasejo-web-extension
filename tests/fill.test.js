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
import { makeApiMock } from "./helpers/mock-api.js";

// fill.js is wrapped in an IIFE — every helper inside is module-private
// once the content script registers its message listener. Tests
// therefore drive the public surface (the runtime.onMessage listener)
// and assert on (a) the DOM mutations the fill applied and (b) the
// `sendResponse` payload the listener emitted.

function callListener(api, message) {
  const [listener] = api.__onMessageListeners;
  if (!listener) {
    throw new Error("fill.js never registered a message listener");
  }
  return new Promise((resolve) => {
    let replied = false;
    const sendResponse = (value) => {
      replied = true;
      resolve(value);
    };
    const kept = listener(message, { id: "test" }, sendResponse);
    if (!replied && !kept) {
      // Early-return listener that decided not to handle the message
      // (e.g. non-fill type) — no reply, channel not kept open.
      resolve(undefined);
    }
  });
}

// Force a non-zero bounding rect and a "visible" computed style so
// `isInteractable` accepts the element. happy-dom otherwise gives every
// detached and freshly-attached element a 0×0 rect, which the picker
// reads as "not interactable" and ignores. Optionally supplies the
// rect's top/left so visibility-score tests can place inputs inside or
// outside the viewport deliberately.
function makeVisibleInput(
  type,
  { props = {}, rect = {}, attached = true } = {},
) {
  const input = document.createElement("input");
  input.type = type;
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("attr:")) {
      input.setAttribute(k.slice(5), v);
    } else {
      input[k] = v;
    }
  }
  if (attached) {
    document.body.appendChild(input);
  }
  stubRect(input, rect);
  return input;
}

function stubRect(el, rect = {}) {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({
      width: 200,
      height: 30,
      top: 0,
      left: 0,
      right: 200,
      bottom: 30,
      ...rect,
    }),
    configurable: true,
  });
  return el;
}

// Attach an open (default) or closed shadow root to a fresh host
// inserted into document.body, and place an input of the given type
// inside it. Returns the host, shadow root, and the input itself so
// tests can assert on each.
function attachShadowInput(
  type,
  { mode = "open", props = {}, rect = {} } = {},
) {
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode });
  const input = document.createElement("input");
  input.type = type;
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("attr:")) {
      input.setAttribute(k.slice(5), v);
    } else {
      input[k] = v;
    }
  }
  shadow.appendChild(input);
  document.body.appendChild(host);
  stubRect(input, rect);
  return { host, shadow, input };
}

describe("fill.js content script", () => {
  let api;

  beforeEach(() => {
    delete globalThis.browser;
    delete globalThis.chrome;
    api = makeApiMock();
    globalThis.chrome = api;
    document.body.innerHTML = "";
    loadClassicScript("src/content/fill.js");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete globalThis.browser;
    delete globalThis.chrome;
    document.body.innerHTML = "";
  });

  describe("listener wiring", () => {
    it("registers exactly one runtime.onMessage listener on load", () => {
      expect(api.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    });

    it("ignores messages without a recognised type", async () => {
      const reply = await callListener(api, { type: "other" });
      expect(reply).toBeUndefined();
    });

    it("ignores null messages", async () => {
      const reply = await callListener(api, null);
      expect(reply).toBeUndefined();
    });
  });

  describe("probe-focus (item T)", () => {
    // happy-dom's `document.hasFocus()` default varies across versions;
    // we stub it explicitly so each test exercises the contract
    // deterministically rather than relying on the engine's defaults.

    it("reports `focused: true` when document.hasFocus() is true", async () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const reply = await callListener(api, { type: "probe-focus" });
      expect(reply).toEqual({ ok: true, focused: true });
    });

    it("reports `focused: false` when document.hasFocus() is false", async () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      const reply = await callListener(api, { type: "probe-focus" });
      expect(reply).toEqual({ ok: true, focused: false });
    });

    it("does not mutate the DOM (probe is read-only)", async () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const password = makeVisibleInput("password");
      const observer = vi.fn();
      password.addEventListener("input", observer);
      password.addEventListener("change", observer);
      await callListener(api, { type: "probe-focus" });
      expect(observer).not.toHaveBeenCalled();
      expect(password.value).toBe("");
    });
  });

  describe("listener wiring (defensive)", () => {
    it("does not throw when loaded without a WebExtensions API on globalThis", () => {
      // Wipe out both globals so the `globalThis.browser ?? globalThis.chrome`
      // resolution yields undefined and fill.js hits its early `return`.
      delete globalThis.browser;
      delete globalThis.chrome;
      expect(() => loadClassicScript("src/content/fill.js")).not.toThrow();
    });
  });

  describe("simple fill", () => {
    it("fills a username and password input under the same form", async () => {
      document.body.innerHTML = "<form id='f'></form>";
      const form = document.getElementById("f");
      const username = makeVisibleInput("text", {
        props: { id: "user" },
        attached: false,
      });
      form.appendChild(username);
      const password = makeVisibleInput("password", { attached: false });
      form.appendChild(password);

      const reply = await callListener(api, {
        type: "fill",
        username: "alice",
        password: "hunter2",
      });
      expect(reply).toEqual({
        ok: true,
        filled: { username: true, password: true },
      });
      expect(username.value).toBe("alice");
      expect(password.value).toBe("hunter2");
    });

    it("fills only the password when no username was supplied", async () => {
      makeVisibleInput("text", { props: { id: "u" } });
      const password = makeVisibleInput("password");

      const reply = await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(reply.filled).toEqual({ username: false, password: true });
      expect(password.value).toBe("hunter2");
    });

    it("fills only the username when no password was supplied", async () => {
      const username = makeVisibleInput("text", {
        props: { id: "u", name: "username" },
      });
      makeVisibleInput("password");

      const reply = await callListener(api, {
        type: "fill",
        username: "alice",
      });
      expect(reply.filled.username).toBe(true);
      expect(username.value).toBe("alice");
    });
  });

  describe("partial fill (multi-step login)", () => {
    it("returns password:false when only a username input exists and a username was supplied", async () => {
      const email = makeVisibleInput("email", {
        props: { id: "email", name: "email" },
      });
      const reply = await callListener(api, {
        type: "fill",
        username: "alice@example.com",
        password: "hunter2",
      });
      expect(reply.ok).toBe(true);
      expect(reply.filled).toEqual({ username: true, password: false });
      expect(email.value).toBe("alice@example.com");
    });

    it("throws when the page has neither a password nor a username input", async () => {
      const reply = await callListener(api, {
        type: "fill",
        username: "alice",
        password: "hunter2",
      });
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/No password input found/);
    });

    it("throws when there is no password input AND no username was supplied", async () => {
      makeVisibleInput("text", { props: { id: "u", name: "username" } });
      const reply = await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      // No password input on page; username arg was empty so partial-fill
      // can't help.
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/No password input found/);
    });
  });

  describe("findPasswordInput ranking", () => {
    it("prefers the currently focused password input", async () => {
      const pwdA = makeVisibleInput("password", {
        rect: { top: 1000, bottom: 1030 },
      });
      const pwdB = makeVisibleInput("password", {
        rect: { top: 10, bottom: 40 },
      });
      pwdA.focus();
      const reply = await callListener(api, {
        type: "fill",
        password: "p",
      });
      expect(reply.filled.password).toBe(true);
      expect(pwdA.value).toBe("p");
      expect(pwdB.value).toBe("");
    });

    it("falls back to viewport-visibility ranking when nothing is focused", async () => {
      const offscreen = makeVisibleInput("password", {
        rect: { top: 2000, bottom: 2030, left: 0, right: 200 },
      });
      const visible = makeVisibleInput("password", {
        rect: { top: 10, bottom: 40, left: 0, right: 200 },
      });
      const reply = await callListener(api, {
        type: "fill",
        password: "p",
      });
      expect(reply.ok).toBe(true);
      expect(visible.value).toBe("p");
      expect(offscreen.value).toBe("");
    });
  });

  describe("findUsernameInputFor", () => {
    it("skips disabled, readonly, and hidden inputs when looking for a username", async () => {
      document.body.innerHTML = "<form id='f'></form>";
      const form = document.getElementById("f");

      const disabled = makeVisibleInput("text", {
        props: { id: "d", name: "username", disabled: true },
        attached: false,
      });
      form.appendChild(disabled);
      const readonly = makeVisibleInput("text", {
        props: { id: "r", name: "username", readOnly: true },
        attached: false,
      });
      form.appendChild(readonly);
      const hidden = makeVisibleInput("hidden", {
        props: { id: "h", name: "username" },
        attached: false,
      });
      form.appendChild(hidden);
      const good = makeVisibleInput("text", {
        props: { id: "g", name: "username" },
        attached: false,
      });
      form.appendChild(good);
      const password = makeVisibleInput("password", { attached: false });
      form.appendChild(password);

      await callListener(api, {
        type: "fill",
        username: "alice",
        password: "p",
      });
      expect(good.value).toBe("alice");
      expect(disabled.value).toBe("");
      expect(readonly.value).toBe("");
      expect(hidden.value).toBe("");
    });

    it("uses document.querySelectorAll when the password input has no enclosing form", async () => {
      const username = makeVisibleInput("text", {
        props: { id: "u", name: "username" },
      });
      const password = makeVisibleInput("password");

      await callListener(api, {
        type: "fill",
        username: "alice",
        password: "p",
      });
      expect(username.value).toBe("alice");
      expect(password.value).toBe("p");
    });

    it("picks the closest preceding username candidate when several precede the password", async () => {
      document.body.innerHTML = "<form id='f'></form>";
      const form = document.getElementById("f");
      const early = makeVisibleInput("text", {
        props: { id: "e", name: "username" },
        attached: false,
      });
      form.appendChild(early);
      const late = makeVisibleInput("text", {
        props: { id: "l", name: "username" },
        attached: false,
      });
      form.appendChild(late);
      const password = makeVisibleInput("password", { attached: false });
      form.appendChild(password);

      await callListener(api, {
        type: "fill",
        username: "alice",
        password: "p",
      });
      expect(late.value).toBe("alice");
      expect(early.value).toBe("");
    });

    it("falls back to the first candidate when no username field precedes the password", async () => {
      document.body.innerHTML = "<form id='f'></form>";
      const form = document.getElementById("f");
      const password = makeVisibleInput("password", { attached: false });
      form.appendChild(password);
      const after = makeVisibleInput("text", {
        props: { id: "u", name: "username" },
        attached: false,
      });
      form.appendChild(after);

      await callListener(api, {
        type: "fill",
        username: "alice",
        password: "p",
      });
      expect(after.value).toBe("alice");
    });

    it("returns null username when no candidate is found (only fills password)", async () => {
      document.body.innerHTML = "<form id='f'></form>";
      const form = document.getElementById("f");
      const password = makeVisibleInput("password", { attached: false });
      form.appendChild(password);
      const reply = await callListener(api, {
        type: "fill",
        username: "alice",
        password: "p",
      });
      expect(reply.filled).toEqual({ username: false, password: true });
      expect(password.value).toBe("p");
    });
  });

  describe("findStandaloneUsernameInput (partial-fill path)", () => {
    it("prefers the currently focused username candidate", async () => {
      const a = makeVisibleInput("email", {
        props: { id: "a", name: "email" },
        rect: { top: 1000, bottom: 1030 },
      });
      const b = makeVisibleInput("email", {
        props: { id: "b", name: "email" },
        rect: { top: 10, bottom: 40 },
      });
      a.focus();
      const reply = await callListener(api, {
        type: "fill",
        username: "alice",
      });
      expect(reply.filled).toEqual({ username: true, password: false });
      expect(a.value).toBe("alice");
      expect(b.value).toBe("");
    });

    it("falls back to viewport-visibility when nothing is focused", async () => {
      const offscreen = makeVisibleInput("email", {
        props: { id: "o", name: "email" },
        rect: { top: 2000, bottom: 2030 },
      });
      const visible = makeVisibleInput("email", {
        props: { id: "v", name: "email" },
        rect: { top: 10, bottom: 40 },
      });
      await callListener(api, {
        type: "fill",
        username: "alice",
      });
      expect(visible.value).toBe("alice");
      expect(offscreen.value).toBe("");
    });
  });

  describe("looksLikeUsername", () => {
    it("accepts inputs with any of the canonical hints in id/name/placeholder/autocomplete/aria-label", async () => {
      const cases = [
        { id: "user-id" },
        { name: "username" },
        { placeholder: "Login" },
        { "attr:autocomplete": "email" },
        { "attr:aria-label": "your account" },
      ];
      for (const props of cases) {
        document.body.innerHTML = "";
        const username = makeVisibleInput("text", { props });
        const password = makeVisibleInput("password");
        await callListener(api, {
          type: "fill",
          username: "x",
          password: "y",
        });
        expect(username.value).toBe("x");
      }
    });

    it("rejects username-shaped types like number/checkbox/etc", async () => {
      document.body.innerHTML = "<form id='f'></form>";
      const form = document.getElementById("f");
      const phone = makeVisibleInput("number", {
        props: { id: "u", name: "username" },
        attached: false,
      });
      form.appendChild(phone);
      const password = makeVisibleInput("password", { attached: false });
      form.appendChild(password);
      const reply = await callListener(api, {
        type: "fill",
        username: "alice",
        password: "p",
      });
      expect(reply.filled.username).toBe(false);
      expect(phone.value).toBe("");
    });

    it("accepts a plain `text` input even when the haystack is empty", async () => {
      const plain = makeVisibleInput("text");
      const password = makeVisibleInput("password");
      await callListener(api, {
        type: "fill",
        username: "alice",
        password: "p",
      });
      expect(plain.value).toBe("alice");
    });

    it("rejects an input whose .type getter returns '' even with empty haystack", async () => {
      const noType = makeVisibleInput("text");
      // happy-dom normalises `input.type = ""` back to "text" the way
      // every browser does, so we must stub the property to force the
      // empty-string branch. The runtime branch exists to filter out
      // legacy/exotic input shapes whose .type is genuinely empty.
      Object.defineProperty(noType, "type", {
        get: () => "",
        configurable: true,
      });
      const password = makeVisibleInput("password");
      const reply = await callListener(api, {
        type: "fill",
        username: "alice",
        password: "p",
      });
      expect(reply.filled.username).toBe(false);
      expect(noType.value).toBe("");
    });

    it("rejects an input whose haystack carries no canonical hint", async () => {
      const decoy = makeVisibleInput("text", {
        props: { id: "address-1", name: "street" },
      });
      const password = makeVisibleInput("password");
      const reply = await callListener(api, {
        type: "fill",
        username: "alice",
        password: "p",
      });
      expect(reply.filled.username).toBe(false);
      expect(decoy.value).toBe("");
    });
  });

  describe("isInteractable", () => {
    it("skips inputs whose computed style is hidden", async () => {
      const hiddenStyled = makeVisibleInput("password");
      hiddenStyled.style.visibility = "hidden";
      const visible = makeVisibleInput("password");
      const reply = await callListener(api, {
        type: "fill",
        password: "p",
      });
      expect(reply.filled.password).toBe(true);
      expect(visible.value).toBe("p");
      expect(hiddenStyled.value).toBe("");
    });

    it("skips inputs whose computed style is display:none", async () => {
      const noneStyled = makeVisibleInput("password");
      noneStyled.style.display = "none";
      const visible = makeVisibleInput("password");
      await callListener(api, {
        type: "fill",
        password: "p",
      });
      expect(visible.value).toBe("p");
      expect(noneStyled.value).toBe("");
    });

    it("skips zero-sized inputs (rect width or height = 0)", async () => {
      const zeroSize = makeVisibleInput("password", {
        rect: { width: 0, height: 0 },
      });
      const real = makeVisibleInput("password");
      await callListener(api, {
        type: "fill",
        password: "p",
      });
      expect(real.value).toBe("p");
      expect(zeroSize.value).toBe("");
    });
  });

  describe("assignInput / value setters and events", () => {
    it("dispatches input + change events so framework-controlled forms see the write", async () => {
      const password = makeVisibleInput("password");
      const events = [];
      password.addEventListener("input", () => events.push("input"));
      password.addEventListener("change", () => events.push("change"));
      await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(events).toEqual(["input", "change"]);
    });

    it("uses the prototype value setter (so React's internal state stays in sync)", async () => {
      // Spy on HTMLInputElement.prototype.value setter via accessor.
      const proto = HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      const spy = vi.fn(descriptor.set);
      Object.defineProperty(proto, "value", {
        ...descriptor,
        set: spy,
      });
      const password = makeVisibleInput("password");
      await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(spy).toHaveBeenCalledWith("hunter2");
      // Restore.
      Object.defineProperty(proto, "value", descriptor);
    });

    it("falls back to direct assignment when the prototype carries no value descriptor", async () => {
      // Stub the descriptor probe so assignInput's `setter` branch
      // misses and the fallback `el.value = value` runs against the
      // real prototype setter underneath.
      const origGetOwnDescriptor = Object.getOwnPropertyDescriptor;
      Object.getOwnPropertyDescriptor = (obj, key) => {
        if (key === "value" && obj === HTMLInputElement.prototype) {
          return undefined;
        }
        return origGetOwnDescriptor(obj, key);
      };
      try {
        const password = makeVisibleInput("password");
        await callListener(api, {
          type: "fill",
          password: "hunter2",
        });
        expect(password.value).toBe("hunter2");
      } finally {
        Object.getOwnPropertyDescriptor = origGetOwnDescriptor;
      }
    });
  });

  describe("pulse", () => {
    it("applies the brand outline immediately and restores the original on the 600 ms timer", async () => {
      vi.useFakeTimers();
      const password = makeVisibleInput("password");
      // Pre-existing outline set by the page as a shorthand — every
      // longhand ends up populated, so the page's intent is fully
      // recoverable after the pulse.
      password.style.outline = "1px dotted red";
      password.style.outlineOffset = "4px";
      await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      // During the pulse: brand colour + 2 px width + zero offset.
      expect(password.style.outlineColor).toBe("#3a4ba0");
      expect(password.style.outlineWidth).toBe("2px");
      expect(password.style.outlineStyle).toBe("solid");
      expect(password.style.outlineOffset).toBe("0");
      vi.advanceTimersByTime(600);
      // After restore: every longhand is back to its pre-pulse value.
      expect(password.style.outlineWidth).toBe("1px");
      expect(password.style.outlineStyle).toBe("dotted");
      expect(password.style.outlineColor).toBe("red");
      expect(password.style.outlineOffset).toBe("4px");
    });

    it("restores a page-set outlineWidth that was set as a longhand only (item U)", async () => {
      vi.useFakeTimers();
      const password = makeVisibleInput("password");
      // The bug: the page sets ONLY outlineWidth — the `outline`
      // shorthand serialises to "" because the other longhands are
      // unset, so the old shorthand-based save/restore captured ""
      // and the restore wiped the page's 3 px setting.
      password.style.outlineWidth = "3px";
      await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(password.style.outlineWidth).toBe("2px");
      vi.advanceTimersByTime(600);
      expect(password.style.outlineWidth).toBe("3px");
      // The other longhands were unset before the pulse — they should
      // still be unset, so the page's stylesheet (not inline) wins.
      expect(password.style.outlineStyle).toBe("");
      expect(password.style.outlineColor).toBe("");
    });

    it("restores a page-set outlineColor that was set as a longhand only", async () => {
      vi.useFakeTimers();
      const password = makeVisibleInput("password");
      password.style.outlineColor = "purple";
      await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(password.style.outlineColor).toBe("#3a4ba0");
      vi.advanceTimersByTime(600);
      expect(password.style.outlineColor).toBe("purple");
      expect(password.style.outlineWidth).toBe("");
      expect(password.style.outlineStyle).toBe("");
    });

    it("restores a page-set outlineStyle that was set as a longhand only", async () => {
      vi.useFakeTimers();
      const password = makeVisibleInput("password");
      password.style.outlineStyle = "dashed";
      await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(password.style.outlineStyle).toBe("solid");
      vi.advanceTimersByTime(600);
      expect(password.style.outlineStyle).toBe("dashed");
      expect(password.style.outlineWidth).toBe("");
      expect(password.style.outlineColor).toBe("");
    });

    it("restores a page-set outlineOffset that was set as a longhand only", async () => {
      vi.useFakeTimers();
      const password = makeVisibleInput("password");
      password.style.outlineOffset = "7px";
      await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(password.style.outlineOffset).toBe("0");
      vi.advanceTimersByTime(600);
      expect(password.style.outlineOffset).toBe("7px");
    });

    it("leaves every longhand empty when nothing was set inline before the pulse", async () => {
      vi.useFakeTimers();
      const password = makeVisibleInput("password");
      // No pre-existing outline on the input.
      expect(password.style.outlineWidth).toBe("");
      expect(password.style.outlineStyle).toBe("");
      expect(password.style.outlineColor).toBe("");
      expect(password.style.outlineOffset).toBe("");
      await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      vi.advanceTimersByTime(600);
      expect(password.style.outlineWidth).toBe("");
      expect(password.style.outlineStyle).toBe("");
      expect(password.style.outlineColor).toBe("");
      expect(password.style.outlineOffset).toBe("");
    });
  });

  describe("shadow DOM (item M)", () => {
    it("finds and fills a password input inside an open shadow root", async () => {
      const { input: password } = attachShadowInput("password");
      const reply = await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(reply.ok).toBe(true);
      expect(reply.filled.password).toBe(true);
      expect(password.value).toBe("hunter2");
    });

    it("descends through nested shadow roots", async () => {
      const outer = document.createElement("div");
      const outerShadow = outer.attachShadow({ mode: "open" });
      const inner = document.createElement("div");
      const innerShadow = inner.attachShadow({ mode: "open" });
      const password = document.createElement("input");
      password.type = "password";
      innerShadow.appendChild(password);
      outerShadow.appendChild(inner);
      document.body.appendChild(outer);
      stubRect(password);
      const reply = await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(reply.ok).toBe(true);
      expect(password.value).toBe("hunter2");
    });

    it("cannot see into a closed shadow root, and surfaces 'no password' to the popup", async () => {
      const { input: hidden } = attachShadowInput("password", {
        mode: "closed",
      });
      const reply = await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/No password input found/);
      expect(hidden.value).toBe("");
    });

    it("prefers a focused shadow-DOM input over a non-focused light-DOM input", async () => {
      const offscreenVisible = makeVisibleInput("password", {
        rect: { top: 10, bottom: 40 },
      });
      const { input: focusedShadow } = attachShadowInput("password", {
        rect: { top: 2000, bottom: 2030 },
      });
      focusedShadow.focus();
      const reply = await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(reply.ok).toBe(true);
      // Without `activeElementDeep` the picker would treat the shadow
      // host as the focused element and fall back to viewport ranking,
      // which would pick the visible light-DOM input instead.
      expect(focusedShadow.value).toBe("hunter2");
      expect(offscreenVisible.value).toBe("");
    });

    it("walks down two levels of nested shadow roots to find the truly focused field", async () => {
      const outer = document.createElement("div");
      const outerShadow = outer.attachShadow({ mode: "open" });
      const inner = document.createElement("div");
      const innerShadow = inner.attachShadow({ mode: "open" });
      const deepPassword = document.createElement("input");
      deepPassword.type = "password";
      innerShadow.appendChild(deepPassword);
      outerShadow.appendChild(inner);
      document.body.appendChild(outer);
      stubRect(deepPassword, { top: 1500, bottom: 1530 });
      const visibleDecoy = makeVisibleInput("password", {
        rect: { top: 5, bottom: 35 },
      });
      deepPassword.focus();
      const reply = await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(reply.ok).toBe(true);
      expect(deepPassword.value).toBe("hunter2");
      expect(visibleDecoy.value).toBe("");
    });

    it("falls back to viewport ranking when nothing is focused, across shadow boundaries", async () => {
      const { input: offscreen } = attachShadowInput("password", {
        rect: { top: 3000, bottom: 3030 },
      });
      const { input: visible } = attachShadowInput("password", {
        rect: { top: 20, bottom: 50 },
      });
      const reply = await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(reply.ok).toBe(true);
      expect(visible.value).toBe("hunter2");
      expect(offscreen.value).toBe("");
    });

    it("fills username + password living together inside an open shadow root", async () => {
      const host = document.createElement("div");
      const shadow = host.attachShadow({ mode: "open" });
      const username = document.createElement("input");
      username.type = "text";
      username.name = "username";
      shadow.appendChild(username);
      const password = document.createElement("input");
      password.type = "password";
      shadow.appendChild(password);
      document.body.appendChild(host);
      stubRect(username);
      stubRect(password);
      const reply = await callListener(api, {
        type: "fill",
        username: "alice",
        password: "hunter2",
      });
      expect(reply.ok).toBe(true);
      expect(reply.filled).toEqual({ username: true, password: true });
      expect(username.value).toBe("alice");
      expect(password.value).toBe("hunter2");
    });

    it("partial-fill (no password input on page) reaches a username inside a shadow root", async () => {
      const { input: email } = attachShadowInput("email", {
        props: { name: "email" },
      });
      const reply = await callListener(api, {
        type: "fill",
        username: "alice@example.com",
        password: "hunter2",
      });
      expect(reply.ok).toBe(true);
      expect(reply.filled).toEqual({ username: true, password: false });
      expect(email.value).toBe("alice@example.com");
    });

    it("cross-tree username candidate (DISCONNECTED compareDocumentPosition) is still selectable as the first fallback", async () => {
      // Password lives in one shadow tree; the username candidate lives
      // in a sibling shadow tree. `compareDocumentPosition` between two
      // nodes in different trees returns DOCUMENT_POSITION_DISCONNECTED,
      // so the "preceding candidate" filter drops it. We expect to fall
      // through to `candidates[0]` and still fill the username.
      const { input: username } = attachShadowInput("text", {
        props: { name: "username" },
      });
      const { input: password } = attachShadowInput("password");
      const reply = await callListener(api, {
        type: "fill",
        username: "alice",
        password: "hunter2",
      });
      expect(reply.ok).toBe(true);
      expect(reply.filled.username).toBe(true);
      expect(username.value).toBe("alice");
      expect(password.value).toBe("hunter2");
    });
  });

  describe("fallback paths inside the listener", () => {
    it("the listener catches errors thrown by fill and replies with ok:false", async () => {
      // No password input AND no username arg → fill() throws.
      const reply = await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/No password input found/);
    });

    it("the listener catches a non-Error throw inside fill and stringifies it", async () => {
      // Override Object.getPrototypeOf to throw a non-Error value the
      // first time it's called inside assignInput, so the `?? String(err)`
      // fallback runs.
      const original = Object.getPrototypeOf;
      let count = 0;
      Object.getPrototypeOf = (obj) => {
        count += 1;
        if (count === 1) {
          throw "kaboom"; // string, not Error
        }
        return original(obj);
      };
      makeVisibleInput("password");
      try {
        const reply = await callListener(api, {
          type: "fill",
          password: "p",
        });
        expect(reply.ok).toBe(false);
        expect(reply.error).toBe("kaboom");
      } finally {
        Object.getPrototypeOf = original;
      }
    });
  });
});
