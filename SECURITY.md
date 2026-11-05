<!--
SPDX-FileCopyrightText: The pasejo Authors
SPDX-License-Identifier: 0BSD
-->

# Security model

This document describes the trust boundaries the pasejo web extension
operates within — what it defends against, and which exposures are
inherent to the browser's extension platform and therefore accepted
rather than mitigated. Read it before filing a security report: if
your finding falls under one of the accepted boundaries below, it is
a known property of the design, not a vulnerability.

## What the extension defends

* **Credentials never leave your machine.** The extension makes no
  network requests. Credentials travel exactly one hop: from the
  `pasejo browser host` process over the native-messaging stdio pipe
  into the extension, and from there into the input fields of the
  page you asked to fill. See [PRIVACY.md](PRIVACY.md).
* **Credentials are never written to browser storage.** Only the
  store-name-per-hostname preference is persisted; secrets live in
  memory for the duration of a popup interaction.
* **Pages cannot trigger a fill.** The content script's message
  listener is intra-extension only (`runtime.onMessage`; there is no
  `onMessageExternal` handler). Every fill starts from an explicit
  user click in the extension popup.
* **Host replies are validated at the IPC boundary.** The background
  script enforces size/depth limits and per-action type checks on
  everything the native host sends before the popup renders it, so a
  corrupted or version-skewed host binary cannot freeze or confuse
  the UI.
* **Error messages are redacted host-side.** The `pasejo browser
  host` replaces absolute filesystem paths (store file, identity
  files) with `<store>` / `<identity>` placeholders before an error
  reaches the popup, keeping paths off shared screens and out of
  support screenshots. This is defence in depth, not a guarantee —
  see the pasejo repository for details.

## Accepted boundaries

These are properties of the browser extension platform itself. The
extension cannot fix them without making itself useless, and other
autofill extensions share them.

### A page can detect that the extension is installed

The content script is injected into every `http(s)` frame
(`matches: ["<all_urls>"]`). A page cannot *talk* to it, but a
sufficiently motivated page could infer its presence — for example by
observing the brief outline pulse on an input after a fill, or by
fingerprinting timing side effects. The alternative — asking the user
to grant per-site permissions before every fill — trades a marginal
fingerprinting surface for a substantially worse and *less* safe UX
(permission-fatigue trains users to click "allow" reflexively).

### Another extension can read filled credentials

Once a credential is filled into a page's input, any other installed
extension with content-script access to that page can read the
input's `.value`. This is inherent to the browser extension model:
all extensions with host permissions on a page share the same DOM.
pasejo cannot protect a credential from software the user has chosen
to install with page access. Audit your installed extensions; that
boundary belongs to the browser, not to pasejo.

### The native-messaging manifest decides which binary runs

The browser resolves the host name `wtf.metio.pasejo` through a
per-user manifest file (e.g.
`~/.mozilla/native-messaging-hosts/wtf.metio.pasejo.json`) and runs
whatever binary that manifest points to. An attacker with write
access to your home directory can repoint the manifest at a
malicious binary — but an attacker with that access can equally
replace the pasejo CLI itself, your shell profile, or your ssh keys.
The extension's trust anchor is your user account's filesystem
integrity, the same anchor every locally-installed program shares.

## Reporting a vulnerability

If you find an issue that is *not* covered by the accepted
boundaries above, please report it privately via
[GitHub security advisories][advisories] rather than a public issue.

[advisories]: https://github.com/metio/pasejo-web-extension/security/advisories/new
