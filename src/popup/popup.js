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

const state = {
  tabId: null,
  domain: null,
  store: null,
};

function setStatus(text, kind) {
  elements.status.textContent = text ?? "";
  elements.status.classList.toggle("error", kind === "error");
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
  return reply.stores ?? [];
}

function isCompatibleProtocol(version) {
  return (
    typeof version === "number" &&
    version >= PROTOCOL_MIN &&
    version <= PROTOCOL_MAX
  );
}

function renderStores(stores) {
  elements.store.replaceChildren();
  for (const entry of stores) {
    const option = document.createElement("option");
    option.value = entry.name;
    option.textContent = entry.default ? `${entry.name} (default)` : entry.name;
    if (entry.default) {
      option.selected = true;
    }
    elements.store.appendChild(option);
  }
  state.store = elements.store.value || null;
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
  const matches = reply.results ?? [];
  if (matches.length === 0) {
    setStatus(`No matches for ${state.domain}.`);
    return;
  }
  setStatus(`${matches.length} match${matches.length === 1 ? "" : "es"}.`);
  for (const match of matches) {
    elements.results.appendChild(renderMatch(match));
  }
}

function renderMatch(match) {
  const item = document.createElement("li");
  item.title = match.name;
  item.addEventListener("click", () => fillIntoActiveTab(match));

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
  actions.appendChild(button("Copy user", () => copy(match.username)));
  actions.appendChild(button("Copy pw", () => copy(match.password)));
  if (match.otp) {
    actions.appendChild(button("Copy OTP", () => copy(match.otp)));
  }
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

async function copy(value) {
  if (!value) {
    setStatus("Nothing to copy.");
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    setStatus("Copied.");
  } catch (err) {
    setStatus(`Clipboard write failed: ${err.message}`, "error");
  }
}

async function fillIntoActiveTab(match) {
  if (!state.tabId) {
    setStatus("No active tab to fill.", "error");
    return;
  }
  const payload = {
    type: "fill",
    username: match.username,
    password: match.password,
  };
  try {
    const reply = await fillAcrossFrames(state.tabId, payload);
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
  state.tabId = tab.id;
  state.domain = tab.hostname;
  elements.domain.textContent = tab.hostname ?? "(no domain)";

  const stores = await loadStores();
  if (stores === null) {
    return;
  }
  renderStores(stores);
  await runQuery();
}

elements.store.addEventListener("change", () => {
  state.store = elements.store.value || null;
  runQuery();
});
elements.refresh.addEventListener("click", async () => {
  const stores = await loadStores();
  if (stores === null) {
    return;
  }
  renderStores(stores);
  await runQuery();
});

main();
