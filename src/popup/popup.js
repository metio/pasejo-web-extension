// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

const { ERROR_COPY, PROTOCOL_VERSION, api } = globalThis.PASEJO;

const elements = {
  domain: document.getElementById("domain"),
  store: document.getElementById("store"),
  refresh: document.getElementById("refresh"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
};

// Sentinel value the Store dropdown uses for "fan out the query across
// every configured store and merge the results". The host is never sent
// this string — the popup interprets it locally and fans out to one
// `query` per real store name. Picked to be implausible as a user-chosen
// store name; we additionally guard `renderStores` so an actual store
// named `__pasejo_all__` would still appear under its own row even if
// the user managed to register it.
const ALL_STORES = "__pasejo_all__";

const state = {
  domain: null,
  store: null,
  stores: [],
  // Set true once `loadStores` has accepted a host's `protocol_version`.
  // Multi-store fan-out skips the per-call check, so we record the
  // outcome of the one call that did check.
  protocolOk: false,
  // Guard against a double-click on a result row sending two fill
  // requests. Cleared on failure paths; the success path leaves it
  // `true` until the popup closes itself.
  filling: false,
  // Guard against a rapid second Refresh click sneaking in before
  // `disabled = true` takes effect on the in-flight click. A queued
  // event whose dispatch had already begun isn't suppressed by the
  // disabled property.
  refreshing: false,
  // Monotonically-increasing identifier handed out by `runQuery`. Each
  // `runQuery` invocation bumps this and snapshots the new value; any
  // side effect (status update, results render) it tries to apply
  // after an await first re-reads the field and bails when it no
  // longer matches. Stops a slower first query from overwriting the
  // results of a faster second query that came in via the change /
  // refresh handler.
  queryGeneration: 0,
};

// Status messages above this many characters get visibly truncated
// with an ellipsis; the full text moves to the element's `title` so
// hover / long-press still reveals it. 160 is roughly the number of
// 13 px-monospace glyphs that fit in two and a half lines of the
// 340-420 px popup; anything longer used to push the results list
// down. The CSS `-webkit-line-clamp` is a second, layout-side cap
// that protects against unexpected wrapping inside the budget.
const MAX_STATUS_CHARS = 160;

// Pure helper: returns `{ text, title }` for a raw status string.
// `title` is `null` when the input fits within the cap (so callers
// can clear any existing title attribute) and the full input when
// truncation happened. Splits on code points via `Array.from` rather
// than UTF-16 units so a multi-byte emoji landing on the cut boundary
// does not leave a malformed surrogate followed by the ellipsis.
function truncateStatus(raw) {
  const text = raw ?? "";
  const chars = Array.from(text);
  if (chars.length <= MAX_STATUS_CHARS) {
    return { text, title: null };
  }
  return {
    text: `${chars.slice(0, MAX_STATUS_CHARS - 1).join("")}…`,
    title: text,
  };
}

// Errors get `role="alert"` + `aria-live="assertive"` so screen readers
// announce them immediately; informational status uses the politer
// `role="status"` + `aria-live="polite"` (defers to current activity).
// Both attributes are set explicitly: an inherited `aria-live="polite"`
// from the HTML would otherwise override the `role="alert"` implicit
// assertiveness and downgrade error announcements to polite.
function setStatus(text, kind) {
  const { text: visible, title } = truncateStatus(text);
  elements.status.textContent = visible;
  if (title === null) {
    elements.status.removeAttribute("title");
  } else {
    elements.status.title = title;
  }
  if (kind === "error") {
    elements.status.classList.add("error");
    elements.status.setAttribute("role", "alert");
    elements.status.setAttribute("aria-live", "assertive");
  } else {
    elements.status.classList.remove("error");
    elements.status.setAttribute("role", "status");
    elements.status.setAttribute("aria-live", "polite");
  }
}

// Firefox's `browser.runtime.sendMessage` is promise-only — calling it
// with a callback never invokes the callback, so the popup would hang
// forever. Both Firefox and Chrome (since v99) return a Promise here.
//
// The two response-shape checks defend the rest of the popup against a
// background/host that breaks the wire contract: a `null` `response`
// would crash callers that do `reply.error` (TypeError on property
// access), and a primitive `response` would silently mis-route as a
// "no error" success.
async function sendBackground(message) {
  const reply = await api.runtime.sendMessage(message);
  if (!reply) {
    throw new Error("empty reply from background");
  }
  if (!reply.ok) {
    throw new Error(reply.error ?? "background error");
  }
  if (typeof reply.response !== "object" || reply.response === null) {
    throw new Error("malformed response from host (not an object)");
  }
  return reply.response;
}

// Strip user-info, port, and path so the matcher works with what the
// host expects (`example.com`, not `https://example.com/login`). IPv6
// literals: `URL.hostname` returns the bracketed form `[::1]`, but the
// host's URL extractor normalises stored URL fields to the unbracketed
// `::1` for comparison. Sending the bracketed form would break both
// URL-field matching (one bracketed, one not) and the name-fallback
// path-segment compare. Strip the wrapping brackets here so both sides
// agree on the unbracketed canonical form.
function activeHostname(url) {
  try {
    const hostname = new URL(url).hostname;
    if (!hostname) {
      return null;
    }
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      return hostname.slice(1, -1);
    }
    return hostname;
  } catch (_) {
    return null;
  }
}

async function loadActiveTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    return null;
  }
  return { id: tab.id, hostname: activeHostname(tab.url) };
}

async function loadStores() {
  // The gate is reset at the start of every call: a Refresh against a
  // host that now reports an incompatible protocol must invalidate the
  // multi-store path, even if a previous `loadStores` (in the same
  // popup lifetime) had accepted it.
  state.protocolOk = false;
  let reply;
  try {
    reply = await sendBackground({ type: "list_stores" });
  } catch (err) {
    setStatus(`Could not reach the host: ${err.message}`, "error");
    return null;
  }
  if (reply.error) {
    return renderHostError(reply);
  }
  if (!isCompatibleProtocol(reply.protocol_version)) {
    setStatus(
      `Host speaks protocol ${reply.protocol_version ?? "(unknown)"}, ` +
        `extension speaks ${PROTOCOL_VERSION}. ` +
        "Update the pasejo binary or the extension so both ends match.",
      "error",
    );
    return null;
  }
  // `validateResponseShape` in background.js only checks individual
  // string / array / object sizes — it doesn't constrain field types.
  // Guard here so a host that sent e.g. `{stores: "broken"}` doesn't
  // crash `pickPreferredStore` with a TypeError on `.some`.
  if (reply.stores !== undefined && !Array.isArray(reply.stores)) {
    setStatus("Malformed host response: `stores` is not an array.", "error");
    return null;
  }
  state.protocolOk = true;
  return reply.stores ?? [];
}

function isCompatibleProtocol(version) {
  return version === PROTOCOL_VERSION;
}

// DOM-only: rebuilds the store-selector dropdown to reflect `stores`
// and the caller's `preferred` choice. Does not touch `state` — the
// caller (currently `refreshStoresAndQuery`) is the canonical place
// where state.stores / state.store get written, which keeps "what's
// in the DOM" and "what's in state" updated together in one spot.
function renderStores(stores, preferred) {
  elements.store.replaceChildren();
  if (stores.length > 1) {
    const all = document.createElement("option");
    all.value = ALL_STORES;
    all.textContent = "All stores";
    elements.store.appendChild(all);
    if (preferred === ALL_STORES) {
      // Selectedness is flipped AFTER append so the option is part of
      // its select before the IDL setter fires; in detached options the
      // selectedness can be silently re-coerced on insertion when the
      // select has no other selected option to honour.
      all.selected = true;
    }
  }
  for (const entry of stores) {
    const option = document.createElement("option");
    option.value = entry.name;
    option.textContent = entry.default ? `${entry.name} (default)` : entry.name;
    // `<option title>` isn't honoured by every browser (Firefox renders
    // it on hover; Chrome may not) but where it works it lets the user
    // see the full name of a long store that the dropdown truncates.
    option.title = entry.name;
    elements.store.appendChild(option);
    // The dropdown's initial selection prefers the per-host memory, then
    // falls back to the config's default-marked store. Picking here
    // (rather than overriding `.value` after `replaceChildren`) avoids
    // the visible flash of the default selection that the post-render
    // assignment used to cause.
    if (preferred ? entry.name === preferred : entry.default) {
      option.selected = true;
    }
  }
}

// Pure DOM read: the current dropdown value coerced to `null` when
// the select is empty. Used as the canonical "what is the user looking
// at right now" derivation so the change handler and
// `refreshStoresAndQuery` share one implementation.
function readSelectedStore() {
  return elements.store.value || null;
}

async function pickPreferredStore(stores, hostname) {
  const remembered = await recallStoreForHost(hostname);
  if (!remembered) {
    return null;
  }
  if (remembered === ALL_STORES) {
    // The "All stores" entry only renders when more than one store
    // exists; falling back to null lets `renderStores` use the
    // config-default selection in the single-store case.
    return stores.length > 1 ? ALL_STORES : null;
  }
  return stores.some((s) => s.name === remembered) ? remembered : null;
}

// Per-host store memory. The popup remembers which store the user last
// picked for the active page's hostname so they don't have to re-pick
// every visit. Keyed by raw hostname (not registrable domain) because
// the popup doesn't bundle a public-suffix list; `mail.example.com` and
// `www.example.com` therefore have independent memories, which is fine
// for v1 and matches what most users expect anyway.
const STORE_MEMORY_PREFIX = "store-for-host:";

// Soft cap on the number of hosts whose store choice we remember.
// chrome.storage.local's quota is 5 MB, and each entry is on the order
// of fifty bytes, so the quota itself sits at ~100K entries — but
// letting the map grow unbounded is a code smell and lets a never-used
// browser profile silently accumulate every site the user has ever
// visited. 500 covers any realistic site list with headroom; once the
// cap is reached, the host that was longest ago touched falls off the
// front of the index whenever a new host is added.
const MAX_REMEMBERED_HOSTS = 500;

// Tracks the eviction order for the host→store memory. Element 0 is
// the next host to be evicted; the last element is the host most
// recently written. The index lives under a fixed key whose prefix
// cannot collide with a literal hostname (those all live under
// `STORE_MEMORY_PREFIX`).
const STORE_MEMORY_INDEX_KEY = "pasejo:host-store-index";

async function rememberStoreForHost(hostname, storeName) {
  if (!hostname || !api.storage?.local) {
    return;
  }
  const key = STORE_MEMORY_PREFIX + hostname;
  try {
    if (storeName) {
      await api.storage.local.set({ [key]: storeName });
      await touchHostInIndex(hostname);
    } else {
      await api.storage.local.remove(key);
      await dropHostFromIndex(hostname);
    }
  } catch (_) {
    // Storage write failures are non-fatal — the user just doesn't get
    // the per-host memory until storage works again.
  }
}

// Bumps `hostname` to the most-recent end of the eviction index and
// removes from storage any hosts that overflow the cap. The index and
// each per-host entry live in the same `chrome.storage.local` so the
// state survives popup teardown without any in-memory bookkeeping.
async function touchHostInIndex(hostname) {
  const existing = await api.storage.local.get(STORE_MEMORY_INDEX_KEY);
  const raw = existing[STORE_MEMORY_INDEX_KEY];
  // A non-array value (missing key, or corrupted previous write) is
  // treated as an empty index — we'd rather lose one cycle of eviction
  // memory than refuse to write.
  const index = (Array.isArray(raw) ? raw : []).filter((h) => h !== hostname);
  index.push(hostname);
  while (index.length > MAX_REMEMBERED_HOSTS) {
    const evicted = index.shift();
    await api.storage.local.remove(STORE_MEMORY_PREFIX + evicted);
  }
  await api.storage.local.set({ [STORE_MEMORY_INDEX_KEY]: index });
}

async function dropHostFromIndex(hostname) {
  const existing = await api.storage.local.get(STORE_MEMORY_INDEX_KEY);
  const raw = existing[STORE_MEMORY_INDEX_KEY];
  if (!Array.isArray(raw)) {
    return;
  }
  const index = raw.filter((h) => h !== hostname);
  if (index.length === raw.length) {
    return;
  }
  await api.storage.local.set({ [STORE_MEMORY_INDEX_KEY]: index });
}

async function recallStoreForHost(hostname) {
  if (!hostname || !api.storage?.local) {
    return null;
  }
  const key = STORE_MEMORY_PREFIX + hostname;
  try {
    const result = await api.storage.local.get(key);
    return result[key] ?? null;
  } catch (_) {
    return null;
  }
}

function renderHostError(reply) {
  const copy = ERROR_COPY[reply.error] ?? `Host returned ${reply.error}.`;
  const hint = reply.hint ? ` (${reply.hint})` : "";
  setStatus(`${copy}${hint}`, "error");
  return null;
}

async function runQuery() {
  // Snapshot the generation up front: every side effect below first
  // re-reads `state.queryGeneration` and bails when it no longer
  // matches. Stops a slower first query from clobbering a fresher
  // second query that came in via the change / refresh handler.
  const generation = ++state.queryGeneration;
  elements.results.replaceChildren();
  if (!state.domain) {
    setStatus("No domain for the active tab — nothing to search.");
    return;
  }
  // Defer the "Searching for X…" message so fast hosts don't flash it
  // on screen for a few frames before the results overwrite it. Slow
  // hosts (>250 ms) still get user feedback.
  const searchingTimer = setTimeout(() => {
    if (generation !== state.queryGeneration) {
      return;
    }
    setStatus(`Searching for ${state.domain}…`);
  }, 250);

  try {
    if (state.store === ALL_STORES) {
      await runMultiStoreQuery(generation);
      return;
    }

    let reply;
    try {
      reply = await sendBackground({
        type: "query",
        domain: state.domain,
        store: state.store,
      });
    } catch (err) {
      if (generation !== state.queryGeneration) {
        return;
      }
      setStatus(`Could not reach the host: ${err.message}`, "error");
      return;
    }
    if (generation !== state.queryGeneration) {
      return;
    }
    if (reply.error) {
      renderHostError(reply);
      return;
    }
    if (reply.results !== undefined && !Array.isArray(reply.results)) {
      setStatus(
        "Malformed host response: `results` is not an array.",
        "error",
      );
      return;
    }
    showMatches(reply.results ?? [], 0);
  } finally {
    clearTimeout(searchingTimer);
  }
}

async function runMultiStoreQuery(generation) {
  if (state.stores.length === 0) {
    setStatus("No stores to search.", "error");
    return;
  }
  if (!state.protocolOk) {
    // `loadStores` is the only place that validates `protocol_version`,
    // and it must have succeeded for the user to see "All stores" in
    // the dropdown. Belt-and-braces guard so a future refactor can't
    // route into the multi-store path without going through the gate.
    setStatus(
      "Refusing multi-store query: host protocol has not been verified yet.",
      "error",
    );
    return;
  }
  // Single native connection carrying every per-store query as one
  // `query_multi` batch. The host's worker threads decrypt stores in
  // parallel, so a YubiKey-blocked store holds back only its own
  // response while every other store's reply arrives normally.
  const attempts = await fanOutBatch();
  if (generation !== state.queryGeneration) {
    return;
  }
  const matches = attempts.flatMap((a) => a.results);
  // Each store's results are already sorted by score (the host does it);
  // the merged list needs one more sort across stores.
  matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const skipped = attempts.filter((a) => a.skipped).map((a) => a.name);
  showMatches(matches, skipped.length, skipped);
}

// Fans every per-store query through a single `connectNative` as one
// `query_multi` batch. The host processes requests on worker threads
// so a YubiKey-blocked store holds back only its own slot — the rest
// come back as fast as their own decrypts allow. The background
// returns a `responses` array aligned 1:1 with the input order, so we
// re-pair each entry with its store name.
async function fanOutBatch() {
  let reply;
  try {
    reply = await api.runtime.sendMessage({
      type: "query_multi",
      requests: state.stores.map((entry) => ({
        domain: state.domain,
        store: entry.name,
      })),
    });
  } catch (_) {
    // The whole batch failed — treat every store as skipped.
    return state.stores.map((entry) => ({
      name: entry.name,
      results: [],
      skipped: true,
    }));
  }
  if (!reply?.ok || !Array.isArray(reply.responses)) {
    return state.stores.map((entry) => ({
      name: entry.name,
      results: [],
      skipped: true,
    }));
  }
  return state.stores.map((entry, idx) => {
    const response = reply.responses[idx];
    if (!response || response.error || !Array.isArray(response.results)) {
      return { name: entry.name, results: [], skipped: true };
    }
    return { name: entry.name, results: response.results, skipped: false };
  });
}

function showMatches(matches, skippedCount, skippedNames) {
  if (matches.length === 0) {
    if (skippedCount > 0) {
      setStatus(
        `No matches for ${state.domain} (${skippedCount} store(s) skipped: ${
          skippedNames?.join(", ") ?? "errors"
        }).`,
        "error",
      );
    } else {
      setStatus(`No matches for ${state.domain}.`);
    }
    return;
  }
  const noun = matches.length === 1 ? "match" : "matches";
  let line = `${matches.length} ${noun}.`;
  if (skippedCount > 0) {
    line += ` (${skippedCount} store(s) skipped: ${
      skippedNames?.join(", ") ?? "errors"
    })`;
  }
  setStatus(line);
  for (const match of matches) {
    elements.results.appendChild(renderMatch(match));
  }
}

function renderMatch(match) {
  const item = document.createElement("li");
  item.title = match.name;
  // Keyboard accessibility: each row is reachable by Tab and activated
  // by Enter / Space. Without this the row's `cursor: pointer` lied to
  // mouse users (no keyboard equivalent existed) and keyboard users
  // had to Tab to the inner Fill button.
  item.tabIndex = 0;
  item.setAttribute("role", "button");
  item.setAttribute("aria-label", `Fill ${match.name}`);
  item.addEventListener("click", () => fillIntoActiveTab(match));
  item.addEventListener("keydown", (event) => {
    // Pressing Enter/Space on the inner Fill button generates a
    // keydown that bubbles up to this listener with `target` set to
    // the button, not the row. Without this `target === item` filter
    // the activation would fire `fillIntoActiveTab` twice (once via
    // the button's click handler, once via this keydown handler) —
    // the popup's `state.filling` guard catches the second call but
    // each invocation still costs a `loadActiveTab` and a wasted
    // `tabs.sendMessage` fan-out.
    if (event.target !== item) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fillIntoActiveTab(match);
    }
  });

  const primary = document.createElement("div");
  primary.className = "row-primary";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = match.name;
  primary.appendChild(name);
  const kind = document.createElement("span");
  kind.className = "badge";
  kind.textContent = match.match_kind === "url_field" ? "url" : "name";
  primary.appendChild(kind);
  item.appendChild(primary);

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.appendChild(button("Fill", () => fillIntoActiveTab(match)));
  item.appendChild(actions);

  const secondary = document.createElement("div");
  secondary.className = "row-secondary";
  if (match.username) {
    const user = document.createElement("span");
    user.textContent = match.username;
    secondary.appendChild(user);
  }
  if (match.otp) {
    const otp = document.createElement("span");
    otp.className = "otp";
    otp.textContent = `OTP: ${match.otp}`;
    secondary.appendChild(otp);
  }
  if (match.store) {
    const store = document.createElement("span");
    store.textContent = `store: ${match.store}`;
    secondary.appendChild(store);
  }
  item.appendChild(secondary);

  return item;
}

function button(label, handler) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    handler();
  });
  return btn;
}

async function fillIntoActiveTab(match) {
  // Double-click guard: clicking the row twice would otherwise send two
  // fan-outs and race the 600 ms popup close. The flag is set BEFORE
  // any async work so a queued second click bails immediately, not
  // after both have already started a tab query.
  if (state.filling) {
    return;
  }
  state.filling = true;
  // Re-query the active tab at fill time rather than reusing the id
  // captured in `main()`: if the user opened the popup, switched tabs,
  // and clicked Fill, the captured id would target the original tab.
  // Re-querying makes Fill always act on whatever the user can see.
  const tab = await loadActiveTab();
  if (!tab) {
    setStatus("No active tab to fill.", "error");
    state.filling = false;
    return;
  }
  const payload = {
    type: "fill",
    username: match.username,
    password: match.password,
  };
  const reply = await fillAcrossFrames(tab.id, payload);
  if (reply.ok) {
    // Partial fill: the matching frame had a username field but no
    // password field (typical multi-step login email page). Tell the
    // user explicitly so they don't expect the password fill to have
    // happened — they need to reopen the popup once the password
    // page loads.
    const partial =
      reply.filled?.password === false && reply.filled?.username === true;
    setStatus(
      partial
        ? `Filled username for ${match.name} (no password field on this page).`
        : `Filled ${match.name}.`,
    );
    // Give the user a moment to read the success line before the popup
    // disappears. Without the delay the status flashes too briefly to
    // notice when the close races the paint. Partial fills get a
    // longer pause because the message is longer and the user needs
    // to read the next-step instruction.
    //
    // Note: `state.filling` deliberately stays `true` here. The popup
    // is about to close, and clearing the flag would re-open the
    // double-click window for the brief interval before
    // `window.close()` fires.
    setTimeout(() => window.close(), partial ? 1500 : 600);
    return;
  }
  setStatus(
    "No frame on the page had a fillable password input.",
    "error",
  );
  // Failure path: re-enable so the user can try a different match.
  state.filling = false;
}

// SSO and embedded-checkout flows put the login form in a same-tab
// iframe. The fill walk goes:
//
// 1. Probe every frame in parallel — read-only `document.hasFocus()`
//    via the `probe-focus` message; no credential is sent, no DOM is
//    mutated. The first frame that reports focus is the user's
//    intended target.
// 2. Build the fill order: focused frame first (when one was found),
//    followed by every frame in tree order with the focused frame
//    removed so it isn't tried twice.
// 3. Walk the order sequentially and stop at the first `ok:true`
//    reply. Sequential rather than parallel because a parallel
//    `Promise.all` here would dispatch the actual fill payload to
//    every frame and fill every form that has a password input,
//    including unrelated change-password iframes and (worse) any
//    malicious iframe injected into the page.
//
// The focus probe closes the iframe-targeting gap from earlier review
// rounds at the cost of one extra round-trip per fill, which is
// negligible against the human reaction time it takes to click the
// row.
async function fillAcrossFrames(tabId, payload) {
  const frames = await listFrames(tabId);
  const focused = await findFocusedFrame(tabId, frames);
  const order =
    focused === null
      ? frames
      : [focused, ...frames.filter((f) => f !== focused)];
  for (const frameId of order) {
    try {
      const reply = await api.tabs.sendMessage(tabId, payload, { frameId });
      if (reply?.ok) {
        return reply;
      }
    } catch (_) {
      // Frame may have unloaded between getAllFrames and sendMessage,
      // or it may not have our content script (e.g. about:blank).
      // Skip and try the next.
    }
  }
  return { ok: false };
}

// Parallel `probe-focus` to every frame. Returns the frameId of the
// first frame that reports focus, or null if none do (or all probes
// fail). Probes are read-only so dispatching them in parallel is
// safe; the actual fill stays sequential downstream.
async function findFocusedFrame(tabId, frames) {
  const probes = await Promise.all(
    frames.map(async (frameId) => {
      try {
        const reply = await api.tabs.sendMessage(
          tabId,
          { type: "probe-focus" },
          { frameId },
        );
        return reply?.ok && reply.focused === true ? frameId : null;
      } catch (_) {
        return null;
      }
    }),
  );
  return probes.find((f) => f !== null) ?? null;
}

async function listFrames(tabId) {
  if (!api.webNavigation?.getAllFrames) {
    return [0];
  }
  try {
    const frames = await api.webNavigation.getAllFrames({ tabId });
    if (Array.isArray(frames) && frames.length > 0) {
      // Drop frames that can't have our content script registered:
      //  * `errorOccurred: true` — the frame's navigation failed and no
      //    document is loaded, so there is no message receiver.
      //  * `url: "about:blank"` — either mid-navigation (no
      //    `document_idle` yet) or an intentional empty iframe; our
      //    manifest's `<all_urls>` does not match `about:*` and we
      //    don't set `match_about_blank`, so a content script was
      //    never injected there. Either case would cost the caller
      //    one wasted `tabs.sendMessage` round-trip per frame.
      return frames
        .filter((f) => !f.errorOccurred && f.url !== "about:blank")
        .map((f) => f.frameId);
    }
  } catch (_) {
    // Permission missing or tab closed — fall through to top-frame only.
  }
  return [0];
}

// Walks the full "pull a fresh store roster from the host, pick the
// preferred entry for the current hostname, redraw the dropdown, and
// re-run the query" pipeline. Both popup-open (`main`) and the Refresh
// button go through this so the two call sites cannot drift on
// ordering, hostname source, or bail semantics. Reads `state.domain`
// because `main` has already populated it from the active tab before
// the first call; the Refresh handler reuses the same field.
async function refreshStoresAndQuery() {
  const stores = await loadStores();
  if (stores === null) {
    return;
  }
  const preferred = await pickPreferredStore(stores, state.domain);
  state.stores = stores;
  renderStores(stores, preferred);
  state.store = readSelectedStore();
  await runQuery();
}

async function main() {
  const tab = await loadActiveTab();
  if (!tab) {
    setStatus("No active tab.", "error");
    return;
  }
  state.domain = tab.hostname;
  elements.domain.textContent = tab.hostname ?? "(no domain)";
  await refreshStoresAndQuery();
}

elements.store.addEventListener("change", () => {
  state.store = readSelectedStore();
  // Fire-and-forget; the runQuery below doesn't depend on the write.
  rememberStoreForHost(state.domain, state.store);
  runQuery();
});

// Debounced: a second click while a refresh is already in flight would
// otherwise race two `list_stores` + `query` rounds. The `refreshing`
// flag catches any click that the browser dispatched before the
// `disabled = true` could take effect (rapid double-click); the
// `disabled` property doubles as visual feedback.
elements.refresh.addEventListener("click", async () => {
  if (state.refreshing) {
    return;
  }
  state.refreshing = true;
  elements.refresh.disabled = true;
  try {
    await refreshStoresAndQuery();
  } finally {
    state.refreshing = false;
    elements.refresh.disabled = false;
  }
});

main();
