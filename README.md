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

A secret can carry a fill policy in its own fields, stored encrypted
with it:

* `pasejo-fill: never` keeps the secret out of the browser entirely.
  The host leaves it out of every search and refuses to release it, so
  it never appears in the popup.
* `pasejo-fill: exact-host` lists and releases the secret only on the
  exact host of one of its URL fields, never on a sibling subdomain or
  through its name.
* `pasejo-confirm: always` makes the popup ask before every fill. Picking
  the match opens a prompt on its row naming the secret and the site;
  nothing is released until you choose *Fill now*, which stays inactive
  for half a second so a double-click on *Fill* cannot confirm. The host
  passes this flag along without enforcing it, so the confirmation is
  only as strong as the extension that asks.

When nothing in the store matches the page, the host also compares the
page's domain with the domains of your stored URLs. A domain that looks
like one of them — the same name with a swapped look-alike character
(`examp1e.com`, `rn` for `m`), a homoglyph from another script, one
character added, dropped or replaced, two neighbouring characters
swapped, or the same name under another public suffix — makes the popup warn that you have no login for this
site but one for the domain it resembles, and to check the address bar.
Internationalized domains are shown in their `xn--` form so the warning
cannot itself be spoofed by look-alike glyphs. The comparison runs in
the host on your machine; nothing leaves it.

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

### Security keys

A store encrypted to an identity on a security key — set up with
`age-plugin-yubikey` as described in pasejo's
[Yubikey guide](https://github.com/metio/pasejo/blob/main/docs/guides/how-to-use-yubikeys.md)
— works with the extension once that identity file is registered with
`pasejo identity add`. Every decryption goes through the key: the search
when the popup opens (once per store searched), the release when you
pick a match, and a search for a frame on another host of the same site
when the fill has to ask the host about it. Whether each of those needs a
touch follows the touch policy the identity was created with.

When a release takes longer than a second, the popup says it is
waiting for pasejo to decrypt the picked secret, asks you to touch the
key if your identity is on one, and marks the row busy. Searching *All
stores* answers store by store, so a store waiting for a touch does not
hold back the others. The extension waits up to 30 seconds for each
reply from the host.

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

## Verifying a release

Every GitHub Release carries `SHA256SUMS`, the SHA-256 hashes of
`pasejo-firefox.xpi` and `pasejo-chromium.zip`, and `SHA256SUMS.bundle`,
a cosign keyless signature made by the release workflow for that tag.
The archives are reproducible, so the same hashes come out of a build of
the tagged source.

Check the signature and the downloaded archives, with `<version>` the
release without its leading `v`:

```sh
cosign verify-blob SHA256SUMS \
  --bundle SHA256SUMS.bundle \
  --certificate-identity "https://github.com/metio/pasejo-web-extension/.github/workflows/release.yml@refs/tags/v<version>" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
sha256sum --ignore-missing -c SHA256SUMS
```

The first command proves the checksum file came from the release
workflow running on that tag; the second proves the archives in the
directory match it.

Rebuild the release from source and compare:

```sh
git clone https://github.com/metio/pasejo-web-extension
cd pasejo-web-extension
git checkout v<version>
./package.sh <version>
diff dist/SHA256SUMS /path/to/downloaded/SHA256SUMS
```

`package.sh` needs only a POSIX shell, the usual file utilities and
Info-ZIP `zip`, the program the release workflow uses on its Ubuntu
runner. The archive bytes depend on the compressor, so a different zip
implementation or version may produce different hashes from identical
contents.

Copies from the add-on stores do not match `SHA256SUMS` byte for byte,
because the stores add their own signatures. Compare their contents
with the rebuilt `dist/` directories instead. A Firefox Add-ons `.xpi`
carries its signature under `META-INF/`:

```sh
mkdir amo && unzip -q /path/to/pasejo.xpi -d amo
diff -r --exclude=META-INF amo dist/firefox
```

Firefox keeps an installed copy as `extensions/pasejo@metio.wtf.xpi` in
the profile directory. A Chromium-family browser keeps an installed
copy unpacked under its profile, in
`Extensions/<extension id>/<version>_0/`. A copy from the Chrome Web
Store carries an added `_metadata/` directory and an `update_url` key in
`manifest.json`, so expect `manifest.json` to differ by that key:

```sh
diff -r --exclude=_metadata ~/.config/google-chrome/Default/Extensions/<extension id>/<version>_0 dist/chromium
```

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
                    #   dist/SHA256SUMS           (hashes of both archives)
./package.sh 1.2.0  # the same, with version 1.2.0 in both built manifests
```

The archives are byte-reproducible: `package.sh` sorts their entries and
gives every file mode `0644` and one fixed timestamp, `SOURCE_DATE_EPOCH`
when set, else 1980-01-01. `tests/package.test.js` builds twice from
copies with different file times, modes, umask and time zone and checks
that the hashes agree.

Lint the Firefox bundle before submission:

```sh
web-ext lint --source-dir=dist/firefox
```

CI runs the same `package.sh` + `web-ext lint` on every PR and
publishes the artifacts under the workflow run. Push a `vX.Y.Z` tag to
trigger the release workflow, which runs `./package.sh X.Y.Z`, signs
`SHA256SUMS` with cosign keyless, and attaches the archives,
`SHA256SUMS` and `SHA256SUMS.bundle` to a GitHub Release (see
*Verifying a release* above).

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
profile, so the host runs through the generated wrapper and accepts only
the test extension's origin. It serves pages at `example.com`,
`evil.test`, `examp1e.com`, `confirm.test` and `slow.test` by request
interception, opens the toolbar popup with `chrome.action.openPopup()`, and
drives it over a CDP session (headless Chromium runs the popup but does not
hand it to Playwright as a page). It covers a top-frame fill released by a
`reveal` (with the password checked absent from the popup before the
click), the TOTP code released for the exact host, a fill into a
same-origin iframe, a cross-origin iframe the secret does not match being
skipped, a transparent decoy field passed over for the visible one, a
covered password field refused, a fill refused after the tab
navigated to another site, a `pasejo-fill: never` secret left out of the
list, a `pasejo-confirm: always` secret filled only after the prompt is
confirmed, the look-alike warning on `examp1e.com`, and the waiting state
of a slow reveal.

No test uses a security key. The slow reveal comes from a store whose
pull hook sleeps for two seconds, with hook throttling turned off so the
reveal waits as well as the search; that exercises the popup's waiting
state, not a plugin identity or a touch.

`openPopup()` is not a user gesture, so it grants no `activeTab`. The test
copies the extension and adds host permissions for exactly the test
sites to the copy's manifest; the shipped manifests stay without host
permissions. That substitution means the suite does **not** cover the
`activeTab` grant itself — that the toolbar click or shortcut makes the page
reachable, and that cross-origin frames stay out of reach under
`activeTab` alone. The manual checklist below covers those. Firefox is not
covered by the suite either.

The `End-to-end` CI workflow downloads a released `pasejo` binary (the
latest release, or the tag in the `PASEJO_HOST_VERSION` repository
variable), bootstraps the stores with `e2e/bootstrap-store.sh`, and runs
the suite. The binary has to speak the protocol version the extension
expects, so the suite fails against a release that predates it. Run it
locally with `PASEJO_BIN` pointing at a `pasejo` build that speaks the
same protocol. The bootstrap writes its configuration, identity and
stores into the directory you name, so keep that apart from your own
pasejo configuration:

```sh
./package.sh                                   # build dist/chromium first
npx playwright install chromium                # one-time
export PASEJO_BIN="$(command -v pasejo)"
PASEJO_CONFIG="$(e2e/bootstrap-store.sh "$(mktemp -d)")" npm run test:e2e
```

## Formal model

`model/` holds a [Quint](https://quint.sh) model of the extension's
security-relevant behaviour. `tests/model-replay.test.js` replays traces
of the model against the shipped popup and background scripts on every
`npm test`, so a change to either side that the other does not follow
fails the suite.

* `model/web.qnt`: origins as the browser reports them, the frames of
  the page's tab, and the `activeTab` grant for one tab and origin, which
  a navigation to another origin revokes. It has no notion of
  credentials, so a later module (WebAuthn, for one) can import it.
* `model/host.qnt`: two stores, the per-secret fill policy, the host's
  matcher, and what `query` and `reveal` return.
* `model/extension.qnt`: the popup and the background as one state
  machine, and the invariants. A step is one event the extension does
  not control: a click, a host reply, a navigation, a timer. Between two
  events the code runs until it waits on the host again, and each
  transition computes that whole run.
* `model/extension_test.qnt`: scenarios for `quint test`.
* `model/scenarios.qnt`: situations worth reaching (a fill into an
  iframe, a reveal the host refuses at click time, an abandoned stream,
  …), counted by the simulation and used to pick replay traces.

The invariants:

* A credential reaches only a frame of the page's tab whose
  browser-reported origin the secret names under the host's rule, and
  never a frame its `pasejo-fill` policy rules out.
* A credential reaches a frame only while the tab still shows the origin
  the popup opened on, the `activeTab` grant covers it, and the frame
  still holds the port its fill script opened.
* The host releases a credential only after the user picked that secret
  in the same popup session, and only for the page that popup opened on.
* A `pasejo-confirm` secret is released only after its prompt was
  confirmed, and the prompt ignores clicks until it is armed.
* A `pasejo-fill: never` secret is never released, and a TOTP code only
  for an exact-host match.
* A multi-store stream posts each reply under the slot of the request id
  it answers, each slot once, and `done` last. An open stream has a
  pending slot whose timer ends it; an ended stream's native connection
  is closed.
* The popup lists only secrets the host returned for its current query,
  and nothing once it is closed.

```sh
npm run model:test       # quint test: the scenarios in model/extension_test.qnt
npm run model:simulate   # 20 000 random runs of 40 steps; every invariant checked, scenario counts reported
npm run model:replay     # the replay suite alone (npm test runs it too)
npm run model:verify     # Apalache bounded model check of every invariant, 4 steps deep
```

`model:verify` needs a Java runtime on `PATH` (checked with Temurin 25).
Quint downloads Apalache on first use, runs it as a local server on port
8822 and writes `_apalache-out/` and `tmp/` into the working directory.
A fill is 4 steps from the initial state (open the popup, the list
arrives, click, the reveal arrives), so the check covers every path up
to the shortest fill. It took just under ten minutes on a developer
laptop, and a 6-step run did not finish within 15 minutes, so longer
paths are left to the simulation and the replay.

The replay suite asks `quint run` for one trace per situation in
`model/scenarios.qnt` (each run stops at the first state that reaches
it) and for 60 random runs, all from a fixed seed, and caches the traces
in `node_modules/.cache/pasejo-model/` keyed by the model, the seed and
the Quint version. Quint fetches its Rust evaluator from GitHub on first
use; `PASEJO_MODEL_BACKEND=typescript` uses the slower built-in evaluator
instead. `PASEJO_MODEL_SEED` and `PASEJO_MODEL_SAMPLES` change the random
runs, and `PASEJO_MODEL_TRACES=<dir>` replays traces written elsewhere.
The `Model` CI job runs the scenario tests, a simulation without a fixed
seed, a replay of 200 random runs of a fresh seed, and the bounded check.

The suite turns each step into the event it stands for in a stubbed
browser: a click on the row or button in the popup's DOM, the host's
reply on the native port, a navigation that closes frame ports, a timer
firing. After every step it compares the code with the model: each
native request (action, store, secret, domain, request ids), which
connections are closed, each credential a frame received and that
frame's origin, which frames hold a fill-script port, each message a
stream posted, the listed rows, the confirmation prompt and whether it is
armed, the double-click guard, and the status line a finished fill
leaves.

What the model and the replay do not cover:

* The fill script is a stand-in that answers with what the model says
  the frame's form is. The visibility check itself is covered by
  `tests/fill.test.js`.
* The host is the model's host. Whether the Rust host behaves the same
  is what the end-to-end suite checks.
* A click runs without interruption up to its first host request, so
  nothing navigates between the popup's tab re-check and the injection,
  and the check of the top frame's origin after injection never fires in
  the model. Unit tests cover it.
* The store roster is fixed at two stores. The Refresh button, the
  per-host store memory, the look-alike warning, the waiting state and
  the service-worker keepalive are not modelled, and the store changes
  only between fills.
* Quint has no fairness, so "every stream ends" is checked as a safety
  property: the timers of an open stream end it when they fire.

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
package.sh           Builds dist/<browser>/, the reproducible archives and SHA256SUMS
model/               Quint model of the popup, background and host (see Formal model)
tests/               Vitest unit suite (happy-dom) and the model replay
e2e/                 Playwright end-to-end suite (real Chrome + real host)
```
