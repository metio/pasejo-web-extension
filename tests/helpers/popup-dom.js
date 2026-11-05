// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

// Mirror of the markup `src/popup/popup.html` ships, reduced to the
// nodes that `popup.js` looks up by id. Keeping the test fixture local
// here avoids dragging html-parsing into every test and keeps the
// asserts insulated from cosmetic changes to the popup chrome.
export function buildPopupDom(document) {
  document.body.innerHTML = `
    <header class="header">
      <span class="title">pasejo</span>
      <span id="domain" class="domain"></span>
    </header>
    <section id="permission-banner" class="permission-banner" hidden>
      <span data-i18n="permissionBannerText">pasejo needs permission to access pages before it can fill credentials.</span>
      <button id="grant-permissions" type="button" data-i18n="grantAccessButton">Grant access</button>
    </section>
    <section class="controls">
      <label for="store" data-i18n="storeLabel">Store</label>
      <select id="store" aria-label="Store" data-i18n-aria-label="storeLabel"></select>
      <button id="refresh" type="button" title="Re-query the host" data-i18n="refreshButton" data-i18n-title="refreshButtonTitle">Refresh</button>
    </section>
    <section id="status" class="status" role="status" aria-live="polite"></section>
    <ul id="results" class="results"></ul>
  `;
}
