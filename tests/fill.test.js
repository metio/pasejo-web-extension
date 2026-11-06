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

import {
  evaluateClassicScript,
  loadClassicScript,
} from "./helpers/load-script.js";
import { makeApiMock } from "./helpers/mock-api.js";

// fill.js is wrapped in an IIFE — every helper inside is private. Tests
// therefore drive its public surface, the `pasejo-frame` port it opens
// on load, and assert on (a) the DOM mutations a fill applied and (b) the
// messages the script posted back on the port.

// Every message any loaded fill.js posted on its port, in order.
let posted = [];

// The extension-facing half of the port the most recently loaded
// fill.js opened.
function framePort(api) {
  const pair = api.__streamPairs.at(-1);
  if (!pair) {
    throw new Error("fill.js never opened its port");
  }
  return pair.backgroundPort;
}

// The `ready` message the most recently loaded fill.js posted.
function lastReady() {
  return posted.filter((m) => m.type === "ready").at(-1);
}

// Posts `message` to the content script and resolves with its
// `fill-result` reply minus the `type` tag, or undefined when the script
// did not answer. The mock port delivers synchronously.
async function callListener(api, message) {
  const before = posted.length;
  framePort(api).postMessage(message);
  const reply = posted.slice(before).find((m) => m.type === "fill-result");
  if (!reply) {
    return undefined;
  }
  const { type: _type, ...rest } = reply;
  return rest;
}

// Loads fill.js again so its `ready` message reflects the DOM the test
// has built since `beforeEach`.
function reloadFiller() {
  loadClassicScript("src/content/fill.js");
  return lastReady();
}

// An input with a box in the test layout, so the fill script sees it as
// rendered. happy-dom otherwise gives every element a 0×0 rect, which
// the script reads as hidden. Optionally supplies the rect's top/left so
// visibility-score tests can place inputs inside or outside the
// viewport deliberately.
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

// happy-dom has no layout, so the tests carry a small one of their own:
// every element `stubRect` registers has a fixed box in page
// coordinates, the viewport scrolls over them, and the topmost box
// registered last wins a hit test. Boxes without an explicit `top` stack
// below each other so inputs of one form never overlap.
const layout = {
  scrollX: 0,
  scrollY: 0,
  nextTop: 0,
  boxes: [],
};

function stubRect(el, rect = {}) {
  const width = rect.width ?? 200;
  const height = rect.height ?? 30;
  let top = rect.top;
  if (top === undefined) {
    top = layout.nextTop;
    layout.nextTop += height + 10;
  }
  const left = rect.left ?? 0;
  const box = {
    top,
    left,
    bottom: rect.bottom ?? top + height,
    right: rect.right ?? left + width,
    width,
    height,
  };
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({
      width: box.width,
      height: box.height,
      top: box.top - layout.scrollY,
      bottom: box.bottom - layout.scrollY,
      left: box.left - layout.scrollX,
      right: box.right - layout.scrollX,
    }),
    configurable: true,
  });
  layout.boxes.push(el);
  return el;
}

// Retargets `el` against `root` the way `elementFromPoint` does: an
// element inside a shadow tree `root` cannot see is replaced by that
// tree's host, repeatedly.
function retarget(el, root) {
  let node = el;
  for (
    let tree = node.getRootNode();
    tree !== root && tree instanceof ShadowRoot;
    tree = node.getRootNode()
  ) {
    node = tree.host;
  }
  return node;
}

// The topmost connected registered element whose box holds the
// viewport point (x, y), retargeted against `root`, or null.
function hitTest(root, x, y) {
  for (let i = layout.boxes.length - 1; i >= 0; i -= 1) {
    const el = layout.boxes[i];
    if (!el.isConnected) {
      continue;
    }
    const r = el.getBoundingClientRect();
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
      return retarget(el, root);
    }
  }
  return null;
}

// Scrolls the viewport so `el`'s centre lands in the middle, as far as
// the page allows: scroll offsets never go below zero.
function scrollToCentre(el) {
  const r = el.getBoundingClientRect();
  layout.scrollX = Math.max(
    0,
    layout.scrollX + r.left + r.width / 2 - window.innerWidth / 2,
  );
  layout.scrollY = Math.max(
    0,
    layout.scrollY + r.top + r.height / 2 - window.innerHeight / 2,
  );
}

function installLayout() {
  layout.scrollX = 0;
  layout.scrollY = 0;
  layout.nextTop = 0;
  layout.boxes = [];
  document.elementFromPoint = (x, y) => hitTest(document, x, y);
  ShadowRoot.prototype.elementFromPoint = function elementFromPoint(x, y) {
    return hitTest(this, x, y);
  };
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(
    function scrollIntoView() {
      scrollToCentre(this);
    },
  );
}

function uninstallLayout() {
  delete document.elementFromPoint;
  delete ShadowRoot.prototype.elementFromPoint;
}

// An element laid over `target`'s box, the way a page would put a
// transparent overlay over a field to catch the user's click.
function coverWith(target, tag = "div") {
  const overlay = document.createElement(tag);
  document.body.appendChild(overlay);
  const r = target.getBoundingClientRect();
  stubRect(overlay, {
    top: r.top + layout.scrollY,
    left: r.left + layout.scrollX,
    width: r.width,
    height: r.height,
  });
  return overlay;
}

// happy-dom validates CSS colours strictly: it rejects keywords real
// modern browsers accept, including the `AccentColor` system colour
// the content script's pulse uses. Tests that need to verify the
// during-pulse outline value have to bypass that validation by
// replacing `outlineColor` with a permissive getter/setter pair on
// the specific input. The stub is per-element, not global, so the
// rest of the test suite still exercises happy-dom's real CSS
// validation on every other element.
function relaxOutlineColor(el) {
  let value = el.style.outlineColor;
  Object.defineProperty(el.style, "outlineColor", {
    configurable: true,
    get() {
      return value;
    },
    set(v) {
      value = v;
    },
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
    installLayout();
    posted = [];
    api.runtime.onConnect.addListener((port) => {
      port.onMessage.addListener((message) => posted.push(message));
    });
    loadClassicScript("src/content/fill.js");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    uninstallLayout();
    delete globalThis.browser;
    delete globalThis.chrome;
    document.body.innerHTML = "";
  });

  describe("port wiring", () => {
    it("opens exactly one pasejo-frame port on load", () => {
      expect(api.runtime.connect).toHaveBeenCalledTimes(1);
      expect(api.runtime.connect).toHaveBeenCalledWith({
        name: "pasejo-frame",
      });
    });

    it("evaluates to true, the injection result the popup reads", () => {
      expect(evaluateClassicScript("src/content/fill.js")).toBe(true);
    });

    it("ignores messages without a recognised type", async () => {
      const reply = await callListener(api, { type: "other" });
      expect(reply).toBeUndefined();
    });

    it("ignores null messages", async () => {
      const reply = await callListener(api, null);
      expect(reply).toBeUndefined();
    });

    it("tags its fill reply as a fill-result", async () => {
      makeVisibleInput("password");
      framePort(api).postMessage({ type: "fill", password: "p" });
      expect(posted.at(-1)).toMatchObject({ type: "fill-result", ok: true });
    });
  });

  describe("ready message (frame ordering facts)", () => {
    // happy-dom's `document.hasFocus()` default varies across versions;
    // we stub it explicitly so each test exercises the contract
    // deterministically rather than relying on the engine's defaults.

    it("reports `focused: true` when document.hasFocus() is true", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      expect(reloadFiller()).toEqual({
        type: "ready",
        focused: true,
        editableFocused: false,
      });
    });

    it("reports `focused: false` when document.hasFocus() is false", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      expect(reloadFiller()).toEqual({
        type: "ready",
        focused: false,
        editableFocused: false,
      });
    });

    it("reports `editableFocused` when a password input holds focus", () => {
      makeVisibleInput("password").focus();
      expect(reloadFiller().editableFocused).toBe(true);
    });

    it("reports `editableFocused` for username-capable types too", () => {
      makeVisibleInput("email", { props: { name: "email" } }).focus();
      expect(reloadFiller().editableFocused).toBe(true);
    });

    it("does not count focus on an input a fill would never target (checkbox)", () => {
      makeVisibleInput("checkbox").focus();
      expect(reloadFiller().editableFocused).toBe(false);
    });

    it("does not count focus on a non-input element", () => {
      const button = document.createElement("button");
      document.body.appendChild(button);
      button.focus();
      expect(reloadFiller().editableFocused).toBe(false);
    });

    it("sees an input focused inside an open shadow root", () => {
      const { input } = attachShadowInput("password");
      input.focus();
      expect(reloadFiller().editableFocused).toBe(true);
    });

    it("does not mutate the DOM", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const password = makeVisibleInput("password");
      const observer = vi.fn();
      password.addEventListener("input", observer);
      password.addEventListener("change", observer);
      reloadFiller();
      expect(observer).not.toHaveBeenCalled();
      expect(password.value).toBe("");
    });
  });

  describe("port wiring (defensive)", () => {
    it("does not throw and evaluates to false without a WebExtensions API on globalThis", () => {
      // Wipe out both globals so the `globalThis.browser ?? globalThis.chrome`
      // resolution yields undefined and fill.js hits its early `return`.
      delete globalThis.browser;
      delete globalThis.chrome;
      expect(evaluateClassicScript("src/content/fill.js")).toBe(false);
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
        filled: { username: true, password: true, otp: false },
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
      expect(reply.filled).toEqual({ username: false, password: true, otp: false });
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

  describe("OTP autofill", () => {
    it("fills a one-time-code field alongside username and password", async () => {
      document.body.innerHTML = "<form id='f'></form>";
      const form = document.getElementById("f");
      const username = makeVisibleInput("text", {
        props: { id: "user" },
        attached: false,
      });
      form.appendChild(username);
      const password = makeVisibleInput("password", { attached: false });
      form.appendChild(password);
      const otp = makeVisibleInput("text", {
        props: { autocomplete: "one-time-code" },
        attached: false,
      });
      form.appendChild(otp);

      const reply = await callListener(api, {
        type: "fill",
        username: "alice",
        password: "hunter2",
        otp: "123456",
      });
      expect(reply.filled).toEqual({
        username: true,
        password: true,
        otp: true,
      });
      expect(otp.value).toBe("123456");
    });

    it("fills a standalone 2FA page that has only a one-time-code field", async () => {
      const otp = makeVisibleInput("text", { props: { name: "otp" } });
      const reply = await callListener(api, { type: "fill", otp: "654321" });
      expect(reply.ok).toBe(true);
      expect(reply.filled).toEqual({
        username: false,
        password: false,
        otp: true,
      });
      expect(otp.value).toBe("654321");
    });

    it("fills a name-hinted OTP field when autocomplete is absent", async () => {
      const otp = makeVisibleInput("tel", { props: { name: "totp_code" } });
      const reply = await callListener(api, { type: "fill", otp: "999000" });
      expect(reply.filled.otp).toBe(true);
      expect(otp.value).toBe("999000");
    });

    it("does not fill an OTP field when the match carries no code", async () => {
      makeVisibleInput("password");
      const otp = makeVisibleInput("text", { props: { name: "otp" } });
      const reply = await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(reply.filled.otp).toBe(false);
      expect(otp.value).toBe("");
    });

    it("reports otp:false when a code is supplied but the page has no OTP field", async () => {
      makeVisibleInput("password");
      const reply = await callListener(api, {
        type: "fill",
        password: "hunter2",
        otp: "123456",
      });
      expect(reply.filled).toEqual({
        username: false,
        password: true,
        otp: false,
      });
    });

    it("does not mistake an unrelated code field (e.g. promo code) for a one-time code", async () => {
      makeVisibleInput("password");
      const promo = makeVisibleInput("text", { props: { name: "promocode" } });
      const reply = await callListener(api, {
        type: "fill",
        password: "hunter2",
        otp: "123456",
      });
      expect(reply.filled.otp).toBe(false);
      expect(promo.value).toBe("");
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
      expect(reply.filled).toEqual({ username: true, password: false, otp: false });
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

  describe("password field ranking", () => {
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

  describe("username field next to a password field", () => {
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
      expect(reply.filled).toEqual({ username: false, password: true, otp: false });
      expect(password.value).toBe("p");
    });
  });

  describe("standalone username field (partial-fill path)", () => {
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
      expect(reply.filled).toEqual({ username: true, password: false, otp: false });
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

    it("accepts inputs whose haystack only carries a non-English-language hint (item W)", async () => {
      // Covers the localised-placeholder / aria-label case: sites
      // that leave attribute NAMES in English but localise the
      // user-facing strings. Each row is one site we'd otherwise
      // miss before the multi-lingual hints landed.
      const cases = [
        { placeholder: "Benutzername" }, // German "username"
        { placeholder: "Konto" }, // German "account"
        { placeholder: "Anmelden" }, // German "log in"
        { placeholder: "Utilisateur" }, // French "user"
        { placeholder: "Connexion" }, // French "log in"
        { placeholder: "Compte" }, // French "account"
        { placeholder: "Courriel" }, // French "email"
        { placeholder: "Usuario" }, // Spanish "user"
        { placeholder: "Cuenta" }, // Spanish "account"
        { placeholder: "Correo" }, // Spanish "email"
        { placeholder: "Utente" }, // Italian "user"
        { placeholder: "Accesso" }, // Italian "access / log in"
        { placeholder: "Acessar" }, // Portuguese "to access"
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
        expect(username.value).toBe(
          "x",
          `expected hint ${JSON.stringify(props)} to be detected`,
        );
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

    it("vetoes hint matches that also look like account-number / amount fields (review8 item F)", async () => {
      // Each row is a financial-form label whose stem collides with a
      // username hint: "Kontonummer" contains "konto", "Account
      // number" contains "account", "Número de cuenta" contains
      // "cuenta". Filling a username into an IBAN or income field is
      // the costliest false positive the heuristic can produce, so a
      // veto term in the haystack rejects the candidate outright.
      const cases = [
        { placeholder: "Kontonummer" }, // German bank account number
        { placeholder: "Account number" }, // English
        { placeholder: "Número de cuenta" }, // Spanish account number
        { "attr:aria-label": "IBAN Konto" }, // explicit IBAN label
        { placeholder: "Betrag vom Konto" }, // German amount-from-account
        { placeholder: "Importo conto utente" }, // Italian amount field
      ];
      for (const props of cases) {
        document.body.innerHTML = "";
        const decoy = makeVisibleInput("text", { props });
        const password = makeVisibleInput("password");
        const reply = await callListener(api, {
          type: "fill",
          username: "alice",
          password: "p",
        });
        expect(decoy.value).toBe(
          "",
          `expected ${JSON.stringify(props)} to be vetoed`,
        );
        expect(reply.filled.username).toBe(false);
        expect(password.value).toBe("p");
      }
    });

    it("still accepts the plain hint words the veto exists to protect (positive control for item F)", async () => {
      const cases = [
        { placeholder: "Konto" },
        { placeholder: "Account" },
        { placeholder: "Cuenta" },
      ];
      for (const props of cases) {
        document.body.innerHTML = "";
        const username = makeVisibleInput("text", { props });
        const password = makeVisibleInput("password");
        await callListener(api, {
          type: "fill",
          username: "alice",
          password: "p",
        });
        expect(username.value).toBe(
          "alice",
          `expected ${JSON.stringify(props)} to stay accepted`,
        );
      }
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

  describe("hidden candidates next to visible ones", () => {
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

  describe("no UI inside the page", () => {
    it("adds no element, shadow root or frame to the page while it loads, reports ready and fills", async () => {
      vi.useFakeTimers();
      document.body.innerHTML = "<form id='f'></form>";
      const form = document.getElementById("f");
      const username = makeVisibleInput("text", {
        props: { name: "username" },
        attached: false,
      });
      form.appendChild(username);
      const password = makeVisibleInput("password", { attached: false });
      form.appendChild(password);
      const otp = makeVisibleInput("text", {
        props: { autocomplete: "one-time-code" },
      });
      const decoy = makeVisibleInput("password");
      const overlay = coverWith(decoy);
      decoy.focus();
      const elementsBefore = document.querySelectorAll("*").length;

      const records = [];
      const observer = new MutationObserver((batch) => records.push(...batch));
      observer.observe(document, { childList: true, subtree: true });
      const builders = [
        vi.spyOn(document, "createElement"),
        vi.spyOn(document, "createElementNS"),
        vi.spyOn(Element.prototype, "attachShadow"),
        vi.spyOn(Element.prototype, "insertAdjacentHTML"),
        vi.spyOn(Element.prototype, "insertAdjacentElement"),
      ];

      reloadFiller();
      const filled = await callListener(api, {
        type: "fill",
        username: "alice",
        password: "p",
        otp: "123456",
      });
      const elementsAfterFill = document.querySelectorAll("*").length;
      document.body.replaceChildren(decoy, overlay);
      const refused = await callListener(api, { type: "fill", password: "p" });
      vi.advanceTimersByTime(1_000);

      expect(filled.ok).toBe(true);
      expect(refused).toMatchObject({ ok: false, reason: "covered" });
      expect(otp.value).toBe("123456");
      // The only childList change is the test's own `replaceChildren`.
      records.push(...observer.takeRecords());
      const added = records.flatMap((record) => Array.from(record.addedNodes));
      expect(added).toEqual([decoy, overlay]);
      for (const builder of builders) {
        expect(builder).not.toHaveBeenCalled();
      }
      expect(elementsAfterFill).toBe(elementsBefore);
      expect(document.querySelectorAll("*")).toHaveLength(
        document.querySelectorAll("html, head, body").length + 2,
      );
      observer.disconnect();
    });
  });

  describe("visible-field check at fill time", () => {
    // Fills a lone password field and returns the reply plus the field.
    async function fillLonePassword(prepare) {
      const input = makeVisibleInput("password");
      prepare(input);
      const reply = await callListener(api, { type: "fill", password: "p" });
      return { reply, input };
    }

    // Wraps `el` in a fresh parent styled with `style`, kept in place.
    function wrap(el, style) {
      const parent = document.createElement("div");
      parent.setAttribute("style", style);
      el.replaceWith(parent);
      parent.appendChild(el);
      return parent;
    }

    it("fills a field that is rendered, in view and on top", async () => {
      const { reply, input } = await fillLonePassword(() => {});
      expect(reply).toEqual({
        ok: true,
        filled: { username: false, password: true, otp: false },
      });
      expect(input.value).toBe("p");
    });

    it("refuses a field with a zero-sized box", async () => {
      const input = makeVisibleInput("password", { rect: { width: 0 } });
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply).toMatchObject({ ok: false, reason: "hidden" });
      expect(input.value).toBe("");
    });

    it("refuses a field styled display:none", async () => {
      const { reply, input } = await fillLonePassword((el) => {
        el.style.display = "none";
      });
      expect(reply).toMatchObject({ ok: false, reason: "hidden" });
      expect(input.value).toBe("");
    });

    it("refuses a field inside a display:none ancestor", async () => {
      const { reply, input } = await fillLonePassword((el) =>
        wrap(el, "display: none"),
      );
      expect(reply).toMatchObject({ ok: false, reason: "hidden" });
      expect(input.value).toBe("");
    });

    it("refuses a field whose ancestor is visibility:hidden", async () => {
      const { reply } = await fillLonePassword((el) =>
        wrap(el, "visibility: hidden"),
      );
      expect(reply).toMatchObject({ ok: false, reason: "hidden" });
    });

    it("refuses a field styled visibility:collapse", async () => {
      const { reply } = await fillLonePassword((el) => {
        el.style.visibility = "collapse";
      });
      expect(reply).toMatchObject({ ok: false, reason: "hidden" });
    });

    it("refuses a fully transparent field", async () => {
      const { reply, input } = await fillLonePassword((el) => {
        el.style.opacity = "0";
      });
      expect(reply).toMatchObject({ ok: false, reason: "hidden" });
      expect(input.value).toBe("");
    });

    it("refuses a field inside a fully transparent ancestor", async () => {
      const { reply } = await fillLonePassword((el) =>
        wrap(el, "opacity: 0"),
      );
      expect(reply).toMatchObject({ ok: false, reason: "hidden" });
    });

    it("refuses a field whose ancestors multiply to a near-invisible opacity", async () => {
      const { reply } = await fillLonePassword((el) => {
        wrap(wrap(el, "opacity: 0.3"), "opacity: 0.3");
      });
      expect(reply).toMatchObject({ ok: false, reason: "hidden" });
    });

    it("fills a half-transparent field", async () => {
      const { reply, input } = await fillLonePassword((el) =>
        wrap(el, "opacity: 0.5"),
      );
      expect(reply.ok).toBe(true);
      expect(input.value).toBe("p");
    });

    it("refuses a field the browser itself reports as not visible", async () => {
      const { reply } = await fillLonePassword((el) => {
        el.checkVisibility = vi.fn(() => false);
      });
      expect(reply).toMatchObject({ ok: false, reason: "hidden" });
    });

    it("asks the browser about opacity and visibility, not only display", async () => {
      const { reply, input } = await fillLonePassword((el) => {
        el.checkVisibility = vi.fn(() => true);
      });
      expect(reply.ok).toBe(true);
      expect(input.checkVisibility).toHaveBeenCalledWith({
        opacityProperty: true,
        visibilityProperty: true,
      });
    });

    it("refuses a field inside a hidden shadow host", async () => {
      const { host, input } = attachShadowInput("password");
      host.style.display = "none";
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply).toMatchObject({ ok: false, reason: "hidden" });
      expect(input.value).toBe("");
    });

    it("judges a slotted field by the slot it renders in", async () => {
      const host = document.createElement("div");
      const shadow = host.attachShadow({ mode: "open" });
      const hiddenWrapper = document.createElement("div");
      hiddenWrapper.style.display = "none";
      const slot = document.createElement("slot");
      hiddenWrapper.appendChild(slot);
      shadow.appendChild(hiddenWrapper);
      const input = makeVisibleInput("password", { attached: false });
      host.appendChild(input);
      document.body.appendChild(host);
      Object.defineProperty(input, "assignedSlot", { value: slot });
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply).toMatchObject({ ok: false, reason: "hidden" });
    });

    it("scrolls a field below the fold into view and fills it", async () => {
      const input = makeVisibleInput("password", {
        rect: { top: 2000, height: 30 },
      });
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply.ok).toBe(true);
      expect(input.scrollIntoView).toHaveBeenCalledWith({
        block: "center",
        inline: "center",
        behavior: "instant",
      });
      expect(input.value).toBe("p");
    });

    it("does not scroll a field that is already in view", async () => {
      const input = makeVisibleInput("password");
      await callListener(api, { type: "fill", password: "p" });
      expect(input.scrollIntoView).not.toHaveBeenCalled();
    });

    it("refuses a field placed where no scrolling can reach", async () => {
      for (const rect of [{ left: -9999 }, { top: -9999 }, { left: 5000 }]) {
        document.body.innerHTML = "";
        const input = makeVisibleInput("password", { rect });
        // A viewport that cannot scroll sideways keeps a far-right field out.
        input.scrollIntoView.mockImplementationOnce(() => {});
        const reply = await callListener(api, {
          type: "fill",
          password: "p",
        });
        expect(reply).toMatchObject({ ok: false, reason: "offscreen" });
        expect(input.value).toBe("");
      }
    });

    it("refuses a field covered by another element", async () => {
      const input = makeVisibleInput("password");
      coverWith(input);
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply).toMatchObject({ ok: false, reason: "covered" });
      expect(input.value).toBe("");
    });

    it("refuses a field nothing at all is hit at", async () => {
      const input = makeVisibleInput("password");
      document.elementFromPoint = () => null;
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply).toMatchObject({ ok: false, reason: "covered" });
      expect(input.value).toBe("");
    });

    it("fills a field whose own label lies over it", async () => {
      const input = makeVisibleInput("password", { props: { id: "pw" } });
      const label = coverWith(input, "label");
      label.htmlFor = "pw";
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply.ok).toBe(true);
      expect(input.value).toBe("p");
    });

    it("refuses a field another field's label lies over", async () => {
      const input = makeVisibleInput("password", { props: { id: "pw" } });
      makeVisibleInput("text", { props: { id: "other" } });
      const label = coverWith(input, "label");
      label.htmlFor = "other";
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply).toMatchObject({ ok: false, reason: "covered" });
    });

    it("finds a field on top inside nested open shadow roots", async () => {
      const outer = document.createElement("div");
      const outerShadow = outer.attachShadow({ mode: "open" });
      const inner = document.createElement("div");
      const innerShadow = inner.attachShadow({ mode: "open" });
      const input = document.createElement("input");
      input.type = "password";
      innerShadow.appendChild(input);
      outerShadow.appendChild(inner);
      document.body.appendChild(outer);
      stubRect(input);
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply.ok).toBe(true);
      expect(input.value).toBe("p");
    });

    it("refuses a shadow field covered by an element inside the same shadow root", async () => {
      const { shadow, input } = attachShadowInput("password");
      const overlay = document.createElement("div");
      shadow.appendChild(overlay);
      const r = input.getBoundingClientRect();
      stubRect(overlay, { top: r.top, left: r.left });
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply).toMatchObject({ ok: false, reason: "covered" });
    });

    it("refuses a shadow field when the shadow root reports its own host at the point", async () => {
      const { host, input } = attachShadowInput("password");
      stubRect(host, input.getBoundingClientRect());
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply).toMatchObject({ ok: false, reason: "covered" });
    });

    it("refuses a shadow field when the shadow root reports nothing at the point", async () => {
      const { shadow } = attachShadowInput("password");
      shadow.elementFromPoint = () => null;
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply).toMatchObject({ ok: false, reason: "covered" });
    });

    it("passes over a decoy and fills the field the user sees", async () => {
      const decoy = makeVisibleInput("password");
      decoy.style.opacity = "0";
      const real = makeVisibleInput("password");
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply.ok).toBe(true);
      expect(real.value).toBe("p");
      expect(decoy.value).toBe("");
    });

    it("passes over a covered focused field for a visible one", async () => {
      const focused = makeVisibleInput("password");
      coverWith(focused);
      const other = makeVisibleInput("password");
      focused.focus();
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply.ok).toBe(true);
      expect(other.value).toBe("p");
      expect(focused.value).toBe("");
    });

    it("leaves a hidden username field empty while filling the visible password", async () => {
      document.body.innerHTML = "<form id='f'></form>";
      const form = document.getElementById("f");
      const username = makeVisibleInput("text", {
        props: { name: "username" },
        attached: false,
      });
      username.style.opacity = "0";
      form.appendChild(username);
      const password = makeVisibleInput("password", { attached: false });
      form.appendChild(password);
      const reply = await callListener(api, {
        type: "fill",
        username: "alice",
        password: "p",
      });
      expect(reply.filled).toEqual({
        username: false,
        password: true,
        otp: false,
      });
      expect(username.value).toBe("");
    });

    it("leaves a covered one-time-code field empty", async () => {
      const otp = makeVisibleInput("text", {
        props: { autocomplete: "one-time-code" },
      });
      coverWith(otp);
      const password = makeVisibleInput("password");
      const reply = await callListener(api, {
        type: "fill",
        password: "p",
        otp: "123456",
      });
      expect(reply.filled.otp).toBe(false);
      expect(otp.value).toBe("");
      expect(password.value).toBe("p");
    });

    it("fills only the username of a multi-step page whose password field is a transparent decoy", async () => {
      const username = makeVisibleInput("email", {
        props: { name: "email" },
      });
      const decoy = makeVisibleInput("password");
      decoy.style.opacity = "0";
      const reply = await callListener(api, {
        type: "fill",
        username: "alice",
        password: "p",
      });
      expect(reply.filled).toEqual({
        username: true,
        password: false,
        otp: false,
      });
      expect(username.value).toBe("alice");
      expect(decoy.value).toBe("");
    });

    it("reports why the best-ranked password field was refused", async () => {
      const covered = makeVisibleInput("password");
      coverWith(covered);
      covered.focus();
      const hidden = makeVisibleInput("password");
      hidden.style.opacity = "0";
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply).toMatchObject({ ok: false, reason: "covered" });
      expect(reply.error).toMatch(/covered/);
    });

    it("keeps the plain no-field error when the page has no candidate at all", async () => {
      const reply = await callListener(api, { type: "fill", password: "p" });
      expect(reply.ok).toBe(false);
      expect(reply.reason).toBeUndefined();
      expect(reply.error).toMatch(/No password input found/);
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
    it("applies the AccentColor outline immediately and restores the original on the 600 ms timer", async () => {
      vi.useFakeTimers();
      const password = makeVisibleInput("password");
      // Pre-existing outline set by the page as a shorthand — every
      // longhand ends up populated, so the page's intent is fully
      // recoverable after the pulse.
      password.style.outline = "1px dotted red";
      password.style.outlineOffset = "4px";
      // happy-dom rejects the `AccentColor` keyword the pulse uses;
      // relax the input's outlineColor setter so the during-pulse
      // assertion can observe what real browsers would write.
      relaxOutlineColor(password);
      await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      // During the pulse: AccentColor + 2 px width + zero offset.
      expect(password.style.outlineColor).toBe("AccentColor");
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
      relaxOutlineColor(password);
      await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(password.style.outlineColor).toBe("AccentColor");
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
      expect(reply.filled).toEqual({ username: true, password: true, otp: false });
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
      expect(reply.filled).toEqual({ username: true, password: false, otp: false });
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

  describe("single-walk gather (item Q)", () => {
    // The refactor's load-bearing invariant: every fill path now
    // walks the DOM once via `queryAllDeep(document, "input")` and
    // filters the resulting pool for password / username candidates
    // in JS, rather than re-walking for each of the two roles. Spy
    // on the top-level `document.querySelectorAll` to lock the new
    // shape in place — a regression that re-introduced a separate
    // `input[type="password"]` walk would show up as TWO selector-
    // matching calls.

    // happy-dom issues its own internal `querySelectorAll` calls
    // for style resolution (e.g. `"style,link[rel=stylesheet]"`)
    // during visibility checks. Filter the spy to the input-related
    // selectors only — those are the ones the fill path's deep walk
    // would issue.
    const inputSelectorCalls = (querySpy) =>
      querySpy.mock.calls
        .map((args) => args[0])
        .filter((s) => typeof s === "string" && s.includes("input"));

    it("a form-less password fill issues a single `input` selector lookup on document, not separate password+input walks", async () => {
      const querySpy = vi.spyOn(document, "querySelectorAll");
      // No <form> around the inputs: this is the path that used to
      // walk the DOM twice (once for password, once for any input).
      const username = makeVisibleInput("text", { props: { name: "user" } });
      const password = makeVisibleInput("password");
      const reply = await callListener(api, {
        type: "fill",
        username: "alice",
        password: "hunter2",
      });
      expect(reply.ok).toBe(true);
      // Exactly one selector-based traversal on the document, and
      // it asks for ALL `input` elements (not the narrow
      // `input[type="password"]` the previous structure used).
      expect(inputSelectorCalls(querySpy)).toEqual(["input"]);
      // Sanity: the fill still hit the right elements.
      expect(username.value).toBe("alice");
      expect(password.value).toBe("hunter2");
    });

    it("a standalone-username fill (no password input on page) also issues only the single `input` lookup", async () => {
      const querySpy = vi.spyOn(document, "querySelectorAll");
      const email = makeVisibleInput("email", { props: { name: "email" } });
      const reply = await callListener(api, {
        type: "fill",
        username: "alice@example.com",
        password: "hunter2",
      });
      expect(reply.ok).toBe(true);
      expect(reply.filled).toEqual({ username: true, password: false, otp: false });
      // Same single-walk property: no second deep walk for the
      // standalone-username search.
      expect(inputSelectorCalls(querySpy)).toEqual(["input"]);
      expect(email.value).toBe("alice@example.com");
    });

    it("descends into shadow hosts via TreeWalker (no per-element `*` enumeration at the JS layer)", async () => {
      // The internal change: instead of `root.querySelectorAll("*")`
      // (which forces JS to iterate every element just to check
      // `.shadowRoot`), the walk uses `createTreeWalker` with a
      // shadow-host filter — the engine visits every element under
      // the hood but only surfaces shadow hosts to JS. Spy on the
      // document's `createTreeWalker` to lock this in.
      const walkerSpy = vi.spyOn(document, "createTreeWalker");
      attachShadowInput("password");
      const reply = await callListener(api, {
        type: "fill",
        password: "hunter2",
      });
      expect(reply.ok).toBe(true);
      expect(walkerSpy).toHaveBeenCalled();
      const [, whatToShow, filter] = walkerSpy.mock.calls[0];
      expect(whatToShow).toBe(NodeFilter.SHOW_ELEMENT);
      // A non-shadow-host element is skipped.
      const plainEl = document.createElement("div");
      expect(filter.acceptNode(plainEl)).toBe(NodeFilter.FILTER_SKIP);
      // A shadow host is accepted.
      const host = document.createElement("div");
      host.attachShadow({ mode: "open" });
      expect(filter.acceptNode(host)).toBe(NodeFilter.FILTER_ACCEPT);
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
