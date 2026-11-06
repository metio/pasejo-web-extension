// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

const {
  ERROR_MESSAGE_IDS,
  PROTOCOL_VERSION,
  HOST_STORE_KEY,
  coerceHostStoreMap,
  api,
  t,
} = globalThis.PASEJO;

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
  // The tab the popup was opened on and the origin it showed then:
  // `{ tabId, origin, hostname }`. The results were matched against
  // `hostname`, so a fill goes ahead only while the tab still shows
  // `origin`.
  page: null,
  store: null,
  stores: [],
  // Set true once `loadStores` has accepted a host's `protocol_version`.
  // Multi-store fan-out skips the per-call check, so we record the
  // outcome of the one call that did check.
  protocolOk: false,
  // Guard against a double-click on a result row sending two fill
  // requests. Cleared on failure paths and when a fill leaves a code on
  // the row for the user to read; a success that closes the popup
  // leaves it `true` until the popup is gone.
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
// hover / long-press still reveals it. 160 is an empirical budget
// for the 13 px `system-ui` font running in a 340–420 px popup —
// roughly two and a half lines of average-width characters before
// the status section starts pushing the results list down. CSS
// `system-ui` resolves to whatever proportional font the OS hands
// the browser, so the average character width varies a bit per
// platform; the CSS `-webkit-line-clamp` rule in popup.css is the
// layout-side cap that catches the edge case where an unusually
// wide character mix slips past this code-point count.
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

// The origin of `url` as the URL parser computes it; "null" for opaque
// origins (`about:`, `data:`, `file:`) and for input that does not parse.
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (_) {
    return "null";
  }
}

async function loadActiveTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    return null;
  }
  return {
    id: tab.id,
    hostname: activeHostname(tab.url),
    origin: originOf(tab.url),
  };
}

// Whether `tab` is still the tab `page` recorded, showing the same
// origin. An opaque origin never counts as the same page.
function isSamePage(page, tab) {
  return (
    page !== null &&
    page.origin !== "null" &&
    tab.id === page.tabId &&
    tab.origin === page.origin
  );
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
    setStatus(t("statusHostUnreachable", err.message), "error");
    return null;
  }
  if (reply.error) {
    return renderHostError(reply);
  }
  if (!isCompatibleProtocol(reply.protocol_version)) {
    // Repeat the noun on the extension's side so the trailing number
    // reads as a clause ("extension speaks protocol N") rather than a
    // sentence fragment ("extension speaks N"). Host side keeps its
    // single mention of "protocol" because the noun has already been
    // introduced.
    setStatus(
      t(
        "statusProtocolMismatch",
        reply.protocol_version ?? t("protocolUnknown"),
        PROTOCOL_VERSION,
      ),
      "error",
    );
    return null;
  }
  // `validateResponseShape` in background.js only checks individual
  // string / array / object sizes — it doesn't constrain field types.
  // Guard here so a host that sent e.g. `{stores: "broken"}` doesn't
  // crash `pickPreferredStore` with a TypeError on `.some`.
  if (reply.stores !== undefined && !Array.isArray(reply.stores)) {
    setStatus(t("statusMalformedStores"), "error");
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
    all.textContent = t("allStoresOption");
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
    option.textContent = entry.default
      ? t("storeOptionDefault", entry.name)
      : entry.name;
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

// Pure helper: tests whether `pick` names something the just-loaded
// `stores` list can still select. `ALL_STORES` is valid when more
// than one real store exists (the sentinel option only renders in
// that case). Any other name is valid when an entry in `stores`
// carries it. Used by both `pickPreferredStore` (validating a value
// read from chrome.storage) and `refreshStoresAndQuery` (validating
// the user's intermediate dropdown pick during a refresh).
function isPickStillValid(pick, stores) {
  if (!pick) {
    return false;
  }
  if (pick === ALL_STORES) {
    return stores.length > 1;
  }
  return stores.some((s) => s.name === pick);
}

async function pickPreferredStore(stores, hostname) {
  const remembered = await recallStoreForHost(hostname);
  return isPickStillValid(remembered, stores) ? remembered : null;
}

// Per-host store memory. The popup remembers which store the user last
// picked for the active page's hostname so they don't have to re-pick
// every visit. Keyed by raw hostname (not registrable domain) because
// the popup doesn't bundle a public-suffix list; `mail.example.com` and
// `www.example.com` therefore have independent memories, which is fine
// and matches what most users expect anyway.
//
// The entire host→store memory lives under one storage key as a single
// object `{ [hostname]: { store: string, lastUsedAt: number } }`. One
// key means each touch is one `get` + one `set`, so the data and its
// eviction order cannot drift apart — there is no separate index that
// might survive a crash mid-write and leave orphan per-host entries.
// Eviction order is derived from `lastUsedAt` rather than stored
// explicitly: the LRU victim is whichever entry has the smallest
// timestamp. Within-popup concurrent writes are serialised through
// `hostStoreWriteQueue` below. `HOST_STORE_KEY` and its `coerceHostStoreMap`
// validator come from `PASEJO`.

// Storage keys the popup wrote in earlier builds before the single-key
// schema landed. The current code never reads them, so without a
// reconcile pass they'd sit in `chrome.storage.local` forever as
// orphan zombies on machines that ran an earlier build. The same
// pass also cleans up any stale entries a user might have introduced
// by hand from the browser's storage inspector. Run on every popup
// open: the cost is one `get(null)` + at most one `remove(list)`
// (~milliseconds against storage.local), and a per-open pass
// catches drift introduced by dev-tools edits between popup opens.
const LEGACY_HOST_KEY_PREFIX = "store-for-host:";
const LEGACY_HOST_INDEX_KEY = "pasejo:host-store-index";
const LEGACY_SETTINGS_KEY = "pasejo:settings";

// Best-effort cleanup of any storage keys the popup no longer owns.
// Removes:
// * every key matching the legacy `store-for-host:<hostname>` prefix
//   (each hostname's choice used to live in its own entry under that
//   schema; the current schema collapses everything into a single
//   `pasejo:host-stores` map);
// * the legacy `pasejo:host-store-index` array that tracked
//   eviction order in the old two-key model;
// * the legacy `pasejo:settings` object that held the opt-in for the
//   HTTP basic-auth fill earlier builds offered.
//
// Failures are swallowed: reconciliation is opportunistic, the
// popup must keep working even if storage is unavailable, and a
// missed cleanup just means the next popup open will try again.
async function reconcileLegacyStorage() {
  if (!api.storage?.local) {
    return;
  }
  try {
    const all = await api.storage.local.get(null);
    if (!all || typeof all !== "object") {
      return;
    }
    const stale = Object.keys(all).filter(
      (key) =>
        key === LEGACY_HOST_INDEX_KEY ||
        key === LEGACY_SETTINGS_KEY ||
        key.startsWith(LEGACY_HOST_KEY_PREFIX),
    );
    if (stale.length > 0) {
      await api.storage.local.remove(stale);
    }
  } catch (_) {
    // Storage unavailable / quota exceeded / a future API change —
    // none of those should propagate up to the popup's main flow.
  }
}

// Soft cap on the number of hosts whose store choice we remember.
// chrome.storage.local's 5 MB quota would tolerate orders of magnitude
// more entries, but letting the map grow unbounded lets a never-used
// browser profile silently accumulate every site the user has ever
// visited. 500 covers any realistic site list with headroom; once the
// cap is reached, the host with the oldest `lastUsedAt` falls off
// whenever a new host is added.
const MAX_REMEMBERED_HOSTS = 500;

// LRU-trims `map` down to `cap` entries (oldest `lastUsedAt` first).
// Returns the cleaned map and the hostnames that were evicted so the
// caller can log / surface them. Pure — no storage I/O — so the
// trimming policy is testable in isolation from the read-write loop.
// Ties broken by hostname string order so the result is deterministic
// even when two entries happen to share a `lastUsedAt` (e.g. tests
// using fake timers).
function pruneMapToCap(map, cap) {
  const entries = Object.entries(map);
  if (entries.length <= cap) {
    return { map: { ...map }, removed: [] };
  }
  entries.sort((a, b) => {
    const diff = a[1].lastUsedAt - b[1].lastUsedAt;
    return diff !== 0 ? diff : a[0].localeCompare(b[0]);
  });
  const removed = entries.slice(0, entries.length - cap).map(([h]) => h);
  const kept = Object.fromEntries(entries.slice(entries.length - cap));
  return { map: kept, removed };
}

// Module-local promise chain that serialises every host-store write
// against every other write originating in the same popup. The browser
// has no `storage.local.update(fn)` primitive, so without this two
// rapid-fire `rememberStoreForHost` calls — e.g. the user toggling the
// dropdown twice in quick succession — would race their `get` /
// `modify` / `set` triples and one update would silently overwrite the
// other. Cross-popup writes (two popup windows open at once) still
// race at the storage layer, but the worst case there is "one user
// choice is overwritten by the other's", not the open-ended drift the
// old two-key schema allowed.
let hostStoreWriteQueue = Promise.resolve();

function enqueueHostStoreWrite(task) {
  const pending = hostStoreWriteQueue.then(task);
  // Swallow rejections on the chain so one failed write doesn't poison
  // every subsequent enqueue. The task is wrapped in its own try/catch
  // by the caller — this is defence in depth.
  hostStoreWriteQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

async function rememberStoreForHost(hostname, storeName) {
  if (!hostname || !api.storage?.local) {
    return;
  }
  return enqueueHostStoreWrite(async () => {
    try {
      const existing = await api.storage.local.get(HOST_STORE_KEY);
      const map = coerceHostStoreMap(existing[HOST_STORE_KEY]);
      if (storeName) {
        map[hostname] = { store: storeName, lastUsedAt: Date.now() };
      } else if (hostname in map) {
        delete map[hostname];
      } else {
        // No write needed: clearing a hostname that wasn't remembered.
        return;
      }
      const { map: trimmed } = pruneMapToCap(map, MAX_REMEMBERED_HOSTS);
      await api.storage.local.set({ [HOST_STORE_KEY]: trimmed });
    } catch (_) {
      // Storage write failures are non-fatal — the user just doesn't
      // get the per-host memory until storage works again.
    }
  });
}

// Thin wrapper binding the shared `PASEJO.recallStoreForHost` to this
// popup's API handle.
async function recallStoreForHost(hostname) {
  return globalThis.PASEJO.recallStoreForHost(api, hostname);
}

function renderHostError(reply) {
  const messageId = ERROR_MESSAGE_IDS[reply.error];
  const copy = messageId
    ? t(messageId)
    : t("statusHostReturnedError", reply.error);
  const hint = reply.hint ? t("hostErrorHintSuffix", reply.hint) : "";
  setStatus(`${copy}${hint}`, "error");
  return null;
}

async function runQuery() {
  // Snapshot the generation up front: every side effect below first
  // re-reads `state.queryGeneration` and bails when it no longer
  // matches. Stops a slower first query from clobbering a fresher
  // second query that came in via the change / refresh handler.
  const generation = ++state.queryGeneration;
  closeConfirmation();
  elements.results.replaceChildren();
  if (!state.domain) {
    setStatus(t("statusNoDomain"));
    return;
  }
  if (state.store === ALL_STORES) {
    // Multi-store mode emits its own progress-counter status from
    // first synchronous tick onwards, so the grace-period generic
    // message would just race with — and briefly overwrite — the
    // counter. Skip it.
    await runMultiStoreQuery(generation);
    return;
  }
  // Defer the "Searching for X…" message so fast hosts don't flash it
  // on screen for a few frames before the results overwrite it. Slow
  // hosts (>250 ms) still get user feedback.
  const searchingTimer = setTimeout(() => {
    if (generation !== state.queryGeneration) {
      return;
    }
    setStatus(t("statusSearching", state.domain));
  }, 250);

  try {
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
      setStatus(t("statusHostUnreachable", err.message), "error");
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
      setStatus(t("statusMalformedResults"), "error");
      return;
    }
    showMatches(reply.results ?? [], 0);
  } finally {
    clearTimeout(searchingTimer);
  }
}

async function runMultiStoreQuery(generation) {
  if (state.stores.length === 0) {
    setStatus(t("statusNoStoresToSearch"), "error");
    return;
  }
  if (!state.protocolOk) {
    // `loadStores` is the only place that validates `protocol_version`,
    // and it must have succeeded for the user to see "All stores" in
    // the dropdown. Belt-and-braces guard so a future refactor can't
    // route into the multi-store path without going through the gate.
    setStatus(t("statusProtocolUnverified"), "error");
    return;
  }
  const total = state.stores.length;
  const matches = [];
  const skipped = [];
  let answered = 0;

  const setSearchingStatus = () => {
    // `streamMultiStoreBatch` gates every callback dispatch on
    // `generation === state.queryGeneration`, and the synchronous
    // initial call below runs before any reentrant runQuery can
    // bump the generation. So this helper assumes the current
    // generation; the canonical stale-suppression check lives in
    // the stream consumer rather than at every status update site.
    setStatus(t("statusSearchingProgress", state.domain, answered, total));
  };
  // Emit the initial progress line synchronously so the user sees
  // "0/N answered" before any reply lands, instead of staring at an
  // empty status line.
  setSearchingStatus();

  // Repaint the results list against the current `matches` / `skipped`
  // accumulator. Called on every incoming per-store result so the
  // user sees matches arrive one store at a time rather than after
  // the slowest store's timeout. Same generation-gating reasoning
  // as `setSearchingStatus`: the stream consumer is the gate.
  const renderIncremental = () => {
    elements.results.replaceChildren();
    // Each store's results are pre-sorted by score (the host sorts
    // them); the merged list needs one more sort across stores so the
    // top match for the page always sits at the top of the popup
    // regardless of which store responded first.
    const sorted = [...matches].sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0),
    );
    for (const match of sorted) {
      elements.results.appendChild(renderMatch(match));
    }
  };

  await streamMultiStoreBatch(generation, (index, response) => {
    answered += 1;
    // The stream consumer bounds-checks `index`, so the entry lookup
    // always lands inside `state.stores` — but `loadStores` doesn't
    // validate per-entry shape, so an entry without a `name` (a
    // malformed host roster) still needs the `store#N` placeholder
    // for the skipped-stores line.
    const storeName = state.stores[index]?.name ?? `store#${index}`;
    if (
      response &&
      !response.error &&
      Array.isArray(response.results)
    ) {
      matches.push(...response.results);
    } else {
      skipped.push(storeName);
    }
    renderIncremental();
    if (answered < total) {
      setSearchingStatus();
    }
  });
  if (generation !== state.queryGeneration) {
    return;
  }
  // Final status: switch from "(answered/total)" progress copy to the
  // settled "N matches." / "No matches…" / "X store(s) skipped" copy
  // showMatches already knows how to format.
  const sorted = [...matches].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  elements.results.replaceChildren();
  showMatches(sorted, skipped.length, skipped);
}

// Opens a long-lived port to the background and consumes the streamed
// per-store replies. Calls `onResult(index, response)` for every
// `{type:"result"}` message and resolves when the background emits
// `{type:"done"}` or the port disconnects (which the background does
// once every slot has settled). Slots that never landed a reply
// before disconnect are reported as `transport_error` envelopes so
// the popup's "skipped" accounting stays accurate without the popup
// having to track its own per-request timer.
function streamMultiStoreBatch(generation, onResult) {
  return new Promise((resolve) => {
    const total = state.stores.length;
    const settled = new Set();
    let port;
    try {
      port = api.runtime.connect({ name: "query_multi_stream" });
    } catch (err) {
      // Failed before opening — every store goes down as skipped.
      for (let i = 0; i < total; i += 1) {
        onResult(i, { error: "transport_error", hint: err.message });
        settled.add(i);
      }
      resolve();
      return;
    }
    if (!port) {
      for (let i = 0; i < total; i += 1) {
        onResult(i, {
          error: "transport_error",
          hint: "could not open the streaming port",
        });
        settled.add(i);
      }
      resolve();
      return;
    }
    // Consolidated "best effort, ignore throw" wrapper for the
    // popup-side disconnect. Both the `done` and `error` paths use
    // this; double-disconnect on a port that has already been torn
    // down by the background can throw in real browsers.
    const safeDisconnect = () => {
      try {
        port.disconnect();
      } catch (_) {
        // Already disconnected.
      }
    };
    // Keepalive against Chromium's MV3 service-worker idle reaper:
    // each ping is an event that resets the worker's ~30 s idle
    // deadline, so a batch waiting on a YubiKey touch can outlive it.
    // The background drops post-`start` messages on this port
    // silently. Cleared by `finish()` on every settlement path.
    const keepalive = setInterval(() => {
      try {
        port.postMessage({ action: "keepalive" });
      } catch (_) {
        // Port already gone — the disconnect handler is about to
        // finish() and clear this interval.
      }
    }, STREAM_KEEPALIVE_INTERVAL_MS);
    // Marks any store that never had a result message reported as a
    // transport failure and resolves the outer Promise. The for-loop
    // is idempotent (each slot can only be `settled.add`-ed once) and
    // `resolve()` is naturally a no-op when already called, so this
    // function is safe to invoke from multiple settlement paths
    // (`done` message, `error` message, port disconnect) without an
    // explicit guard.
    const finish = () => {
      clearInterval(keepalive);
      for (let i = 0; i < total; i += 1) {
        if (!settled.has(i)) {
          settled.add(i);
          if (generation === state.queryGeneration) {
            onResult(i, {
              error: "transport_error",
              hint: "the background closed the stream before answering",
            });
          }
        }
      }
      resolve();
    };
    port.onMessage.addListener((message) => {
      if (!message || typeof message !== "object") {
        return;
      }
      if (message.type === "result") {
        if (
          !Number.isInteger(message.index) ||
          message.index < 0 ||
          message.index >= total ||
          settled.has(message.index)
        ) {
          return;
        }
        settled.add(message.index);
        if (generation === state.queryGeneration) {
          onResult(message.index, message.response);
        }
        return;
      }
      if (message.type === "done") {
        finish();
        safeDisconnect();
        return;
      }
      if (message.type === "error") {
        // Background reported a setup failure (e.g. connectNative
        // threw). Treat as a whole-batch transport error: every
        // unsettled slot is marked skipped via `finish()`.
        finish();
        safeDisconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      finish();
    });
    try {
      port.postMessage({
        action: "start",
        requests: state.stores.map((entry) => ({
          domain: state.domain,
          store: entry.name,
        })),
      });
    } catch (err) {
      // postMessage threw before the port carried our `start` — every
      // store goes down as skipped.
      for (let i = 0; i < total; i += 1) {
        if (!settled.has(i)) {
          settled.add(i);
          if (generation === state.queryGeneration) {
            onResult(i, { error: "transport_error", hint: err.message });
          }
        }
      }
      finish();
    }
  });
}

function showMatches(matches, skippedCount, skippedNames) {
  if (matches.length === 0) {
    if (skippedCount > 0) {
      setStatus(
        t(
          "statusNoMatchesSkipped",
          state.domain,
          skippedCount,
          skippedNames?.join(", ") ?? t("skippedNamesFallback"),
        ),
        "error",
      );
    } else {
      setStatus(t("statusNoMatches", state.domain));
    }
    return;
  }
  let line =
    matches.length === 1
      ? t("statusMatchesOne", matches.length)
      : t("statusMatchesOther", matches.length);
  if (skippedCount > 0) {
    line += t(
      "statusSkippedSuffix",
      skippedCount,
      skippedNames?.join(", ") ?? t("skippedNamesFallback"),
    );
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
  item.setAttribute("aria-label", t("fillRowAriaLabel", match.name));
  item.addEventListener("click", () => fillIntoActiveTab(match, item));
  item.addEventListener("keydown", (event) => {
    // Pressing Enter/Space on the inner Fill button generates a
    // keydown that bubbles up to this listener with `target` set to
    // the button, not the row. Without this `target === item` filter
    // the activation would fire `fillIntoActiveTab` twice (once via
    // the button's click handler, once via this keydown handler) —
    // the popup's `state.filling` guard catches the second call but
    // each invocation still costs a `loadActiveTab` round-trip.
    if (event.target !== item) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fillIntoActiveTab(match, item);
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
  kind.textContent =
    match.match_kind === "url_field" ? t("matchBadgeUrl") : t("matchBadgeName");
  primary.appendChild(kind);
  item.appendChild(primary);

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.appendChild(
    button(t("fillButton"), () => fillIntoActiveTab(match, item)),
  );
  item.appendChild(actions);

  const secondary = document.createElement("div");
  secondary.className = "row-secondary";
  if (match.username) {
    const user = document.createElement("span");
    user.textContent = match.username;
    secondary.appendChild(user);
  }
  if (match.store) {
    const store = document.createElement("span");
    store.textContent = t("storeInlineLabel", match.store);
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

// Shows the one-time code a reveal released on `row` when the fill did
// not place it in the page, replacing a code an earlier fill showed.
// Returns whether a code is shown.
function showRevealedOtp(row, credential, filled) {
  if (!row || !credential?.otp || filled?.otp) {
    return false;
  }
  const secondary = row.querySelector(".row-secondary");
  secondary.querySelector(".otp")?.remove();
  const otp = document.createElement("span");
  otp.className = "otp";
  otp.textContent = t("otpLabel", credential.otp);
  secondary.appendChild(otp);
  return true;
}

// Asks the host to release `match`'s credential for the page the popup
// opened on. The host decrypts the store again and re-runs its matcher
// for `page.hostname`, so a secret that does not match the page is
// refused there. Resolves `{credential}`, `{hostError}` with the host's
// error envelope, or `{transportError}` with a message.
async function revealCredential(match, page) {
  let reply;
  try {
    reply = await sendBackground({
      type: "reveal",
      store: match.store,
      name: match.name,
      domain: page.hostname,
    });
  } catch (err) {
    return { transportError: err.message };
  }
  if (reply.error) {
    return { hostError: reply };
  }
  if (!reply.credential || typeof reply.credential !== "object") {
    return { hostError: { error: "decode_error" } };
  }
  return { credential: reply.credential };
}

// The message a frame fills from: the released credential only.
function fillMessage(credential) {
  return {
    type: "fill",
    username: credential.username,
    password: credential.password,
    // Undefined when the host released no code; the content script
    // treats a missing/empty code as "nothing to fill".
    otp: credential.otp,
  };
}

// Whether the secret's policy asks the user to confirm every fill. The
// host passes the flag along and does not enforce it, so the popup is
// the one place that asks. Anything other than an absent or `false` flag
// asks.
function needsConfirmation(match) {
  return match.confirm !== undefined && match.confirm !== false;
}

// How long the confirm button of a prompt stays disabled after the
// prompt opens, so the second click of a double-click on Fill cannot
// confirm the fill the first click asked about.
const CONFIRM_ARM_DELAY_MS = 500;

// The confirmation prompt open on a result row, or null:
// `{ row, element, timer }`. At most one is open.
let openConfirmation = null;

// Opens the prompt asking whether to fill `match` into the page, on its
// row. Nothing is revealed until the user confirms. Focus moves to
// Cancel, so a stray Enter or Space does not confirm either.
function askToConfirm(match, row) {
  if (openConfirmation?.row === row) {
    return;
  }
  closeConfirmation();
  const element = document.createElement("div");
  element.className = "confirm";
  element.setAttribute("role", "group");
  const text = document.createElement("span");
  text.className = "confirm-text";
  text.textContent = t("confirmFillPrompt", match.name, state.page.hostname);
  element.setAttribute("aria-label", text.textContent);
  // `aria-disabled` rather than `disabled`: the button keeps receiving
  // clicks and ignores them until armed, in every browser alike.
  const confirm = button(t("confirmFillButton"), () => {
    if (confirm.getAttribute("aria-disabled") === "true") {
      return;
    }
    closeConfirmation();
    fillIntoActiveTab(match, row, { confirmed: true });
  });
  confirm.setAttribute("aria-disabled", "true");
  const cancel = button(t("cancelButton"), () => {
    closeConfirmation();
    row.focus();
  });
  element.append(text, confirm, cancel);
  row.appendChild(element);
  const timer = setTimeout(() => {
    confirm.removeAttribute("aria-disabled");
  }, CONFIRM_ARM_DELAY_MS);
  openConfirmation = { row, element, timer };
  cancel.focus();
}

function closeConfirmation() {
  if (openConfirmation === null) {
    return;
  }
  clearTimeout(openConfirmation.timer);
  openConfirmation.element.remove();
  openConfirmation = null;
}

async function fillIntoActiveTab(match, row, { confirmed = false } = {}) {
  // Double-click guard: clicking the row twice would otherwise send two
  // fan-outs and race the 600 ms popup close. The flag is set BEFORE
  // any async work so a queued second click bails immediately, not
  // after both have already started a tab query.
  if (state.filling) {
    return;
  }
  if (needsConfirmation(match) && !confirmed) {
    if (row) {
      askToConfirm(match, row);
    }
    return;
  }
  state.filling = true;
  // The results were matched against the page the popup opened on.
  // Re-query the active tab and refuse when the user has since switched
  // tabs or the tab navigated to another origin: the credential was
  // never matched against what the tab shows now.
  const tab = await loadActiveTab();
  if (!tab) {
    setStatus(t("statusNoActiveTab"), "error");
    state.filling = false;
    return;
  }
  if (!isSamePage(state.page, tab)) {
    setStatus(t("statusPageChanged"), "error");
    state.filling = false;
    return;
  }
  const page = state.page;
  const lookups = new Map();
  const reply = await fillAcrossFrames(
    page,
    () => revealCredential(match, page),
    (frame) => frameMatchesCredential(frame, match, page, lookups),
  );
  if (reply.revealFailure) {
    const failure = reply.revealFailure;
    if (failure.hostError) {
      renderHostError(failure.hostError);
    } else {
      setStatus(t("statusHostUnreachable", failure.transportError), "error");
    }
    state.filling = false;
    return;
  }
  const otpSuffix = showRevealedOtp(row, reply.credential, reply.filled)
    ? t("statusOtpShownSuffix")
    : "";
  if (reply.ok) {
    // Partial fill: the matching frame had a username field but no
    // password field (typical multi-step login email page). Tell the
    // user explicitly so they don't expect the password fill to have
    // happened — they need to reopen the popup once the password
    // page loads.
    const partial =
      reply.filled?.password === false && reply.filled?.username === true;
    // A standalone 2FA step: only the one-time code field was present.
    const onlyOtp =
      reply.filled?.otp &&
      !reply.filled?.username &&
      !reply.filled?.password;
    const withOtp = Boolean(reply.filled?.otp) && !onlyOtp;
    let message;
    if (onlyOtp) {
      message = t("statusFilledOtpOnly", match.name);
    } else if (partial) {
      message = withOtp
        ? t("statusFilledUsernameOtp", match.name)
        : t("statusFilledUsernameOnly", match.name);
    } else {
      message = withOtp
        ? t("statusFilledOtp", match.name)
        : t("statusFilled", match.name);
    }
    if (otpSuffix) {
      // The user still needs the code shown on the row, so the popup
      // stays open and usable.
      setStatus(`${message}${otpSuffix}`);
      state.filling = false;
      return;
    }
    setStatus(message);
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
  let failure = "statusNoFillablePassword";
  if (reply.pageChanged) {
    failure = "statusPageChanged";
  } else if (reply.noAccess) {
    failure = "statusNoPageAccess";
  } else if (reply.reason) {
    failure = FILL_REFUSAL_MESSAGE_IDS[reply.reason];
  } else if (reply.refused) {
    failure = "statusFillRefusedOtherSite";
  }
  setStatus(`${t(failure, match.name)}${otpSuffix}`, "error");
  // Failure path: re-enable so the user can try a different match.
  state.filling = false;
}

// Fills the credential `reveal` releases into the tab `page` recorded.
// The fill script is
// injected only now, into every frame the browser lets the extension
// reach — opening the popup granted `activeTab` for the tab's page, and
// the manifest asks for no standing host access. The walk goes:
//
// 1. Inject `content/fill.js` into all frames. Each injected frame
//    opens a `pasejo-frame` port back to this popup and reports
//    read-only focus facts in a `ready` message; no credential is sent,
//    no DOM is mutated.
// 2. If the top frame's browser-reported origin is no longer
//    `page.origin`, the tab navigated after the popup's own check:
//    stop without filling anything.
// 3. Order the frames: the one holding focus (or, failing that, the one
//    whose focused element is a fillable input) first, the rest in the
//    order the browser listed them.
// 4. Walk that order. A frame `isFrameAllowed` rejects is skipped; the
//    rest get the fill one at a time until the first `ok:true` reply.
//    Sequential rather than parallel because a parallel fan-out would
//    fill every form that has a password input, including unrelated
//    change-password iframes and any malicious iframe injected into the
//    page.
// 5. `reveal` runs once, right before the first frame that may receive
//    the credential gets it, so nothing is released for a page the fill
//    cannot reach. A frame that went away during the reveal is skipped.
//
// Resolves `{ok:false}` plus `noAccess` when the browser refused the
// injection outright (a browser-internal page, an add-on store),
// `pageChanged` for step 2, `revealFailure` with the failed reveal's
// outcome, or `refused` with the number of frames `isFrameAllowed`
// rejected and `reason`, the first reason a frame gave for leaving its
// fields alone (see `FILL_REFUSAL_MESSAGE_IDS`). Once a reveal
// succeeded, the reply carries its `credential`.
async function fillAcrossFrames(page, reveal, isFrameAllowed) {
  const collector = createFrameCollector(page.tabId);
  frameCollector = collector;
  try {
    const injected = await injectFillScript(page.tabId);
    if (injected === null) {
      return { ok: false, noAccess: true };
    }
    const frames = await collector.waitFor(injected, FRAME_HANDSHAKE_TIMEOUT_MS);
    const top = frames.find((frame) => frame.frameId === 0);
    if (top !== undefined && top.origin !== page.origin) {
      return { ok: false, pageChanged: true };
    }
    let refused = 0;
    let credential;
    let reason;
    for (const frame of orderFramesForFill(frames)) {
      if (!(await isFrameAllowed(frame))) {
        refused += 1;
        continue;
      }
      if (credential === undefined) {
        const outcome = await reveal();
        if (!outcome.credential) {
          return { ok: false, revealFailure: outcome };
        }
        credential = outcome.credential;
      }
      if (frame.disconnected) {
        continue;
      }
      const reply = await requestFill(frame, fillMessage(credential));
      if (reply.ok) {
        return { ...reply, credential };
      }
      if (
        reason === undefined &&
        Object.hasOwn(FILL_REFUSAL_MESSAGE_IDS, reply.reason)
      ) {
        reason = reply.reason;
      }
    }
    return { ok: false, refused, reason, credential };
  } finally {
    if (frameCollector === collector) {
      frameCollector = null;
    }
    collector.close();
  }
}

// Runs the fill script in every frame of `tabId` the extension may
// reach. Returns the ids of the frames where it ran and opened its
// port, or null when the browser refused the injection as a whole.
// Frames the browser skipped or reported an `error` for are left out.
async function injectFillScript(tabId) {
  let results;
  try {
    results = await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [FILL_SCRIPT_PATH],
    });
  } catch (_) {
    return null;
  }
  if (!Array.isArray(results)) {
    return [];
  }
  return results
    .filter((r) => r?.result === true && Number.isInteger(r.frameId))
    .map((r) => r.frameId);
}

// Collects the `pasejo-frame` ports the fill script opens while one
// fill attempt is in flight. A port is accepted only when the browser
// says it came from `tabId`; everything the popup later decides about a
// frame comes from the port's browser-stamped `sender`, never from what
// the frame's page could put in a message.
function createFrameCollector(tabId) {
  const frames = new Map();
  const waiters = new Set();
  const notify = () => {
    for (const waiter of waiters) {
      waiter();
    }
  };
  return {
    accept(port) {
      const sender = port.sender;
      if (
        sender?.tab?.id !== tabId ||
        !Number.isInteger(sender.frameId) ||
        frames.has(sender.frameId)
      ) {
        safeDisconnectPort(port);
        return;
      }
      const frame = {
        port,
        frameId: sender.frameId,
        origin: senderOrigin(sender),
        ready: false,
        focused: false,
        editableFocused: false,
        disconnected: false,
      };
      frames.set(frame.frameId, frame);
      port.onMessage.addListener((message) => {
        if (message?.type !== "ready" || frame.ready) {
          return;
        }
        frame.ready = true;
        frame.focused = message.focused === true;
        frame.editableFocused = message.editableFocused === true;
        notify();
      });
      port.onDisconnect.addListener(() => {
        frame.disconnected = true;
        notify();
      });
    },
    // Resolves with the ready, still-connected frames among `frameIds`
    // (in that order) once each of them has either reported ready or
    // gone away, or after `timeoutMs`, whichever comes first.
    waitFor(frameIds, timeoutMs) {
      const settledFrames = () =>
        frameIds
          .map((id) => frames.get(id))
          .filter((frame) => frame?.ready && !frame.disconnected);
      const allSettled = () =>
        frameIds.every((id) => {
          const frame = frames.get(id);
          return frame !== undefined && (frame.ready || frame.disconnected);
        });
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(settledFrames());
        };
        const check = () => {
          if (allSettled()) {
            finish();
          }
        };
        const timer = setTimeout(finish, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    close() {
      for (const frame of frames.values()) {
        safeDisconnectPort(frame.port);
      }
      frames.clear();
      waiters.clear();
    },
  };
}

// The fill attempt collecting frame ports right now, or null. Ports
// that connect while no attempt is collecting are refused.
let frameCollector = null;

api.runtime.onConnect.addListener((port) => {
  if (port.name !== FRAME_PORT_NAME) {
    return;
  }
  if (frameCollector === null) {
    safeDisconnectPort(port);
    return;
  }
  frameCollector.accept(port);
});

// The origin the browser reports for a port's sender: `sender.origin`
// where the browser provides it (it covers `about:blank` and `srcdoc`
// frames, which inherit their parent's origin), else the origin of
// `sender.url`.
function senderOrigin(sender) {
  if (typeof sender.origin === "string") {
    return sender.origin;
  }
  return originOf(sender.url);
}

// The hostname of an `http(s)` origin in the form the host compares
// (see `activeHostname`), or null for any other origin.
function originHostname(origin) {
  if (!/^https?:\/\//.test(origin)) {
    return null;
  }
  return activeHostname(origin);
}

// The host part of a stored URL field the way the host extracts it: a
// value without a scheme is read as `http://<value>`. Null when it does
// not parse.
function storedUrlHostname(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  return activeHostname(withScheme);
}

// Whether `frame` may receive `match`'s credential. The frame's host —
// from the browser-reported origin, never from anything the page sends —
// has to match the secret under the host's own rule: the stored URL's
// exact host or the same registrable domain, or the secret-name rule
// for a name match. The popup bundles no public-suffix list, so beyond
// the two cases it can decide alone it asks the host:
//
// * the frame's host is `page.hostname`: the host matched this secret
//   against exactly that host to produce the result row;
// * the frame's host is the host of the secret's stored URL: an exact
//   host match;
// * anything else: query the host for the frame's host in the match's
//   store and require the same secret among the results.
//
// `lookups` caches the host's verdict per frame host for one fill.
async function frameMatchesCredential(frame, match, page, lookups) {
  const hostname = originHostname(frame.origin);
  if (hostname === null) {
    return false;
  }
  if (hostname === page.hostname) {
    return true;
  }
  if (hostname === storedUrlHostname(match.url)) {
    return true;
  }
  if (!lookups.has(hostname)) {
    lookups.set(hostname, hostMatchesSecret(hostname, match));
  }
  return lookups.get(hostname);
}

// Asks the host whether `match` (same store, same secret name) is among
// its results for `hostname`. Any failure counts as no.
async function hostMatchesSecret(hostname, match) {
  let reply;
  try {
    reply = await sendBackground({
      type: "query",
      domain: hostname,
      store: match.store ?? null,
    });
  } catch (_) {
    return false;
  }
  if (!Array.isArray(reply.results)) {
    return false;
  }
  return reply.results.some(
    (result) => result?.name === match.name && result?.store === match.store,
  );
}

// The frame holding focus first, else the frame whose focused element
// is a fillable input, then the remaining frames in their given order.
function orderFramesForFill(frames) {
  const preferred =
    frames.find((frame) => frame.focused) ??
    frames.find((frame) => frame.editableFocused);
  if (preferred === undefined) {
    return frames;
  }
  return [preferred, ...frames.filter((frame) => frame !== preferred)];
}

// Sends one fill to one frame and resolves with its `fill-result`, or
// with `{ok:false}` when the frame goes away or stays silent.
function requestFill(frame, payload) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reply) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve(reply);
    };
    const timer = setTimeout(
      () => finish({ ok: false }),
      FRAME_FILL_TIMEOUT_MS,
    );
    frame.port.onMessage.addListener((message) => {
      if (message?.type === "fill-result") {
        finish({ ...message, ok: message.ok === true });
      }
    });
    frame.port.onDisconnect.addListener(() => finish({ ok: false }));
    try {
      frame.port.postMessage(payload);
    } catch (_) {
      finish({ ok: false });
    }
  });
}

// Best-effort `port.disconnect()`: a port the other side already closed
// can throw.
function safeDisconnectPort(port) {
  try {
    port.disconnect();
  } catch (_) {
    // Already disconnected.
  }
}

// Interval for the keepalive ping the popup sends on the stream port
// while a multi-store batch is in flight. Chromium's MV3 service
// worker is reaped after ~30 s without events; a batch whose only
// outstanding work is a YubiKey-blocked decrypt generates none while
// it waits, and a reaped worker drops both ports — the user would
// see "background closed the stream" instead of the intended
// per-request timeout. Each ping resets the idle clock. 20 s leaves
// a comfortable margin under the 30 s deadline; the background
// drops post-`start` messages silently, so the ping needs no
// protocol handling on the other side.
const STREAM_KEEPALIVE_INTERVAL_MS = 20_000;

// The fill script `scripting.executeScript` injects, relative to the
// extension root, and the name of the port it opens back to the popup.
const FILL_SCRIPT_PATH = "content/fill.js";
const FRAME_PORT_NAME = "pasejo-frame";

// How long the injected frames get to open their port and report ready.
// Injection resolves after the script ran, so a frame that has not
// reported by then is gone or wedged.
const FRAME_HANDSHAKE_TIMEOUT_MS = 2_000;

// How long one frame gets to answer a fill before the walk moves on.
const FRAME_FILL_TIMEOUT_MS = 5_000;

// Status message per reason the fill script gives for leaving a frame's
// fields alone: the field it would fill is hidden, cannot be scrolled
// into view, or lies under another element.
const FILL_REFUSAL_MESSAGE_IDS = Object.freeze({
  hidden: "statusFillRefusedHidden",
  offscreen: "statusFillRefusedOffscreen",
  covered: "statusFillRefusedCovered",
});

// Walks the full "pull a fresh store roster from the host, pick the
// preferred entry for the current hostname, redraw the dropdown, and
// re-run the query" pipeline. Both popup-open (`main`) and the Refresh
// button go through this so the two call sites cannot drift on
// ordering, hostname source, or bail semantics. Reads `state.domain`
// because `main` has already populated it from the active tab before
// the first call; the Refresh handler reuses the same field.
async function refreshStoresAndQuery() {
  // Snapshot the user's pick so we can detect an intermediate change
  // (dropdown click) that lands while `loadStores` is in flight. The
  // change handler writes the new pick to `state.store` synchronously
  // but the matching chrome.storage write is async and may not have
  // propagated by the time `pickPreferredStore` reads it back. Without
  // this guard, a refresh that started before the dropdown click
  // would overwrite the user's just-chosen store with the previously
  // remembered one.
  const initialStore = state.store;
  const stores = await loadStores();
  if (stores === null) {
    return;
  }
  // The user's intermediate pick wins over the remembered preference
  // when it's still a valid choice in the refreshed roster. If they
  // picked a store that has since been removed (or `ALL_STORES` when
  // only one store now exists) we fall through to the normal
  // remembered-preference path so the dropdown lands somewhere
  // selectable.
  const userIntermediatePick =
    state.store !== initialStore && isPickStillValid(state.store, stores)
      ? state.store
      : null;
  const preferred =
    userIntermediatePick ?? (await pickPreferredStore(stores, state.domain));
  state.stores = stores;
  renderStores(stores, preferred);
  state.store = readSelectedStore();
  await runQuery();
}

async function main() {
  const tab = await loadActiveTab();
  if (!tab) {
    setStatus(t("statusNoActiveTabMain"), "error");
    return;
  }
  state.domain = tab.hostname;
  state.page = { tabId: tab.id, origin: tab.origin, hostname: tab.hostname };
  elements.domain.textContent = tab.hostname ?? t("noDomainPlaceholder");
  // Legacy-storage cleanup runs in parallel with the main refresh
  // pipeline so the popup-open latency stays bounded by the slower of
  // the two — `refreshStoresAndQuery` involves a native-messaging
  // round-trip, against which the cleanup is in the noise. The cleanup
  // swallows its own errors, so `Promise.all` can't fail the outer
  // await.
  await Promise.all([reconcileLegacyStorage(), refreshStoresAndQuery()]);
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

// Replace the static UI text carried in `data-i18n*` attributes with the
// localized copy. WebExtensions only substitute `__MSG_*__` tokens in the
// manifest and CSS, never in HTML, so the popup's chrome is localized here
// on load. Runs synchronously before `main` so the first paint is already
// in the user's language.
function localizeStaticDom(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  }
}

localizeStaticDom();
main();
