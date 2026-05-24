<!--
SPDX-FileCopyrightText: The pasejo Authors
SPDX-License-Identifier: 0BSD
-->

# pasejo web extension

Browser extension that fetches credentials from a [`pasejo`][pasejo] password
store and fills them into web forms. The extension speaks the WebExtensions
native-messaging protocol to a long-lived `pasejo browser host` process; every
credential lookup re-decrypts the selected store under the standard `pasejo`
file lock, so concurrent CLI edits remain safe.

[pasejo]: https://github.com/metio/pasejo

## How it works

* The extension's background page connects to the `wtf.metio.pasejo`
  native-messaging host on demand.
* When the user opens the popup, the extension sends a `query` request with
  the active tab's domain and renders the returned matches.
* Filling a credential pushes a message to the active tab's content script,
  which assigns the username and password into the focused form (or the
  first plausible form on the page) and dispatches `input`/`change` events
  so framework-driven inputs notice.

There is no automatic fill on page load, no clipboard write without an
explicit user click, and no credential ever lands in `storage` — the
extension is purely a relay between the popup, the active tab, and
`pasejo browser host`.

## Installing the native-messaging host

`pasejo` writes the native-messaging manifest for you:

```sh
# Firefox: writes ~/.mozilla/native-messaging-hosts/wtf.metio.pasejo.json
pasejo browser install-manifest --browser firefox

# Chromium-family browsers (per browser):
pasejo browser install-manifest --browser chrome    --extension-id <chrome-id>
pasejo browser install-manifest --browser chromium  --extension-id <chromium-id>
pasejo browser install-manifest --browser brave     --extension-id <brave-id>
pasejo browser install-manifest --browser edge      --extension-id <edge-id>
pasejo browser install-manifest --browser vivaldi   --extension-id <vivaldi-id>
```

Pass `--print` to emit the manifest JSON to stdout instead of writing it to
disk. The Firefox extension uses the stable add-on id `pasejo@metio.wtf`,
so `--extension-id` is optional there; Chromium-family browsers compute the
extension id from the public key of the unpacked load, so it must be passed
explicitly.

## Loading the extension

```sh
./package.sh        # produces dist/firefox/ and dist/chromium/
```

* **Firefox** — open `about:debugging#/runtime/this-firefox`, click
  *Load Temporary Add-on*, point it at `dist/firefox/manifest.json`.
* **Chromium-family** — open `chrome://extensions`, enable Developer mode,
  click *Load unpacked*, point it at `dist/chromium/`.

Pin the extension to the toolbar so the popup is one click away.

## Selecting a store

The host follows the same store-resolution chain as every other `pasejo`
command: `PASEJO_DEFAULT_STORE` env → config `default_store` → first store
in the configuration. To target a non-default store from the popup, choose
it from the *Store* dropdown — the choice is per-session and not persisted.

Encrypted age identities cannot be unlocked from the host because there is
no TTY to read a passphrase from; the popup surfaces this as an
*identity locked* error. Use ssh-agent as the identity source so the host
can decrypt without prompting.

## Repository layout

```
src/                 Source files served verbatim from the extension
  background.js      Service-worker / event-page driver for the native host
  popup/             Toolbar popup: query, results list, fill action
  content/fill.js    Content script that fills username + password
  protocol.js        Shared protocol constants
manifests/           Per-browser manifest.json files
icons/               Toolbar icons (PNGs to be added)
package.sh           Copies src/ + the right manifest into dist/<browser>/
```
