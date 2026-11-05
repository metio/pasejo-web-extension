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
* **No standing access to pages.** The manifests declare no host
  permissions and no content scripts. Opening the popup grants
  `activeTab` for the one tab it opened on; the fill script is injected
  only when the user picks a match, and only into the page and the
  frames the browser lets `activeTab` reach (frames on the page's own
  origin).
* **Pages cannot trigger a fill.** The injected fill script listens
  only on the `pasejo-frame` port it opens to the popup; there is no
  `onMessage` or `onMessageExternal` handler a page could reach. Every
  fill starts from an explicit user click in the extension popup.
* **Credentials go only to frames of the matched site.** Before a
  credential is sent, the popup checks each frame's origin as the
  browser stamps it on the frame's port (`sender.origin`, else the
  origin of `sender.url`) — never a value the page supplies. The
  frame's host has to match the secret under the host's rule: the
  page's own host (which the host matched to list the secret), the
  stored URL's exact host, or, for anything else, a fresh host query
  for the frame's host that returns the same secret. Opaque and
  non-`http(s)` origins never qualify. Under `activeTab` the browser
  already keeps cross-origin frames out of reach; the check holds even
  where a browser would inject further.
* **A fill targets the page the results were for.** The popup records
  the tab and origin it opened on and refuses to fill when the active
  tab, or its origin, has changed by the time a match is picked. Once
  the fill script runs, a top frame reporting another origin stops the
  fill as well, and the credential travels over a port bound to the
  injected document, so a frame that navigates away drops it.
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

### A page can tell that a fill happened

The fill script runs in a page only after the user picks a match for
it. A page cannot *talk* to the script, but it sees the result: the
values written into its inputs, the `input` / `change` events, and the
brief outline pulse on each filled input. A page the user fills can
therefore infer that an autofill extension is installed.

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
