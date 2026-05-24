// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

const { ERROR_COPY, PROTOCOL_MIN, PROTOCOL_MAX, api } = globalThis.PASEJO;

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
  // requests. Cleared on completion (success path closes the popup, so
  // a stale `true` would only block fills the user can never trigger).
  filling: false,
};

// Errors get `role="alert"` so screen readers announce them immediately;
// informational status uses the politer `role="status"` (its implicit
// aria-live="polite" defers to the user's current activity). Swapping
// the role on the same element is the simplest way to get both
// behaviours without two separate live regions.
function setStatus(text, kind) {
  elements.status.textContent = text ?? "";
  if (kind === "error") {
    elements.status.classList.add("error");
    elements.status.setAttribute("role", "alert");
  } else {
    elements.status.classList.remove("error");
    elements.status.setAttribute("role", "status");
  }
}

// Firefox's `browser.runtime.sendMessage` is promise-only — calling it
// with a callback never invokes the callback, so the popup would hang
// forever. Both Firefox and Chrome (since v99) return a Promise here.
async function sendBackground(message) {
  const reply = await api.runtime.sendMessage(message);
  if (!reply) {
    throw new Error("empty reply from background");
  }
  if (!reply.ok) {
    throw new Error(reply.error ?? "background error");
  }
  return reply.response;
}

// Strip user-info, port, and path so the matcher works with what the
// host expects (`example.com`, not `https://example.com/login`).
function activeHostname(url) {
  try {
    return new URL(url).hostname || null;
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
        `extension supports ${PROTOCOL_MIN}-${PROTOCOL_MAX}. ` +
        "Update the pasejo binary or the extension so both ends match.",
      "error",
    );
    return null;
  }
  state.protocolOk = true;
  return reply.stores ?? [];
}

function isCompatibleProtocol(version) {
  return (
    typeof version === "number" &&
    version >= PROTOCOL_MIN &&
    version <= PROTOCOL_MAX
  );
}

function renderStores(stores, preferred) {
  elements.store.replaceChildren();
  if (stores.length > 1) {
    const all = document.createElement("option");
    all.value = ALL_STORES;
    all.textContent = "All stores";
    if (preferred === ALL_STORES) {
      all.selected = true;
    }
    elements.store.appendChild(all);
  }
  for (const entry of stores) {
    const option = document.createElement("option");
    option.value = entry.name;
    option.textContent = entry.default ? `${entry.name} (default)` : entry.name;
    // The dropdown's initial selection prefers the per-host memory, then
    // falls back to the config's default-marked store. Picking here
    // (rather than overriding `.value` after `replaceChildren`) avoids
    // the visible flash of the default selection that the post-render
    // assignment used to cause.
    if (preferred ? entry.name === preferred : entry.default) {
      option.selected = true;
    }
    elements.store.appendChild(option);
  }
  state.stores = stores;
  state.store = elements.store.value || null;
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

async function rememberStoreForHost(hostname, storeName) {
  if (!hostname || !api.storage?.local) {
    return;
  }
  const key = STORE_MEMORY_PREFIX + hostname;
  try {
    if (storeName) {
      await api.storage.local.set({ [key]: storeName });
    } else {
      await api.storage.local.remove(key);
    }
  } catch (_) {
    // Storage write failures are non-fatal — the user just doesn't get
    // the per-host memory until storage works again.
  }
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
  elements.results.replaceChildren();
  if (!state.domain) {
    setStatus("No domain for the active tab — nothing to search.");
    return;
  }
  setStatus(`Searching for ${state.domain}…`);

  if (state.store === ALL_STORES) {
    await runMultiStoreQuery();
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
    setStatus(`Could not reach the host: ${err.message}`, "error");
    return;
  }
  if (reply.error) {
    renderHostError(reply);
    return;
  }
  showMatches(reply.results ?? [], 0);
}

async function runMultiStoreQuery() {
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
  const attempts = await Promise.all(
    state.stores.map(async (entry) => {
      try {
        const reply = await sendBackground({
          type: "query",
          domain: state.domain,
          store: entry.name,
        });
        if (reply.error) {
          return { name: entry.name, results: [], skipped: true };
        }
        return { name: entry.name, results: reply.results ?? [], skipped: false };
      } catch (_) {
        return { name: entry.name, results: [], skipped: true };
      }
    }),
  );
  const matches = attempts.flatMap((a) => a.results);
  // Each store's results are already sorted by score (the host does it);
  // the merged list needs one more sort across stores.
  matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const skipped = attempts.filter((a) => a.skipped).map((a) => a.name);
  showMatches(matches, skipped.length, skipped);
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
  // Re-query the active tab at fill time rather than reusing the id
  // captured in `main()`: if the user opened the popup, switched tabs,
  // and clicked Fill, the captured id would target the original tab.
  // Re-querying makes Fill always act on whatever the user can see.
  const tab = await loadActiveTab();
  if (!tab) {
    setStatus("No active tab to fill.", "error");
    return;
  }
  // Double-click guard: clicking the row twice would otherwise send two
  // fan-outs and race the 600 ms popup close. The flag is cleared in
  // `finally` so an error on the first attempt doesn't block a retry.
  if (state.filling) {
    return;
  }
  state.filling = true;
  const payload = {
    type: "fill",
    username: match.username,
    password: match.password,
  };
  try {
    const reply = await fillAcrossFrames(tab.id, payload);
    if (reply?.ok) {
      setStatus(`Filled ${match.name}.`);
      // Give the user a moment to read the success line before the popup
      // disappears. Without the delay the status flashes too briefly to
      // notice when the close races the paint.
      setTimeout(() => window.close(), 600);
    } else {
      setStatus(
        reply?.error ?? "No frame on the page had a fillable password input.",
        "error",
      );
    }
  } catch (err) {
    setStatus(
      `Could not reach the page: ${err.message}. Reload the tab if it was opened before the extension.`,
      "error",
    );
  } finally {
    state.filling = false;
  }
}

// SSO and embedded-checkout flows put the login form in a same-tab
// iframe. Each frame's content script is independent: only the frame
// that actually contains the focused password input returns ok:true,
// the others return ok:false ("No password input found on this page").
// Fan out the fill to every frame and take the first success.
async function fillAcrossFrames(tabId, payload) {
  const frames = await listFrames(tabId);
  const attempts = frames.map(async (frameId) => {
    try {
      const reply = await api.tabs.sendMessage(tabId, payload, { frameId });
      return reply?.ok ? reply : null;
    } catch (_) {
      // Frame may have unloaded between getAllFrames and sendMessage,
      // or it may not have our content script (e.g. about:blank). Treat
      // any error as a non-match so the remaining frames still get a
      // chance.
      return null;
    }
  });
  const results = await Promise.all(attempts);
  return results.find((r) => r) ?? { ok: false };
}

async function listFrames(tabId) {
  if (!api.webNavigation?.getAllFrames) {
    return [0];
  }
  try {
    const frames = await api.webNavigation.getAllFrames({ tabId });
    if (Array.isArray(frames) && frames.length > 0) {
      return frames.map((f) => f.frameId);
    }
  } catch (_) {
    // Permission missing or tab closed — fall through to top-frame only.
  }
  return [0];
}

async function main() {
  const tab = await loadActiveTab();
  if (!tab) {
    setStatus("No active tab.", "error");
    return;
  }
  state.domain = tab.hostname;
  elements.domain.textContent = tab.hostname ?? "(no domain)";

  const stores = await loadStores();
  if (stores === null) {
    return;
  }
  const preferred = await pickPreferredStore(stores, tab.hostname);
  renderStores(stores, preferred);
  await runQuery();
}

elements.store.addEventListener("change", () => {
  state.store = elements.store.value || null;
  // Fire-and-forget; the runQuery below doesn't depend on the write.
  rememberStoreForHost(state.domain, state.store);
  runQuery();
});

// Debounced: a second click while a refresh is already in flight would
// otherwise race two `list_stores` + `query` rounds. The button stays
// disabled until both complete, which doubles as user feedback.
elements.refresh.addEventListener("click", async () => {
  elements.refresh.disabled = true;
  try {
    const stores = await loadStores();
    if (stores === null) {
      return;
    }
    const preferred = await pickPreferredStore(stores, state.domain);
    renderStores(stores, preferred);
    await runQuery();
  } finally {
    elements.refresh.disabled = false;
  }
});

main();
