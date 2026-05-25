<!--
SPDX-FileCopyrightText: The pasejo Authors
SPDX-License-Identifier: 0BSD
-->

# pasejo web extension

Browser extension that fills credentials from your local
[`pasejo`][pasejo] password store into web forms. Everything stays on
your machine: the extension talks over native messaging to a small
`pasejo browser host` process that re-decrypts the store on demand —
nothing is cached, nothing is sent over the network, no analytics, no
telemetry. See [PRIVACY.md](PRIVACY.md) for the full statement.

[pasejo]: https://github.com/metio/pasejo

## Quick start

Prerequisites: a working [pasejo][pasejo] install with at least one
store and one identity (an `age` key loaded into ssh-agent works
without prompting for a passphrase).

1. **Install the extension** from
   [Firefox Add-ons](https://addons.mozilla.org/) or the
   [Chrome Web Store](https://chrome.google.com/webstore/) — or load
   the unpacked `dist/firefox/` / `dist/chromium/` directory (see
   *Developing* below).
2. **Register the native-messaging host** so the browser is allowed to
   launch `pasejo browser host`:

   ```sh
   # Firefox:
   pasejo browser install-manifest --browser firefox

   # Chromium-family (replace <id> with the extension id shown on
   # chrome://extensions after the extension loads):
   pasejo browser install-manifest --browser chrome --extension-id <id>
   ```

   Repeat with `--browser brave / chromium / edge / vivaldi` as
   needed. Browsers spawn the host with a stripped environment, so if
   your `pasejo` config or ssh-agent socket lives off the default path,
   pass `--env KEY=VALUE` to bake those into the wrapper:

   ```sh
   pasejo browser install-manifest --browser firefox \
     --env "PASEJO_DEFAULT_STORE=work" \
     --env "SSH_AUTH_SOCK=/run/user/1000/keyring/ssh"
   ```

3. **Open a website you have a credential for**, click the pasejo
   toolbar icon (or press **Ctrl+Shift+L** / **⌘+Shift+L**), and pick a
   match. Click *Fill* (or click the row) to inject the username and
   password into the page. The popup remembers which store you picked
   for that hostname and restores it next time.

## OTPs

If the matching secret has a TOTP entry under the same name, the popup
shows the current 6-digit code as read-only text. Type it into the
site's 2FA field, or — if you want auto-clearing-clipboard behaviour —
reach for `pasejo otp show --clip` from a terminal. The extension
itself doesn't write to the clipboard.

## Keyboard shortcut

The default shortcut is **Ctrl+Shift+L** (**⌘+Shift+L** on macOS).
Rebind it from `chrome://extensions/shortcuts` (Chromium-family) or
*about:addons → ⚙ → Manage Extension Shortcuts* (Firefox).

## Selecting a store

The host follows the same store-resolution chain as every other
`pasejo` command: `PASEJO_DEFAULT_STORE` env → config `default_store` →
first store in the configuration. To target a non-default store from
the popup, pick it from the *Store* dropdown. The choice is remembered
per-hostname in `chrome.storage.local` and restored next time. With
more than one store configured, an *All stores* entry appears at the
top of the dropdown that fans out the query across every store and
merges the results.

Encrypted age identities cannot be unlocked from the host because there
is no TTY to read a passphrase from; the popup surfaces this as an
*identity locked* error. Use ssh-agent as the identity source so the
host can decrypt without prompting.

## Known limitations

* **No inline suggestion picker in password fields.** The popup is the
  only entry point; some users prefer a 1Password-style dropdown
  inside the field itself.
* **No save-new-credential flow.** Read-only for now — adding a new
  secret still goes through the CLI.

## Privacy

The extension does not collect any data. See [PRIVACY.md](PRIVACY.md)
for the per-permission breakdown.

---

# Developing

## Building locally

```sh
./package.sh        # produces:
                    #   dist/firefox/             (load-unpacked dir)
                    #   dist/chromium/            (load-unpacked dir)
                    #   dist/pasejo-firefox.xpi   (AMO submission archive)
                    #   dist/pasejo-chromium.zip  (Chrome Web Store submission)
```

Lint the Firefox bundle before submission:

```sh
web-ext lint --source-dir=dist/firefox
```

CI runs the same `package.sh` + `web-ext lint` on every PR and
publishes the artifacts under the workflow run. Push a `vX.Y.Z` tag to
trigger the release workflow, which attaches the same archives to a
GitHub Release.

## Tests

The unit suite lives under `tests/`. It uses
[Vitest](https://vitest.dev) on top of
[`happy-dom`](https://github.com/capricorn86/happy-dom) for the
DOM-touching files (popup, content script) and a stubbed WebExtensions
API for the background script. All four source files
(`protocol.js`, `background.js`, `popup/popup.js`, `content/fill.js`)
are loaded as classic scripts via `vm.compileFunction` so the same
files the extension ships are the files under test.

```sh
npm install          # one-time
npm test             # run the suite once
npm run test:watch   # re-run on file changes
npm run coverage     # full run + v8 coverage report; the suite enforces 100% lines/branches/functions/statements
```

Coverage output lands in `coverage/` (gitignored). The default
`lcov` + HTML reporters write an `index.html` you can open to navigate
to any uncovered branch.

## Loading the unpacked extension

* **Firefox** — open `about:debugging#/runtime/this-firefox`, click
  *Load Temporary Add-on*, point it at `dist/firefox/manifest.json`.
* **Chromium-family** — open `chrome://extensions`, enable Developer
  mode, click *Load unpacked*, point it at `dist/chromium/`. After the
  extension loads, copy the **ID** the page shows for it (32-character
  string under the *pasejo* card) — you need it for `--extension-id`
  when running `pasejo browser install-manifest --browser chrome ...`.

Pin the extension to the toolbar so the popup is one click away.

## Architecture

* The extension's background page connects to the `wtf.metio.pasejo`
  native-messaging host on demand (one connection per popup request,
  no persistent port).
* When the user opens the popup, the extension sends a `query` request
  with the active tab's hostname and renders the returned matches.
* Filling a credential sends a message to the active tab's content
  script (fanned out across all frames so SSO iframes work), which
  assigns the username and password into the focused form (or the
  first plausible form on the page) and dispatches `input` / `change`
  events so framework-driven inputs notice.

There is no automatic fill on page load, no clipboard write without an
explicit user click, and no credential ever lands in `storage` — the
extension is purely a relay between the popup, the active tab, and
`pasejo browser host`.

## Manual test checklist

There is no automated browser test yet — exercise the full chain
manually after any change to the extension or to `pasejo browser host`.

**Once-off setup (per browser):**

1. `./package.sh` to build `dist/firefox/` and `dist/chromium/`.
2. Load the unpacked extension (see above) and copy the
   Chromium-family extension id if applicable.
3. Run `pasejo browser install-manifest --browser <name> [--extension-id <id>]`
   and confirm the wrapper script + manifest paths it logs.
4. Make sure the configured store has at least one identity that the
   host can decrypt without a passphrase — typically a key loaded into
   ssh-agent.

**Smoke test (run for both Firefox and Chromium):**

* Open the popup on an HTTPS page whose host matches a stored secret.
  Expect the matching secret(s) to appear within ~1 s.
* Switch to a different store in the dropdown. Expect the results list
  to re-query.
* Click the "Refresh" button. Expect the dropdown and results list to
  both re-fetch.
* Click the row (anywhere outside the Fill button). Expect the
  credentials to fill into the active page, the status to read
  *Filled …*, and the popup to auto-close ~600 ms later.
* For a secret with an OTP, expect *OTP: 123456* to appear in the
  row's secondary line and update when you reopen the popup after
  30 s.
* Open the popup on a page with no matching secret. Expect *No matches
  for …*, no error.
* With the store file removed (`mv ~/store ~/store.bak`), open the
  popup. Expect *The store file could not be opened or locked.*
  (`store_unreachable`).
* With a deliberately failing pull hook configured, open the popup.
  Expect *A pasejo pull hook failed before the store could be read.*
  (`hook_failed`).

If any step fails or produces an unexpected error kind, capture the
browser's devtools console for the popup AND the background page
before reporting — those are the only two places a JS-side error
surfaces.

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
