<!--
SPDX-FileCopyrightText: The pasejo Authors
SPDX-License-Identifier: 0BSD
-->

# Privacy policy

The pasejo web extension does not collect, transmit, sell, or share any
personal data.

## What stays on your machine

* **Credentials in your pasejo stores** are decrypted on demand by the
  `pasejo browser host` process the extension talks to. They are never
  written to browser storage, never sent over the network, and never
  shared with any third party.
* **Per-host store memory** — the popup remembers which pasejo store you
  picked for a given website in `chrome.storage.local` so it doesn't ask
  again next visit. The stored value is the name of the store (e.g.
  `personal`, `work`) and the hostname it goes with (e.g.
  `example.com`). Nothing else. Clear it from
  `chrome://extensions/?id=…` → *Extension storage*, or by uninstalling
  the extension.

## What goes off-machine

Nothing.

The extension makes no network requests of its own. The only outbound
communication is the native-messaging stdio pipe to
`pasejo browser host`, which runs on the same machine. Any network
traffic from `pasejo` itself (pull/push hooks, public-key downloads, …)
is the same traffic the CLI would generate — see the
[pasejo project](https://github.com/metio/pasejo) for its own privacy
characterisation.

## What about analytics or telemetry?

There is none. No third-party scripts are loaded. No remote logging.
No crash reporting. No update beaconing beyond what the browser does
on its own to check for new extension versions.

## Permissions

The extension declares the following WebExtensions permissions; here is
why each is needed:

| Permission | Why |
|---|---|
| `activeTab` | Read the active tab's URL so the popup can search for the matching credential, and inject the fill into that tab. Only granted while the popup is open. |
| `nativeMessaging` | Talk to the `pasejo browser host` process. |
| `storage` | Persist the per-host store memory described above. |
| `webNavigation` | Enumerate iframes inside the active tab so fill works on SSO / embedded-checkout pages whose login form lives in an iframe. Used only at fill time. |
| `<all_urls>` (content scripts + host permission) | Inject the small fill helper into pages so it can write the username and password into the form when the user clicks *Fill*. The helper does nothing on its own — it waits for a message from the popup. Firefox keeps this permission OFF until you grant it (the popup shows a *Grant access* banner); Chromium grants it at install time. |

## Source

This extension is open source under the 0BSD licence. The full source
is at <https://github.com/metio/pasejo-web-extension>.

## Contact

For questions about this policy, open an issue on the GitHub repository.
