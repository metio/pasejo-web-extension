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

The extension declares the following WebExtensions permissions and no
host permissions; here is why each is needed:

| Permission | Why |
|---|---|
| `activeTab` | Granted for one tab when you open the popup (toolbar click or keyboard shortcut). Lets the popup read that tab's URL to search for a matching credential, and lets the extension inject the fill script into that tab. The grant ends when the tab navigates to another site or closes (in Firefox, on any navigation that loads a new page). |
| `scripting` | Inject the small fill script into the tab when you pick a match, so it can write the username, password, and one-time code into the form. It runs only then, only in the page and its frames on the page's own origin, and only fills frames whose origin matches the credential. |
| `nativeMessaging` | Talk to the `pasejo browser host` process. |
| `storage` | Persist the per-host store memory described above. |

A tab you have not opened the popup on is out of the extension's reach, and the extension touches a page only when you pick a match to fill.

## Source

This extension is open source under the 0BSD licence. The full source
is at <https://github.com/metio/pasejo-web-extension>.

## Contact

For questions about this policy, open an issue on the GitHub repository.
