// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

// Loaded as a classic script (Firefox event page) or via
// `importScripts` (Chromium service worker), so this file installs its
// exports on `globalThis` rather than using ES module syntax.
(function installPasejoProtocol(scope) {
  scope.PASEJO = Object.freeze({
    // Native-messaging host registered by `pasejo browser install-manifest`.
    // Must match `HOST_NAME` in the pasejo install-manifest module.
    NATIVE_HOST: "wtf.metio.pasejo",

    // Request actions accepted by `pasejo browser host`.
    ACTION: Object.freeze({
      Query: "query",
      ListStores: "list_stores",
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
    }),

    // Popup copy per error kind. Anything outside this map falls back to
    // a generic message plus the host-supplied `hint`.
    ERROR_COPY: Object.freeze({
      unknown_store:
        "The selected store does not exist in your pasejo configuration.",
      no_store_configured:
        "No pasejo store is configured. Run `pasejo store add` first.",
      identity_locked:
        "Could not decrypt the store. Add the age identity to ssh-agent — the host cannot prompt for a passphrase.",
      hook_failed:
        "A pasejo pull hook failed before the store could be read. Check the hook command and the network.",
      store_unreachable:
        "The store file could not be opened or locked. Check it exists and that you have read permission.",
      decode_error:
        "The host could not decode the request. Update the extension or the pasejo binary.",
    }),

    // Cross-browser binding for the WebExtensions API. Firefox exposes
    // `browser`; Chromium-family browsers only expose `chrome`. The
    // shapes we use (runtime ports, tabs.query, tabs.sendMessage) are
    // event-driven and identical across both, so we just pick whichever
    // global is defined.
    api: scope.browser ?? scope.chrome,
  });
})(globalThis);
