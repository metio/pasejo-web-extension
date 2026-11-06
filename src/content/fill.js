// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

// The popup injects this file with `scripting.executeScript` when the user
// picks a match, into every frame of the active tab it may reach. Each run
// opens a port back to the popup; the browser stamps that port with the
// frame's id and origin, which is what the popup decides on before it sends
// a credential. The value of the IIFE is the injection result the popup
// reads: `true` once the port is open.
(function setupPasejoFiller() {
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api?.runtime?.connect) {
    return false;
  }

  // Must match `FRAME_PORT_NAME` in popup.js.
  const FRAME_PORT_NAME = "pasejo-frame";

  // Pulse outline colour — the user's OS / browser system accent.
  // Targeting Firefox 103+ / Chromium 118+ for the `AccentColor`
  // keyword; both engines are years past those versions, so no
  // feature detection or fallback is needed. The pulse picks up the
  // theme the user has already chosen rather than imposing a brand
  // colour on every page.
  const PULSE_OUTLINE_COLOR = "AccentColor";

  // Fills what the page offers: the password field, the username field
  // that goes with it (or, on the first step of a multi-step login, a
  // username field alone), and a one-time-code field. Each field is the
  // best-ranked candidate the user can see (see `fillBlocker`). Returns
  // `{filled}` with what went in; when nothing could be filled,
  // `{refused}` with the reason the first candidate tried (password
  // fields go first) was passed over, or a throw when the page offers no
  // candidate at all.
  function fill(username, password, otp) {
    // Single deep traversal: collect every `<input>` reachable from
    // the document, including across open shadow boundaries. The
    // rank* helpers below filter this pool by type / role rather
    // than walking the DOM a second time.
    const allInputs = queryAllDeep(document, "input");
    const refusals = [];
    const passwordInput = firstFillable(
      rankPasswordInputs(allInputs),
      refusals,
    );
    // Without a password field the page is the first step of a
    // multi-step login (email page → password page): the username goes
    // in alone and `password: false` tells the popup to have the user
    // reopen it on the next page.
    const usernameInput = username
      ? firstFillable(
          passwordInput
            ? rankUsernameInputsFor(passwordInput, allInputs)
            : rankStandaloneUsernameInputs(allInputs),
          refusals,
        )
      : null;
    // A one-time code can sit on the same page as the credentials or on
    // a standalone 2FA step.
    const otpInput = otp
      ? firstFillable(rankOtpInputs(allInputs), refusals)
      : null;
    if (!passwordInput && !usernameInput && !otpInput) {
      if (refusals.length > 0) {
        return { refused: refusals[0] };
      }
      throw new Error("No password input found on this page");
    }
    if (otpInput) {
      assignInput(otpInput, otp);
    }
    if (usernameInput) {
      assignInput(usernameInput, username);
    }
    if (passwordInput && password) {
      assignInput(passwordInput, password);
    }
    return {
      filled: {
        username: Boolean(usernameInput),
        password: Boolean(passwordInput && password),
        otp: Boolean(otpInput),
      },
    };
  }

  // The first of `ranked` that can take a fill, or null. Every candidate
  // passed over adds its reason to `refusals`.
  function firstFillable(ranked, refusals) {
    for (const el of ranked) {
      const blocker = fillBlocker(el);
      if (blocker === null) {
        return el;
      }
      refusals.push(blocker);
    }
    return null;
  }

  // Effective opacity (the product over the element and its ancestors)
  // below which a field counts as invisible.
  const MIN_EFFECTIVE_OPACITY = 0.1;

  // Why `el` cannot take a credential right now, or null when it can:
  // "hidden" when it or an ancestor is not rendered, has no size or is
  // (nearly) transparent, "offscreen" when scrolling cannot bring its
  // centre into the viewport, "covered" when another element is what
  // the user would hit at its centre. A page that hides a field or lays
  // something over it would collect a credential the user cannot see go
  // in.
  function fillBlocker(el) {
    if (isConcealed(el)) {
      return "hidden";
    }
    if (!isCentreInViewport(el)) {
      el.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "instant",
      });
      if (!isCentreInViewport(el)) {
        return "offscreen";
      }
    }
    if (!isTopmostAtCentre(el)) {
      return "covered";
    }
    return null;
  }

  function isConcealed(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return true;
    }
    const shown = el.checkVisibility?.({
      opacityProperty: true,
      visibilityProperty: true,
    });
    if (shown === false) {
      return true;
    }
    // `visibility` inherits, so the element's own computed value already
    // reflects its ancestors; `display` and `opacity` do not.
    const visibility = window.getComputedStyle(el).visibility;
    if (visibility === "hidden" || visibility === "collapse") {
      return true;
    }
    let opacity = 1;
    for (let node = el; node; node = renderedParent(node)) {
      const style = window.getComputedStyle(node);
      if (style.display === "none") {
        return true;
      }
      const own = Number.parseFloat(style.opacity);
      if (!Number.isNaN(own)) {
        opacity *= own;
      }
    }
    return opacity < MIN_EFFECTIVE_OPACITY;
  }

  // The element `node` renders inside: the slot a light-DOM child is
  // assigned to, else its parent element, else the host of its shadow
  // root, else null at the top of the document.
  function renderedParent(node) {
    return (
      node.assignedSlot ?? node.parentElement ?? node.getRootNode().host ?? null
    );
  }

  function centreOf(el) {
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function isCentreInViewport(el) {
    const { x, y } = centreOf(el);
    return x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
  }

  // Whether `el`, or a label that belongs to it, is what the user would
  // hit at `el`'s centre. The document reports only the outermost shadow
  // host at a point, so the hit descends through open shadow roots.
  function isTopmostAtCentre(el) {
    const { x, y } = centreOf(el);
    let hit = document.elementFromPoint(x, y);
    while (hit && hit !== el && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (inner === null || inner === hit) {
        break;
      }
      hit = inner;
    }
    return hit === el || hit?.closest("label")?.control === el;
  }

  // The one-time-code fields in fill order: those carrying the explicit
  // web standard (`autocomplete="one-time-code"`) first, then the other
  // inputs that name a one-time code, most visible first.
  function rankOtpInputs(allInputs) {
    const candidates = allInputs.filter(
      (el) => acceptsInput(el) && looksLikeOtp(el),
    );
    const standard = candidates.filter(
      (el) => el.autocomplete === "one-time-code",
    );
    const rest = candidates.filter((el) => !standard.includes(el));
    return [...standard, ...byVisibility(rest)];
  }

  // Password fields in fill order: the focused one, then by viewport
  // visibility so a "change password" form deep in the page does not
  // win over a visible login form above the fold.
  function rankPasswordInputs(allInputs) {
    return focusedFirst(
      allInputs.filter((el) => el.type === "password" && acceptsInput(el)),
    );
  }

  // `candidates` with the focused one first and the rest by viewport
  // visibility.
  function focusedFirst(candidates) {
    const focused = activeElementDeep();
    const rest = byVisibility(candidates.filter((el) => el !== focused));
    return candidates.includes(focused) ? [focused, ...rest] : rest;
  }

  // `candidates` sorted by `visibilityScore`, most visible first; the
  // sort is stable, so equally visible inputs keep document order.
  function byVisibility(candidates) {
    return [...candidates].sort(
      (a, b) => visibilityScore(b) - visibilityScore(a),
    );
  }

  // Username fields that go with `passwordInput`, in fill order: those
  // sharing its form, or every input when it has none, closest preceding
  // candidate first.
  function rankUsernameInputsFor(passwordInput, allInputs) {
    const form = passwordInput.form;
    // `form.elements` only sees regular form-associated inputs, not
    // those buried in a shadow root inside the form. For the form
    // case we accept that limitation (custom elements that own their
    // own form-associated inputs are rare); for the form-less case
    // (the common shadow-DOM scenario — the input has no `.form`
    // because the host is in a shadow tree) we reuse the
    // already-collected `allInputs` pool rather than re-walking the
    // tree.
    const pool = form
      ? Array.from(form.elements).filter((el) => el instanceof HTMLInputElement)
      : allInputs;
    const candidates = pool.filter(
      (el) => el !== passwordInput && acceptsInput(el) && looksLikeUsername(el),
    );
    // Candidates preceding the password input come first, the closest
    // one leading; the rest follow in document order.
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
    const after = candidates.filter((el) => !before.includes(el));
    return [...before.reverse(), ...after];
  }

  // Username fields for pages with no password input (the first step of
  // a multi-step login), in the same order as password fields.
  function rankStandaloneUsernameInputs(allInputs) {
    return focusedFirst(
      allInputs.filter((el) => acceptsInput(el) && looksLikeUsername(el)),
    );
  }

  // Recursive `querySelectorAll` that descends into every open shadow
  // root reachable from `root`. Closed shadow roots cannot be inspected
  // by outside JS — including content scripts running in their isolated
  // world — and are silently skipped; a site that hides its login form
  // inside a closed shadow root effectively opts out of autofill.
  //
  // The walk uses a `TreeWalker` filtered to shadow-host elements
  // rather than `root.querySelectorAll("*")`. Both approaches visit
  // every element under the hood, but the filter runs in C++ and the
  // JS-visible iteration is over shadow hosts only (typically a
  // handful), where the NodeList approach forced JS to iterate every
  // element in the tree just to dereference `.shadowRoot`. For a
  // Lit / Stencil / LWC app with thousands of components, that's the
  // difference between low milliseconds and microseconds per fill.
  function queryAllDeep(root, selector) {
    const matches = Array.from(root.querySelectorAll(selector));
    const ownerDoc = root.ownerDocument ?? document;
    const walker = ownerDoc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        return node.shadowRoot
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });
    for (let host = walker.nextNode(); host; host = walker.nextNode()) {
      matches.push(...queryAllDeep(host.shadowRoot, selector));
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

  // Substring hints we scan in `id` / `name` / `placeholder` /
  // `autocomplete` / `aria-label` of candidate inputs. English forms
  // cover the bulk of sites because developer-facing attribute names
  // stay in English even on heavily-localised products; the
  // additional European-language entries below catch user-facing
  // `placeholder` and `aria-label` text on sites that localise those
  // surfaces. The list is intentionally European-Latin only —
  // matching is substring-includes against a lowercased haystack, so
  // adding CJK characters here would require Unicode-safe casing and
  // wider false-positive review for marginal coverage gains (most
  // CJK sites still use English-derived attribute names).
  const USERNAME_HINTS = [
    // English
    "user",
    "username",
    "login",
    "email",
    "account",
    "ident",
    // German — covers placeholder text like "Benutzername", "Konto",
    // "Anmelden".
    "benutzer",
    "konto",
    "anmeld",
    // French — covers "utilisateur", "connexion", "compte",
    // "courriel". The single substring "ateur" would also match
    // "utilisateur" but risks over-matching on shorter strings.
    "utilisateur",
    "connexion",
    "compte",
    "courriel",
    // Spanish — covers "usuario", "cuenta", "correo". "ingreso" is
    // deliberately absent: as a noun it overwhelmingly labels income
    // fields ("Ingresos mensuales") on financial forms, and the
    // login-verb forms ("ingresar", "ingresá", "ingrese") don't
    // contain the substring anyway — the hint would carry mostly
    // false-positive weight.
    "usuario",
    "cuenta",
    "correo",
    // Italian — covers "utente" and "accesso". (English "access" is
    // NOT matched by "accesso" — substring inclusion needs the
    // haystack to contain the full hint, and "access" is shorter.)
    "utente",
    "accesso",
    // Portuguese — covers "usuário" and "acessar". `usuario` from
    // Spanish also matches the unaccented form.
    "acessar",
  ];

  // Veto terms: a candidate whose haystack matches a USERNAME_HINT
  // but ALSO matches one of these is rejected. The hints are
  // substring heuristics, and several of them collide with
  // financial-form labels built on the same stem — German
  // "Kontonummer" (bank account number) contains "konto", English
  // "account number" contains "account", Spanish "número de cuenta"
  // contains "cuenta". Filling a username into an IBAN or
  // account-number field is the most damaging false positive this
  // heuristic can produce, so number-ish and amount-ish words veto
  // the match outright.
  const USERNAME_VETO_HINTS = [
    "number",
    "nummer",
    "numero",
    "número",
    "iban",
    "amount",
    "betrag",
    "importe",
    "importo",
    "montant",
  ];

  const USERNAME_TYPES = new Set(["text", "email", "tel", "url", ""]);

  // Hints that an input is a one-time / 2FA code field. Kept deliberately
  // tight and English-centric (HTML field names stay English even on
  // localised sites): mis-filling a TOTP code into an unrelated field both
  // fails the login and leaks the current code, so precision matters more
  // than recall here. The web-standard `autocomplete="one-time-code"` is the
  // strong primary signal handled in `rankOtpInputs`; these cover fields that
  // predate or omit it. Bare `code` / `token` are excluded as too broad
  // (coupon, area, zip, …).
  const OTP_HINTS = [
    "otp",
    "totp",
    "2fa",
    "mfa",
    "one-time",
    "onetime",
    "one_time",
    "passcode",
    "authenticator",
    "authcode",
    "auth-code",
    "auth_code",
    "verificationcode",
    "verification-code",
    "verification_code",
    "securitycode",
    "security-code",
    "security_code",
  ];

  // OTP codes are short digit/alphanumeric strings, so the field is a text /
  // tel / number input (never a password, which would mask the code).
  const OTP_TYPES = new Set(["text", "tel", "number", ""]);

  // Input types whose focus counts for the popup's frame-picking:
  // everything a fill could target — username-capable types plus
  // password fields.
  const FILLABLE_FOCUS_TYPES = new Set([...USERNAME_TYPES, "password"]);

  // Whether the element focused in this document (seen through open
  // shadow roots) is an input a fill could target.
  function hasEditableFocus() {
    const active = activeElementDeep();
    return (
      active instanceof HTMLInputElement &&
      FILLABLE_FOCUS_TYPES.has(active.type.toLowerCase())
    );
  }

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
    if (!USERNAME_HINTS.some((hint) => haystack.includes(hint))) {
      return false;
    }
    return !USERNAME_VETO_HINTS.some((veto) => haystack.includes(veto));
  }

  function looksLikeOtp(el) {
    const type = el.type.toLowerCase();
    if (!OTP_TYPES.has(type)) {
      return false;
    }
    // The web standard is authoritative on its own — a site that sets it has
    // told the browser exactly what this field is for.
    if (el.autocomplete === "one-time-code") {
      return true;
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
    return OTP_HINTS.some((hint) => haystack.includes(hint));
  }

  // Whether `el` takes typed input at all. Whether the user can see it
  // is `fillBlocker`'s question.
  function acceptsInput(el) {
    return !el.disabled && !el.readOnly && el.type !== "hidden";
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
  //
  // Save and restore each longhand individually rather than the
  // `outline` shorthand. CSSOM serialises the shorthand to the empty
  // string when only some longhands are set inline — saving "" and
  // assigning "" back on restore would clear all three longhands and
  // wipe out any per-property inline rule the page had configured.
  // Per-longhand save/restore puts whatever the page had set back
  // exactly where it was, and leaves any unset longhand empty so the
  // page's stylesheet rules take over again.
  function pulse(el) {
    const previousWidth = el.style.outlineWidth;
    const previousStyle = el.style.outlineStyle;
    const previousColor = el.style.outlineColor;
    const previousOffset = el.style.outlineOffset;
    el.style.outlineWidth = "2px";
    el.style.outlineStyle = "solid";
    el.style.outlineColor = PULSE_OUTLINE_COLOR;
    el.style.outlineOffset = "0";
    setTimeout(() => {
      el.style.outlineWidth = previousWidth;
      el.style.outlineStyle = previousStyle;
      el.style.outlineColor = previousColor;
      el.style.outlineOffset = previousOffset;
    }, 600);
  }

  // The port is the only channel a credential arrives on: nothing fires
  // until the popup sends `{type: "fill"}` over it, and a page script
  // cannot reach it from the page's own JavaScript world. It opens last
  // because the ready message reads the `const`s declared above.
  const port = api.runtime.connect({ name: FRAME_PORT_NAME });
  port.onMessage.addListener((message) => {
    if (message?.type !== "fill") {
      return;
    }
    let reply;
    try {
      const result = fill(
        message.username ?? "",
        message.password ?? "",
        message.otp ?? "",
      );
      reply = result.refused
        ? {
            ok: false,
            reason: result.refused,
            error: `The field to fill is ${result.refused}`,
          }
        : { ok: true, ...result };
    } catch (err) {
      reply = { ok: false, error: err?.message ?? String(err) };
    }
    port.postMessage({ type: "fill-result", ...reply });
  });
  // Read-only facts the popup uses to try the frame the user was working
  // in first. Opening the popup takes the window focus, so
  // `document.hasFocus()` is nearly always false by now; the element that
  // held focus in this document stays `activeElement`, though, which is
  // what `editableFocused` reports.
  port.postMessage({
    type: "ready",
    focused: document.hasFocus(),
    editableFocused: hasEditableFocus(),
  });

  return true;
})();
