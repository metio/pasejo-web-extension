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
    <section class="controls">
      <label for="store">Store</label>
      <select id="store" aria-label="Store"></select>
      <button id="refresh" type="button">Refresh</button>
    </section>
    <section id="status" class="status" role="status" aria-live="polite"></section>
    <ul id="results" class="results"></ul>
  `;
}
