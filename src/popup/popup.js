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
  permissionBanner: document.getElementById("permission-banner"),
  grantPermissions: document.getElementById("grant-permissions"),
  basicAuthToggle: document.getElementById("basic-auth-toggle"),
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
// validator come from `PASEJO` so the popup and the basic-auth recall read
// the same key with the same shape.

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

// Best-effort cleanup of any storage keys the popup no longer owns.
// Removes:
// * every key matching the legacy `store-for-host:<hostname>` prefix
//   (each hostname's choice used to live in its own entry under that
//   schema; the current schema collapses everything into a single
//   `pasejo:host-stores` map);
// * the legacy `pasejo:host-store-index` array that tracked
//   eviction order in the old two-key model.
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

// `coerceHostStoreMap` (the storage trust-boundary validator that drops
// malformed entries) and `HOST_STORE_KEY` are destructured from `PASEJO`
// above so the popup and the basic-auth recall share one definition.

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

// Thin wrapper over the shared `PASEJO.recallStoreForHost` so the popup's
// call site (and the exposed-for-tests name) stay unchanged while the recall
// logic lives in one place that every feature reads.
async function recallStoreForHost(hostname) {
  return globalThis.PASEJO.recallStoreForHost(api, hostname);
}

// Reflect the stored basic-auth opt-in into the toggle. Guarded so the popup
// still works in environments without the toggle element.
async function loadBasicAuthSetting() {
  if (!elements.basicAuthToggle) {
    return;
  }
  elements.basicAuthToggle.checked =
    await globalThis.PASEJO.readBasicAuthEnabled(api);
}

// Persist the opt-in. Read-modify-write the settings object so any future
// settings keys survive. Failure-tolerant: a storage error just means the
// toggle doesn't stick this time.
async function setBasicAuthEnabled(enabled) {
  if (!api.storage?.local) {
    return;
  }
  const key = globalThis.PASEJO.SETTINGS_KEY;
  try {
    const result = await api.storage.local.get(key);
    const existing = result[key];
    const settings =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...existing }
        : {};
    settings.basicAuth = enabled === true;
    await api.storage.local.set({ [key]: settings });
  } catch (_) {
    // Non-fatal — the toggle simply won't persist until storage works.
  }
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
  kind.textContent =
    match.match_kind === "url_field" ? t("matchBadgeUrl") : t("matchBadgeName");
  primary.appendChild(kind);
  item.appendChild(primary);

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.appendChild(button(t("fillButton"), () => fillIntoActiveTab(match)));
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
    otp.textContent = t("otpLabel", match.otp);
    secondary.appendChild(otp);
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
    setStatus(t("statusNoActiveTab"), "error");
    state.filling = false;
    return;
  }
  const payload = {
    type: "fill",
    username: match.username,
    password: match.password,
    // Undefined when the match has no OTP; the content script treats a
    // missing/empty code as "nothing to fill".
    otp: match.otp,
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
  setStatus(t("statusNoFillablePassword"), "error");
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

// How far back an editable-focus timestamp still counts as "the user
// was just typing there". Long enough to survive the popup-open
// pause and a glance at the results list; short enough that a field
// the user abandoned minutes ago doesn't outvote the default
// top-first fill order.
const EDITABLE_FOCUS_RECENCY_MS = 60_000;

// Picks the frame the user most plausibly intends to fill, or null
// when nothing stands out (callers then walk frames top-first). One
// parallel probe wave to every frame; each reply carries two signals:
//
// * `focused` — `document.hasFocus()`. Nearly always false in
//   production because the probe runs while the extension popup
//   itself holds the window focus; honoured anyway since it's free
//   and authoritative when a browser does report it.
// * `lastEditableFocusAt` — when a fill-relevant input in that frame
//   last received focus. This is the real signal: "the frame the
//   user was typing in BEFORE opening the popup". The most recent
//   one within `EDITABLE_FOCUS_RECENCY_MS` wins.
async function findFocusedFrame(tabId, frames) {
  if (frames.length === 0) {
    return null;
  }
  const probes = await Promise.all(
    frames.map(async (frameId) => {
      try {
        const reply = await api.tabs.sendMessage(
          tabId,
          { type: "probe-focus" },
          { frameId },
        );
        if (!reply?.ok) {
          return null;
        }
        return {
          frameId,
          focused: reply.focused === true,
          lastEditableFocusAt:
            typeof reply.lastEditableFocusAt === "number"
              ? reply.lastEditableFocusAt
              : 0,
        };
      } catch (_) {
        return null;
      }
    }),
  );
  const replies = probes.filter((p) => p !== null);
  const focused = replies.find((r) => r.focused);
  if (focused) {
    return focused.frameId;
  }
  const now = Date.now();
  let best = null;
  for (const reply of replies) {
    if (reply.lastEditableFocusAt <= 0) {
      continue;
    }
    if (now - reply.lastEditableFocusAt > EDITABLE_FOCUS_RECENCY_MS) {
      continue;
    }
    if (best === null || reply.lastEditableFocusAt > best.lastEditableFocusAt) {
      best = reply;
    }
  }
  return best === null ? null : best.frameId;
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

// The origins the content script needs before it can fill anything.
// Firefox MV3 treats content-script match patterns as OPTIONAL host
// permissions that default to OFF — without the grant, fill.js never
// injects and every fill fails with a misleading "no fillable input"
// error. Chromium grants statically-declared content scripts at
// install, so `permissions.contains` reports true there and the
// banner stays hidden.
const PAGE_ACCESS_ORIGINS = Object.freeze({ origins: ["<all_urls>"] });

// Reports whether the content script's origins are granted. Errs on
// the side of "granted": a missing `permissions` API or a throwing
// `contains` must not block the popup's main flow — the worst case of
// a wrong `true` is the pre-banner status quo (a generic fill error).
async function checkPageAccess() {
  if (!api.permissions?.contains) {
    return true;
  }
  try {
    return await api.permissions.contains(PAGE_ACCESS_ORIGINS);
  } catch (_) {
    return true;
  }
}

// Shows the grant-access banner when the content script's origins are
// not granted yet. Separate from `main`'s query pipeline so a slow
// host cannot delay the banner and vice versa.
async function revealPermissionBannerIfNeeded() {
  const granted = await checkPageAccess();
  if (!granted) {
    elements.permissionBanner.hidden = false;
  }
}

async function main() {
  const tab = await loadActiveTab();
  if (!tab) {
    setStatus(t("statusNoActiveTabMain"), "error");
    return;
  }
  state.domain = tab.hostname;
  elements.domain.textContent = tab.hostname ?? t("noDomainPlaceholder");
  // Legacy-storage cleanup and the permission check run in parallel
  // with the main refresh pipeline so the popup-open latency stays
  // bounded by the slowest of the three — `refreshStoresAndQuery`
  // already involves a native-messaging round-trip, against which
  // the other two are in the noise. Both helpers swallow their own
  // errors, so chaining them through `Promise.all` can't fail the
  // outer await.
  await Promise.all([
    reconcileLegacyStorage(),
    revealPermissionBannerIfNeeded(),
    loadBasicAuthSetting(),
    refreshStoresAndQuery(),
  ]);
}

// `permissions.request` must run inside a user gesture; the click
// handler provides one. Content scripts only inject on page load, so
// tabs that were already open when the grant happened need a reload
// before a fill can reach them — the success status says so.
elements.grantPermissions.addEventListener("click", async () => {
  if (!api.permissions?.request) {
    return;
  }
  try {
    const granted = await api.permissions.request(PAGE_ACCESS_ORIGINS);
    if (granted) {
      elements.permissionBanner.hidden = true;
      setStatus(t("statusPageAccessGranted"));
    }
  } catch (err) {
    setStatus(t("statusPageAccessRequestFailed", err.message), "error");
  }
});

elements.store.addEventListener("change", () => {
  state.store = readSelectedStore();
  // Fire-and-forget; the runQuery below doesn't depend on the write.
  rememberStoreForHost(state.domain, state.store);
  runQuery();
});

// Optional in environments without the toggle (e.g. the reduced test DOM).
elements.basicAuthToggle?.addEventListener("change", () => {
  setBasicAuthEnabled(elements.basicAuthToggle.checked);
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
