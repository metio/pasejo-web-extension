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
    const candidates = Array.from(
      document.querySelectorAll('input[type="password"]'),
    ).filter(isInteractable);
    if (candidates.length === 0) {
      return null;
    }
    // Prefer the currently focused field; otherwise the first visible
    // password input in document order.
    const focused = document.activeElement;
    if (focused && candidates.includes(focused)) {
      return focused;
    }
    return candidates[0];
  }

  // Look for a username field that shares the password's form. Fall back
  // to the previous visible input that looks like a username.
  function findUsernameInputFor(passwordInput) {
    const form = passwordInput.form;
    const pool = form
      ? Array.from(form.elements).filter((el) => el instanceof HTMLInputElement)
      : Array.from(document.querySelectorAll("input"));
    const candidates = pool.filter(
      (el) => el !== passwordInput && isInteractable(el) && looksLikeUsername(el),
    );
    if (candidates.length === 0) {
      return null;
    }
    // If the password input came after a candidate in document order, prefer
    // the closest preceding candidate; otherwise take the first.
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
    if (!USERNAME_TYPES.has((el.type ?? "").toLowerCase())) {
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
      // No hints either way — accept a plain text/email input.
      return (el.type ?? "").toLowerCase() !== "";
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
