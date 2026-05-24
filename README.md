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

## Known limitations

* **No clipboard auto-clear.** The CLI clears the clipboard a configurable
  number of seconds after `pasejo secret show --clip`; the extension does
  not yet do the equivalent. MV3 service workers can't call `navigator.clipboard.*`
  directly, so a proper auto-clear needs Chromium's `offscreen` API (which
  Firefox lacks) — until both ends grow a clean cross-browser path, copied
  credentials stay in the clipboard until something else overwrites them.
* **No keyboard shortcut for filling.** Click-only for now.
* **No per-domain store preference.** The popup's *Store* dropdown selects
  a store per-popup; the choice is not persisted.

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

Browsers spawn the host with a stripped environment, so `PASEJO_CONFIG`,
`PASEJO_DEFAULT_STORE`, and `SSH_AUTH_SOCK` may not be inherited. Pin them
via `--env`, which bakes `export` lines into the generated wrapper script:

```sh
pasejo browser install-manifest --browser firefox \
  --env "PASEJO_DEFAULT_STORE=work" \
  --env "SSH_AUTH_SOCK=/run/user/1000/keyring/ssh"
```

## Loading the extension

```sh
./package.sh        # produces dist/firefox/ and dist/chromium/
```

* **Firefox** — open `about:debugging#/runtime/this-firefox`, click
  *Load Temporary Add-on*, point it at `dist/firefox/manifest.json`.
* **Chromium-family** — open `chrome://extensions`, enable Developer mode,
  click *Load unpacked*, point it at `dist/chromium/`. After the extension
  loads, copy the **ID** the page shows for it (32-character string under
  the *pasejo* card) — you need it for `--extension-id` when installing
  the native-messaging manifest below.

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

## Manual test checklist

There is no automated browser test yet — exercise the full chain manually
after any change to the extension or to `pasejo browser host`.

**Once-off setup (per browser):**

1. `./package.sh` to build `dist/firefox/` and `dist/chromium/`.
2. Load the unpacked extension (instructions above) and copy the
   Chromium-family extension id if applicable.
3. Run `pasejo browser install-manifest --browser <name> [--extension-id <id>]`
   and confirm the wrapper script + manifest paths it logs.
4. Make sure the configured store has at least one identity that the host
   can decrypt without a passphrase — typically a key loaded into
   ssh-agent.

**Smoke test (run for both Firefox and Chromium):**

* Open the popup on an HTTPS page whose host matches a stored secret.
  Expect the matching secret(s) to appear within ~1 s.
* Switch to a different store in the dropdown. Expect the results list to
  re-query.
* Click the "Refresh" button. Expect the dropdown and results list to
  both re-fetch.
* Click the row (anywhere outside the buttons). Expect the credentials to
  fill into the active page, the status to read *Filled …*, and the popup
  to auto-close ~600 ms later.
* Click "Copy user" / "Copy pw". Expect the value in the clipboard and the
  popup to stay open.
* Open the popup on a page with no matching secret. Expect *No matches for
  …*, no error.
* With the store file removed (`mv ~/store ~/store.bak`), open the popup.
  Expect *The store file could not be opened or locked.* (`store_unreachable`).
* With a deliberately failing pull hook configured, open the popup. Expect
  *A pasejo pull hook failed before the store could be read.* (`hook_failed`).

If any step fails or produces an unexpected error kind, capture the
browser's devtools console for the popup AND the background page before
reporting — those are the only two places a JS-side error surfaces.

## Repository layout

```
src/                 Source files served verbatim from the extension
  background.js      Service-worker / event-page driver for the native host
  popup/             Toolbar popup: query, results list, fill action
  content/fill.js    Content script that fills username + password
  protocol.js        Shared protocol constants
manifests/           Per-browser manifest.json files
icons/               Toolbar icons; edit pasejo.svg, then run make-icons.sh
package.sh           Copies src/ + the right manifest into dist/<browser>/
```
