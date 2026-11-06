// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

// Loaded as a classic script (Firefox event page) or via
// `importScripts` (Chromium service worker), so this file installs its
// exports on `globalThis` rather than using ES module syntax.
(function installPasejoProtocol(scope) {
  // Cross-browser binding for the WebExtensions API. Firefox exposes
  // `browser`; Chromium-family browsers only expose `chrome`. The shapes
  // we use (runtime ports, tabs.query, scripting, i18n.getMessage)
  // are identical across both, so we pick whichever global is defined.
  const api = scope.browser ?? scope.chrome;

  // Localized-string lookup. Wraps `i18n.getMessage` so every surface
  // (popup, background) resolves user-facing text the same way and the
  // browser picks the locale from `_locales/`, falling back to English.
  // Returns "" when the i18n API is unavailable so a caller never renders
  // `undefined`; substitutions are stringified to match the API contract.
  function t(key, ...subs) {
    const args = subs.length > 0 ? subs.map(String) : undefined;
    return api?.i18n?.getMessage(key, args) ?? "";
  }

  // Storage key holding the per-host remembered store. Value shape:
  //   { [hostname]: { store: string, lastUsedAt: number } }
  const HOST_STORE_KEY = "pasejo:host-stores";

  // Validate a stored host->store map, dropping any malformed entries.
  function coerceHostStoreMap(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }
    const out = {};
    for (const [hostname, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const store = entry.store;
      const lastUsedAt = entry.lastUsedAt;
      if (typeof store !== "string" || typeof lastUsedAt !== "number") {
        continue;
      }
      out[hostname] = { store, lastUsedAt };
    }
    return out;
  }

  // The store the user last chose for `hostname`, or null. Read-only and
  // failure-tolerant: any storage error yields null (no remembered choice).
  async function recallStoreForHost(api, hostname) {
    if (!hostname || !api?.storage?.local) {
      return null;
    }
    try {
      const result = await api.storage.local.get(HOST_STORE_KEY);
      const map = coerceHostStoreMap(result[HOST_STORE_KEY]);
      return map[hostname]?.store ?? null;
    } catch (_) {
      return null;
    }
  }

  scope.PASEJO = Object.freeze({
    // Native-messaging host registered by `pasejo browser install-manifest`.
    // Must match `HOST_NAME` in the pasejo install-manifest module.
    NATIVE_HOST: "wtf.metio.pasejo",

    // The single `protocol_version` value the extension knows how to
    // talk to. Mirrors `PROTOCOL_VERSION` in src/browser/protocol.rs;
    // the extension refuses to operate against any host that doesn't
    // report this exact number. Version 2 is the two-step release: a
    // `query` answers with metadata only and a `reveal` releases one
    // credential for one domain.
    PROTOCOL_VERSION: 2,

    // Storage key + helpers for the per-host remembered store (defined
    // above).
    HOST_STORE_KEY,
    coerceHostStoreMap,
    recallStoreForHost,

    // Request actions accepted by `pasejo browser host`.
    ACTION: Object.freeze({
      Query: "query",
      ListStores: "list_stores",
      Reveal: "reveal",
    }),

    // Error kinds the host can return. Mirrors `ErrorKind` in
    // src/browser/protocol.rs.
    ERROR_KIND: Object.freeze({
      UnknownStore: "unknown_store",
      UnknownAction: "unknown_action",
      DecodeError: "decode_error",
      IdentityLocked: "identity_locked",
      HookFailed: "hook_failed",
      StoreUnreachable: "store_unreachable",
      NoStoreConfigured: "no_store_configured",
      ResponseTooLarge: "response_too_large",
      NotMatched: "not_matched",
    }),

    // `_locales` message id per host error kind. Anything outside this
    // map falls back to a generic message plus the host-supplied `hint`.
    // The text itself lives in `_locales/<lang>/messages.json`; the popup
    // resolves a kind to its localized copy via `t(ERROR_MESSAGE_IDS[kind])`.
    ERROR_MESSAGE_IDS: Object.freeze({
      unknown_store: "errorUnknownStore",
      no_store_configured: "errorNoStoreConfigured",
      identity_locked: "errorIdentityLocked",
      hook_failed: "errorHookFailed",
      store_unreachable: "errorStoreUnreachable",
      decode_error: "errorDecodeError",
      response_too_large: "errorResponseTooLarge",
      not_matched: "errorNotMatched",
    }),

    // Localized-string lookup (see `t` above), exposed so the popup and
    // background resolve user-facing text through one seam.
    t,

    api,
  });
})(globalThis);
