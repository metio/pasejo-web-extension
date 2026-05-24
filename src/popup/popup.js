// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

const { ERROR_COPY, api } = globalThis.PASEJO;

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

function sendBackground(message) {
  return new Promise((resolve, reject) => {
    api.runtime.sendMessage(message, (reply) => {
      const err = api.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (!reply) {
        reject(new Error("empty reply from background"));
        return;
      }
      if (reply.ok) {
        resolve(reply.response);
      } else {
        reject(new Error(reply.error ?? "background error"));
      }
    });
  });
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
  return reply.stores ?? [];
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
  try {
    const reply = await api.tabs.sendMessage(state.tabId, {
      type: "fill",
      username: match.username,
      password: match.password,
    });
    if (reply?.ok) {
      setStatus(`Filled ${match.name}.`);
      window.close();
    } else {
      setStatus(reply?.error ?? "Fill returned no usable response.", "error");
    }
  } catch (err) {
    setStatus(
      `Could not reach the page: ${err.message}. Reload the tab if it was opened before the extension.`,
      "error",
    );
  }
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
elements.refresh.addEventListener("click", () => runQuery());

main();
