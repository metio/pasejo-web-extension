// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

(function setupPasejoFiller() {
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api?.runtime?.onMessage) {
    return;
  }

  // The pickers below are intentionally conservative: nothing fires
  // until the popup explicitly sends `{type: "fill"}`. The page never
  // sees credentials on load and never sees them in response to focus or
  // navigation events.
  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "fill") {
      return false;
    }
    try {
      const result = fill(message.username ?? "", message.password ?? "");
      sendResponse({ ok: true, ...result });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message ?? String(err) });
    }
    return false;
  });

  function fill(username, password) {
    const passwordInput = findPasswordInput();
    if (!passwordInput) {
      // Multi-step login pages (email page → password page) have no
      // password input on the email step. Fall back to a username-only
      // fill so the popup can still help the user past the first step,
      // and report `password: false` so the popup can tell them to
      // reopen on the next page for the password fill.
      if (username) {
        const usernameInput = findStandaloneUsernameInput();
        if (usernameInput) {
          assignInput(usernameInput, username);
          return {
            filled: { username: true, password: false },
          };
        }
      }
      throw new Error("No password input found on this page");
    }
    const usernameInput = findUsernameInputFor(passwordInput);

    if (usernameInput && username) {
      assignInput(usernameInput, username);
    }
    if (password) {
      assignInput(passwordInput, password);
    }
    return {
      filled: {
        username: Boolean(usernameInput && username),
        password: Boolean(password),
      },
    };
  }

  function findPasswordInput() {
    const candidates = queryAllDeep(
      document,
      'input[type="password"]',
    ).filter(isInteractable);
    if (candidates.length === 0) {
      return null;
    }
    // Prefer the currently focused field. Otherwise rank by viewport
    // visibility so a hidden-deep-in-the-page "change password" form
    // doesn't win over a visible login form sitting above the fold.
    const focused = activeElementDeep();
    if (focused && candidates.includes(focused)) {
      return focused;
    }
    candidates.sort((a, b) => visibilityScore(b) - visibilityScore(a));
    return candidates[0];
  }

  // Look for a username field that shares the password's form. Fall back
  // to the previous visible input that looks like a username.
  function findUsernameInputFor(passwordInput) {
    const form = passwordInput.form;
    // `form.elements` only sees regular form-associated inputs, not
    // those buried in a shadow root inside the form. For the form
    // case we accept that limitation (custom elements that own their
    // own form-associated inputs are rare); for the form-less case
    // (the common shadow-DOM scenario — the input has no `.form`
    // because the host is in a shadow tree) we walk every shadow
    // root reachable from the document.
    const pool = form
      ? Array.from(form.elements).filter((el) => el instanceof HTMLInputElement)
      : queryAllDeep(document, "input");
    const candidates = pool.filter(
      (el) => el !== passwordInput && isInteractable(el) && looksLikeUsername(el),
    );
    if (candidates.length === 0) {
      return null;
    }
    // If the password input came after a candidate in document order, prefer
    // the closest preceding candidate; otherwise take the first.
    // `compareDocumentPosition` returns 0 (DISCONNECTED) when the two
    // nodes live in different shadow trees, which makes both nodes look
    // "neither before nor after"; the `before` filter naturally drops
    // them and we fall through to the first candidate. The trade-off is
    // acceptable for now — cross-shadow-root match-ups are rare.
    const before = candidates.filter(
      (el) =>
        el.compareDocumentPosition(passwordInput) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    );
    if (before.length > 0) {
      return before[before.length - 1];
    }
    return candidates[0];
  }

  // Standalone username search for pages with no password input (the
  // first step of a multi-step login). Same focused → viewport-visible
  // → first-in-document ranking as the password search.
  function findStandaloneUsernameInput() {
    const candidates = queryAllDeep(document, "input").filter(
      (el) => isInteractable(el) && looksLikeUsername(el),
    );
    if (candidates.length === 0) {
      return null;
    }
    const focused = activeElementDeep();
    if (focused && candidates.includes(focused)) {
      return focused;
    }
    candidates.sort((a, b) => visibilityScore(b) - visibilityScore(a));
    return candidates[0];
  }

  // Recursive `querySelectorAll` that descends into every open shadow
  // root reachable from `root`. Closed shadow roots cannot be inspected
  // by outside JS — including content scripts running in their isolated
  // world — and are silently skipped; a site that hides its login form
  // inside a closed shadow root effectively opts out of autofill.
  function queryAllDeep(root, selector) {
    const matches = Array.from(root.querySelectorAll(selector));
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        matches.push(...queryAllDeep(el.shadowRoot, selector));
      }
    }
    return matches;
  }

  // `document.activeElement` reports the *shadow host* when focus is
  // inside a shadow tree, not the actually-focused inner element.
  // Walking down through `shadowRoot.activeElement` recovers the real
  // focus target, so the "prefer focused candidate" rule survives
  // shadow boundaries.
  function activeElementDeep() {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  // Fraction of the element's bounding box that lies inside the
  // viewport, in `[0, 1]`. Off-screen elements score 0; a fully
  // on-screen element scores ~1. Used to disambiguate between multiple
  // candidate inputs on the same page.
  function visibilityScore(el) {
    const rect = el.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const visibleH = Math.max(
      0,
      Math.min(rect.bottom, viewportH) - Math.max(rect.top, 0),
    );
    const visibleW = Math.max(
      0,
      Math.min(rect.right, viewportW) - Math.max(rect.left, 0),
    );
    const elementArea = Math.max(1, rect.height * rect.width);
    return (visibleH * visibleW) / elementArea;
  }

  const USERNAME_HINTS = [
    "user",
    "username",
    "login",
    "email",
    "account",
    "ident",
  ];

  const USERNAME_TYPES = new Set(["text", "email", "tel", "url", ""]);

  function looksLikeUsername(el) {
    const type = el.type.toLowerCase();
    if (!USERNAME_TYPES.has(type)) {
      return false;
    }
    const haystack = [
      el.id,
      el.name,
      el.placeholder,
      el.getAttribute("autocomplete"),
      el.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack) {
      // No hints either way — accept a plain text/email input, but
      // refuse the type-less catch-all (`USERNAME_TYPES` carries `""`
      // so exotic inputs whose `.type` is genuinely empty reach this
      // point; without a hint we have no reason to think they're for
      // usernames).
      return type !== "";
    }
    return USERNAME_HINTS.some((hint) => haystack.includes(hint));
  }

  function isInteractable(el) {
    if (el.disabled || el.readOnly) {
      return false;
    }
    if (el.type === "hidden") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") {
      return false;
    }
    return true;
  }

  // Frameworks like React track input values through the native setter;
  // assigning `el.value` directly leaves their internal state stale and
  // submission sees the old value. Going through the setter and then
  // dispatching synthetic input/change events keeps both raw-DOM and
  // controlled-component inputs in sync.
  function assignInput(el, value) {
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    const setter = descriptor?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    pulse(el);
  }

  // Brief visual feedback on the filled input so the user can tell at a
  // glance that a fill happened — the popup closes ~600 ms after a
  // successful fill, so the page itself has to confirm the change.
  // `outline` is used rather than `border` or `background` because it
  // sits outside the box model and can't shift the page layout.
  function pulse(el) {
    const previousOutline = el.style.outline;
    const previousOffset = el.style.outlineOffset;
    el.style.outline = "2px solid #3a4ba0";
    el.style.outlineOffset = "0";
    setTimeout(() => {
      el.style.outline = previousOutline;
      el.style.outlineOffset = previousOffset;
    }, 600);
  }
})();
