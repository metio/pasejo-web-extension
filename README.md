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
store and one identity the host can use without a terminal (see
*Identities* below). The extension speaks version 2 of the
`pasejo browser host` protocol and refuses to work with a `pasejo`
release that speaks another version.

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

   Repeat with `--browser brave / chromium / edge / vivaldi / opera`
   as needed (see *Supported browsers* below). Browsers spawn the host
   with a stripped environment, so if your `pasejo` config, default
   store, or graphical pinentry is not found from the defaults, pass
   `--env KEY=VALUE` to bake those into the wrapper:

   ```sh
   pasejo browser install-manifest --browser firefox \
     --env "PASEJO_DEFAULT_STORE=work" \
     --env "PINENTRY_PROGRAM=/usr/bin/pinentry-gnome3"
   ```

3. **Open a website you have a credential for**, click the pasejo
   toolbar icon (or press **Ctrl+Shift+L** / **⌘+Shift+L**), and pick a
   match. Click *Fill* (or click the row) to fill the username and
   password into the page. The popup remembers which store you picked
   for that hostname and restores it next time.

## Releasing a credential

The list of matches carries no password and no one-time code: the
host answers the popup's search with names, usernames and URLs only.
Picking a match asks the host to release that one credential for the
hostname of the page the popup opened on. The host decrypts the store
again, checks that the secret still matches that hostname, and only
then returns the password, which goes straight into the page. A secret
that no longer matches is refused with *The host did not release this
credential for this site*.

The fill puts a credential only into fields you can see. A field that
is hidden, transparent, outside the page's scrollable area or covered
by another element is skipped; when no visible field is left, nothing
is filled and the popup says which of these it found.

## Page access

The extension holds no standing access to websites. It asks for
`activeTab`, `scripting`, `nativeMessaging`, and `storage`, and no host
permissions, so installing it grants no access to any site.

* **Opening the popup** — by clicking the toolbar icon or pressing the
  shortcut — grants `activeTab` for the tab you opened it on. The
  popup then reads that tab's URL to search your store for its
  hostname.
* **Picking a match** injects the fill script into the tab with
  `scripting.executeScript`: into the page itself and into frames on
  the page's own origin. Under `activeTab` the browser keeps frames
  from other origins out of reach, so a login form inside a
  cross-origin iframe cannot be filled.
* **Before a credential is released**, the extension checks that
  the tab still shows the origin the popup searched for, and that
  each frame's origin — as the browser reports it, not as the page
  claims it — matches the secret the same way the host matched it
  (the stored URL's exact host or registrable domain, or the secret's
  name for a secret without a URL). When that
  cannot be decided from the page's own host or the stored URL's
  host, the popup asks the host, which can mean one more decryption.
  Frames of other sites are skipped.
* **The grant ends** when the tab navigates to another origin or
  closes; Firefox ends it on any navigation that loads a new
  document. After that, reopen the popup on the new page.

Browsers do not let extensions run on some pages at all, such as
their own settings pages and add-on stores; the popup says so when you
try to fill there.

## Identities

The host decrypts the store on every query and has no terminal to ask
for a passphrase, so it skips passphrase-protected identities —
passphrase-encrypted age identity files and encrypted SSH keys — and the
popup shows an *identity locked* error when no remaining identity can
decrypt the store. An ssh-agent does not help, because pasejo reads SSH
keys from their files. For browser use, register an unencrypted
identity file (protected by file permissions and disk encryption) or a
plugin-backed identity such as one from `age-plugin-yubikey`. A plugin
that asks for a PIN uses pinentry when one is available; set
`PINENTRY_PROGRAM` to a graphical pinentry with `--env` as shown above.

## Supported browsers

The extension targets the latest stable releases below. Every
Chromium-family browser runs the **same** `dist/chromium` build —
Edge, Brave, Vivaldi, and Opera are all Chromium under the hood, so
there is no Edge-specific (etc.) build to maintain.

| Browser        | Build          | Notes                                           |
| -------------- | -------------- | ----------------------------------------------- |
| Firefox        | `dist/firefox` | Stable add-on id; `--extension-id` not needed   |
| Chrome         | `dist/chromium`|                                                 |
| Chromium       | `dist/chromium`|                                                 |
| Microsoft Edge | `dist/chromium`| Chromium-based; the Chrome build runs unchanged |
| Brave          | `dist/chromium`|                                                 |
| Vivaldi        | `dist/chromium`|                                                 |
| Opera          | `dist/chromium`|                                                 |

For any Chromium-family browser, load the `dist/chromium` build (from
its add-ons store once published, or unpacked) and register the host
with the **matching `--browser` name** plus `--extension-id <id>` —
the id is shown on the browser's extensions page after the unpacked
extension loads, or assigned by its store. The `--browser` name only
selects which per-user directory the manifest is written to; the
manifest content is identical across the Chromium family:

```sh
pasejo browser install-manifest --browser edge  --extension-id <id>
pasejo browser install-manifest --browser opera --extension-id <id>
```

`install-manifest` supports **Linux, macOS, and Windows**. On Linux and
macOS it writes the manifest into the browser's lookup directory; on
**Windows** it writes the manifest under the data directory and registers
an `HKEY_CURRENT_USER` value pointing at it (Windows browsers locate
native-messaging hosts through the registry), installing a `.cmd` wrapper
instead of a shell script. The Windows path is compile-verified but has not
yet been exercised on a real Windows machine, and the registry locations for
the Chromium *forks* (Brave, Vivaldi, Opera) are best-effort — Chrome, Edge,
Chromium, and Firefox use their vendors' documented keys. **Safari** is not
supported: its extensions use a different native-messaging model — an
app-bundled handler built with Xcode rather than a standalone host binary the
manifest points at.

## OTPs

If the matching secret has a TOTP entry under the same name and one of
its URL fields names the page's exact host, Fill also fills the site's
one-time-code field when the page has one — both on the login page and on
a standalone 2FA step (open the popup there and pick the match). A match
through a sibling subdomain or through the secret's name fills the
password without the code. Detection prefers the
`autocomplete="one-time-code"` standard, then a tight set of name hints,
so an unrelated code field (coupon, zip) is not mistaken for it. The
result list shows no code. When a fill releases a code and the page has
no field for it, the popup shows the code on the picked row as a manual
fallback and stays open. For auto-clearing-clipboard behaviour instead,
reach for `pasejo otp show --clip` from a terminal; the extension never
writes to the clipboard. (HOTP is not autofilled — emitting a
counter-based code without advancing the counter would break it.)

## Languages

The popup and its messages are localized to the same eight languages as the
`pasejo` CLI — English, German, Spanish, French, Italian, Japanese, Korean,
and Chinese. The browser picks the catalog matching its UI language and falls
back to English (`default_locale`) for anything it cannot match. Strings live
in `src/_locales/<lang>/messages.json`; English is the source of truth and a
test fails if any other language drifts from its key set.

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

## Known limitations

* **No inline suggestion picker in password fields.** The popup is the
  only entry point; some users prefer a 1Password-style dropdown
  inside the field itself. This is deliberate: the extension draws no
  UI inside web pages, which a page could overlay (see
  [SECURITY.md](SECURITY.md)).
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
files the extension ships are the files under test. The mock
WebExtensions `i18n.getMessage` is backed by the real
`_locales/en/messages.json`, so popup assertions see the exact strings
the extension renders, and `tests/locales.test.js` fails if any
translation drifts from the English key set or drops a placeholder.

```sh
npm install          # one-time
npm test             # run the suite once
npm run test:watch   # re-run on file changes
npm run coverage     # full run + v8 coverage report; the suite enforces 100% lines/branches/functions/statements
```

Coverage output lands in `coverage/` (gitignored). The default
`lcov` + HTML reporters write an `index.html` you can open to navigate
to any uncovered branch.

### End-to-end tests

`e2e/` holds a Playwright suite (`npm run test:e2e`) that drives a
headless Chromium with the unpacked `dist/chromium` build loaded and the
**real** `pasejo browser host` on the other end of native messaging — the
only configuration that catches protocol drift between this extension and
the Rust host. Each test registers the host with
`pasejo browser install-manifest` inside a throwaway home and browser
profile, serves pages at `example.com` and `evil.test` by request
interception, opens the toolbar popup with `chrome.action.openPopup()`, and
drives it over a CDP session (headless Chromium runs the popup but does not
hand it to Playwright as a page). It covers a top-frame fill released by a
`reveal` (with the password checked absent from the popup before the
click), the TOTP code released for the exact host, a fill into a
same-origin iframe, a cross-origin iframe the secret does not match being
skipped, a transparent decoy field passed over for the visible one, a
covered password field refused, and a fill refused after the tab
navigated to another site.

`openPopup()` is not a user gesture, so it grants no `activeTab`. The test
copies the extension and adds host permissions for exactly the two test
sites to the copy's manifest; the shipped manifests stay without host
permissions. That substitution means the suite does **not** cover the
`activeTab` grant itself — that the toolbar click or shortcut makes the page
reachable, and that cross-origin frames stay out of reach under
`activeTab` alone. The manual checklist below covers those. Firefox is not
covered by the suite either.

The `End-to-end` CI workflow downloads a released `pasejo` binary (the
latest release, or the tag in the `PASEJO_HOST_VERSION` repository
variable), bootstraps the store, and runs the suite. The binary has to
speak the protocol version the extension expects, so the suite fails
against a release that predates it. Run it locally with a store
bootstrapped the same way (see `.github/workflows/e2e.yml`), pointing
`PASEJO_BIN` at a `pasejo` build that speaks the same protocol:

```sh
./package.sh                                   # build dist/chromium first
npx playwright install chromium                # one-time
PASEJO_BIN="$(command -v pasejo)" \
  PASEJO_CONFIG=/path/to/test-config.toml \
  npm run test:e2e
```

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
  native-messaging host on demand. Single-store queries open one
  connection per request (no persistent port). Multi-store queries
  ("All stores" with N stores configured) stream: the popup opens a
  `runtime.connect` port to the background, the background fans the
  per-store queries out over a single native connection, and each
  store's reply is pushed back to the popup the moment it lands —
  the results list and the `(answered/total)` progress counter
  update store by store, so a YubiKey-blocked store doesn't gate
  the others on screen either. The extension and the host negotiate
  on `protocol_version` (currently `2`) and refuse to operate if
  the two sides disagree.
* When the user opens the popup, the extension sends a `query` request
  with the active tab's hostname and renders the returned matches,
  which carry metadata only.
* When the user picks a match, the popup sends a `reveal` request for
  that store, secret name and hostname. It does so once per fill, after
  the tab and frame checks, right before the first frame that may
  receive the credential gets it.
* Filling a credential injects `content/fill.js` into every frame of
  the tab the browser lets the extension reach. Each injected frame
  opens a `pasejo-frame` port back to the popup; the popup reads the
  frame's origin from the port's browser-stamped `sender`, skips
  frames whose origin the secret does not match, and sends the
  credential over the port of one frame at a time — the frame that
  held focus first. The fill script assigns the username and password
  into the focused form (or the first plausible form in its frame),
  skipping fields the user cannot see, and dispatches `input` /
  `change` events so framework-driven inputs notice.

There is no automatic fill on page load, no clipboard write without an
explicit user click, and no credential ever lands in `storage` — the
extension is purely a relay between the popup, the active tab, and
`pasejo browser host`.

## Manual test checklist

The Playwright e2e suite (above) covers the fill paths automatically. This
checklist exercises what it does not — the `activeTab` grant, Firefox,
error kinds, multi-store streaming, OTP — after any change to the extension
or to `pasejo browser host`.

**Once-off setup (per browser):**

1. `./package.sh` to build `dist/firefox/` and `dist/chromium/`.
2. Load the unpacked extension (see above) and copy the
   Chromium-family extension id if applicable.
3. Run `pasejo browser install-manifest --browser <name> [--extension-id <id>]`
   and confirm the wrapper script + manifest paths it logs.
4. Make sure the configured store has at least one identity the host
   can use without a terminal — an unencrypted age identity file or a
   plugin-backed identity (see *Identities* above).

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
* For a secret with a TOTP entry and a URL naming the page's exact
  host, expect no code in the result list. On a page without a
  one-time-code field, expect the fill to show *OTP: 123456* on the row
  and the popup to stay open; on a page with one, expect the code in
  the field.
* On a page whose only password field is transparent or covered by
  another element, expect *Nothing filled* with the reason and an
  empty field.
* Open the popup with the keyboard shortcut instead of the toolbar
  icon. Expect the same matches and a working fill.
* Open the popup on a page whose login form sits in a same-origin
  iframe. Expect the fill to land in the iframe.
* Open the popup on a page whose login form sits in an iframe from
  another site. Expect no fill into that iframe.
* Open the popup, navigate the tab to another site, then click a row.
  Expect *The page changed since pasejo opened …* and no fill.
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
  content/fill.js    Content script that fills username + password + OTP
  protocol.js        Shared protocol constants + i18n / storage helpers
  _locales/          Per-language messages.json (en is default_locale)
manifests/           Per-browser manifest.json files
icons/               Toolbar icons; edit pasejo.svg, then run make-icons.sh
package.sh           Copies src/ + the right manifest into dist/<browser>/
tests/               Vitest unit suite (happy-dom)
e2e/                 Playwright end-to-end suite (real Chrome + real host)
```
