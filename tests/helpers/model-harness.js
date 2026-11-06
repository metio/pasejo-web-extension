// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { expect, vi } from "vitest";

import { loadClassicScript } from "./load-script.js";
import { invokeBackgroundListener, makeApiMock } from "./mock-api.js";
import { buildPopupDom } from "./popup-dom.js";
import { installScheduler, settle } from "./scheduler.js";

// Runs the shipped background and popup scripts inside a browser the
// model state describes, and turns each model step into the event it
// stands for: a click in the popup DOM, a host reply on a native port, a
// navigation that closes frame ports, a timer firing. After every step
// `check` compares what the code did with what the model says it does.

const STORES = ["personal", "work"];
const ALL_STORES = "__pasejo_all__";
const NATIVE_TIMEOUT_MS = 30_000;
const CONFIRM_ARM_DELAY_MS = 500;
const PAGE_TAB = 1;
const OTHER_TAB = 2;
const OTHER_TAB_URL = "https://evil.test/";

function urlOf(origin) {
  return origin === "null" ? "about:blank" : `${origin}/login`;
}

function passwordOf(name) {
  return `pw:${name}`;
}

const OTP_CODE = "123456";

// The status line a fill that ended with model outcome `outcome` leaves,
// for secret `name`, and whether it is shown as an error.
function fillStatus(outcome, name, otpShown) {
  const t = globalThis.PASEJO.t;
  const otp = otpShown ? t("statusOtpShownSuffix") : "";
  const texts = {
    pageChanged: [t("statusPageChanged"), true],
    noAccess: [t("statusNoPageAccess", name), true],
    filled: [`${t("statusFilled", name)}${otp}`, false],
    refusedHidden: [`${t("statusFillRefusedHidden", name)}${otp}`, true],
    refusedOffscreen: [`${t("statusFillRefusedOffscreen", name)}${otp}`, true],
    refusedCovered: [`${t("statusFillRefusedCovered", name)}${otp}`, true],
    refusedOtherSite: [`${t("statusFillRefusedOtherSite", name)}${otp}`, true],
    refusedNoField: [`${t("statusNoFillablePassword", name)}${otp}`, true],
    revealRefused: [t("errorNotMatched"), true],
    revealError: [`${t("errorIdentityLocked")}${t("hostErrorHintSuffix", "model")}`, true],
    revealDropped: [t("statusHostUnreachable", "native host disconnected before reply"), true],
  };
  if (!(outcome in texts)) {
    throw new Error(`no status for fill outcome ${outcome}`);
  }
  const [text, error] = texts[outcome];
  return { text, error };
}

// What the fill script answers for a frame whose form is `field`.
function fillResult(field) {
  if (field === "fillable") {
    return { ok: true, filled: { username: true, password: true, otp: false } };
  }
  if (field === "none") {
    return { ok: false, error: "No password input found" };
  }
  return { ok: false, reason: field, error: `The field to fill is ${field}` };
}

// One entry of a `query` reply, the way the host describes a match.
function matchFor(catalog, name) {
  const secret = catalog.get(name);
  const match = {
    name,
    store: secret.store,
    username: secret.username,
    match_kind: secret.url ? "url_field" : "name",
    score: 1,
    confirm: secret.confirm,
  };
  if (secret.url) {
    match.url = urlOf(secret.url);
  }
  return match;
}

function queryReply(catalog, names) {
  return { results: [...names].sort().map((name) => matchFor(catalog, name)) };
}

function sorted(set) {
  return [...set].sort();
}

export function createHarness(initial) {
  const api = makeApiMock();
  const scheduler = installScheduler({ tag: () => api.__ports.length - 1 });
  globalThis.chrome = api;
  delete globalThis.browser;
  delete globalThis.PASEJO;

  const catalog = initial.catalog;
  // The browser the model describes. `ports` holds, per frame id, the
  // content-script end of the frame's live `pasejo-frame` port.
  const world = {
    activeTab: initial.activeTab,
    frames: initial.frames,
    focus: initial.focus,
    grant: initial.grant,
    reach: new Set(),
    ports: new Map(),
  };
  // Every fill message a frame received.
  const delivered = [];
  // Per native port index: the stream pair whose batch it carries, and
  // what the popup received on that stream.
  const streams = new Map();
  let streamPairPending = null;
  let session = null;

  const syncWorld = (m) => {
    world.activeTab = m.activeTab;
    world.frames = m.frames;
    world.focus = m.focus;
    world.grant = m.grant;
  };

  api.tabs.query = vi.fn(async () => {
    if (world.activeTab === PAGE_TAB) {
      return [{ id: PAGE_TAB, url: urlOf(world.frames.get(0).origin) }];
    }
    return [{ id: OTHER_TAB, url: OTHER_TAB_URL }];
  });
  api.storage.local.get = vi.fn().mockResolvedValue({});
  api.storage.local.set = vi.fn().mockResolvedValue();
  api.storage.local.remove = vi.fn().mockResolvedValue();
  window.close = vi.fn();

  // The popup's messages reach the background; a popup that has closed
  // never gets the reply.
  api.runtime.sendMessage = vi.fn((message) => {
    const sender = session;
    return invokeBackgroundListener(api, message).then((reply) =>
      sender.alive ? reply : new Promise(() => {}),
    );
  });

  const connect = api.runtime.connect;
  api.runtime.connect = vi.fn((options) => {
    const port = connect(options);
    const pair = api.__streamPairs.at(-1);
    const record = { pair, session, received: [] };
    port.onMessage.addListener((message) => record.received.push(message));
    session.streams.push(record);
    streamPairPending = record;
    return port;
  });
  const connectNative = api.runtime.connectNative;
  api.runtime.connectNative = vi.fn((name) => {
    const port = connectNative(name);
    if (streamPairPending !== null) {
      streams.set(api.__ports.length - 1, streamPairPending);
      streamPairPending = null;
    }
    return port;
  });

  // `activeTab` decides whether the browser injects at all; `world.reach`
  // (the model's pick) which of the page's frames it reaches.
  api.scripting.executeScript = vi.fn(async ({ target, files }) => {
    expect(files).toEqual(["content/fill.js"]);
    expect(target.tabId).toBe(PAGE_TAB);
    const top = world.frames.get(0);
    const grant = world.grant;
    if (!(grant.granted && grant.tab === PAGE_TAB && grant.origin === top.origin)) {
      throw new Error("Cannot access contents of the page");
    }
    const results = [];
    for (const frameId of [0, 1, 2]) {
      const frame = world.frames.get(frameId);
      if (!world.reach.has(frameId) || !frame.present) {
        continue;
      }
      const port = api.__connectFromContent("pasejo-frame", {
        tab: { id: PAGE_TAB },
        frameId,
        url: urlOf(frame.origin),
        origin: frame.origin,
      });
      world.ports.set(frameId, port);
      port.onDisconnect.addListener(() => {
        if (world.ports.get(frameId) === port) {
          world.ports.delete(frameId);
        }
      });
      port.onMessage.addListener((message) => {
        if (message.type !== "fill") {
          return;
        }
        const current = world.frames.get(frameId);
        delivered.push({
          frame: frameId,
          origin: current.origin,
          username: message.username,
          password: message.password,
        });
        port.postMessage({ type: "fill-result", ...fillResult(current.field) });
      });
      port.postMessage({
        type: "ready",
        focused: world.focus === frameId,
        editableFocused: false,
      });
      results.push({ frameId, result: true });
    }
    return results;
  });

  loadClassicScript("src/protocol.js");
  loadClassicScript("src/background.js");

  // The document of `frameId` goes away, and with it the fill script and
  // its port.
  const dropFrame = (frameId) => {
    const port = world.ports.get(frameId);
    if (port !== undefined) {
      world.ports.delete(frameId);
      port.disconnect();
    }
  };

  const nativePort = (index) => {
    const port = api.__ports[index];
    expect(port, `native port ${index}`).toBeDefined();
    return port;
  };

  const openPopup = async () => {
    buildPopupDom(document);
    const listeners = api.__onConnectListeners.length;
    session = { alive: true, streams: [], popup: null, listeners, attempts: 0 };
    session.popup = loadClassicScript("src/popup/popup.js", { expose: ["state", "elements"] });
    await settle();
    // The roster: both stores, `personal` the default.
    const roster = api.__ports.length - 1;
    expect(nativePort(roster).postMessage).toHaveBeenCalledWith({ action: "list_stores" });
    nativePort(roster).__emitMessage({
      protocol_version: 2,
      stores: [{ name: "personal", default: true }, { name: "work" }],
    });
    await settle();
  };

  const closePopup = async () => {
    session.alive = false;
    for (const record of session.streams) {
      record.pair.popupPort.disconnect();
    }
    for (const frameId of [0, 1, 2]) {
      dropFrame(frameId);
    }
    api.__onConnectListeners.splice(session.listeners, 1);
    await settle();
  };

  const rowOf = (name) => {
    const row = [...document.querySelectorAll("#results li")].find((li) => li.title === name);
    expect(row, `row ${name}`).toBeDefined();
    return row;
  };

  const confirmButtons = () => {
    const prompt = document.querySelector("#results .confirm");
    expect(prompt, "confirmation prompt").not.toBeNull();
    return prompt.querySelectorAll("button");
  };

  const answerHost = (m, index, outcome) => {
    const req = m.native.get(index);
    const port = nativePort(index);
    if (outcome === "drop") {
      port.__emitDisconnect();
      return;
    }
    if (outcome === "error") {
      port.__emitMessage({ error: "identity_locked", hint: "model" });
      return;
    }
    if (req.kind === "query") {
      port.__emitMessage(queryReply(catalog, req.names));
      return;
    }
    if (!req.matched) {
      port.__emitMessage({ error: "not_matched" });
      return;
    }
    const secret = catalog.get(req.name);
    const credential = {
      name: req.name,
      store: secret.store,
      username: secret.username,
      password: passwordOf(req.name),
    };
    if (req.otp) {
      credential.otp = OTP_CODE;
    }
    port.__emitMessage({ credential });
  };

  const answerStream = (m, index, rid, outcome) => {
    const port = nativePort(index);
    if (outcome === "error") {
      port.__emitMessage({ request_id: rid, error: "identity_locked" });
      return;
    }
    const slot = m.streams.get(index).posted.find((e) => e.index === rid - 1);
    port.__emitMessage({ request_id: rid, ...queryReply(catalog, slot.names) });
  };

  // Performs step `step` (the state it leaves is `step.s`) on the code.
  async function apply(step) {
    const { action, picks } = step;
    const m = step.s;
    switch (action) {
      case "OpenPopup":
        syncWorld(m);
        await openPopup();
        return;
      case "ClosePopup":
        await closePopup();
        return;
      case "ClickRow":
        world.reach = picks.reach;
        rowOf(picks.name).click();
        break;
      case "ArmConfirm":
        scheduler.fire((t) => t.ms === CONFIRM_ARM_DELAY_MS);
        break;
      case "ClickConfirm":
        world.reach = picks.reach;
        confirmButtons()[0].click();
        break;
      case "ClickCancel":
        confirmButtons()[1].click();
        break;
      case "SelectStore": {
        const select = session.popup.elements.store;
        select.value = picks.choice === "all" ? ALL_STORES : picks.choice;
        select.dispatchEvent(new Event("change"));
        break;
      }
      case "HostAnswer":
        answerHost(m, picks.port, picks.outcome);
        break;
      case "StreamReply":
        answerStream(m, picks.port, picks.rid, picks.outcome);
        break;
      case "StreamStray":
        nativePort(picks.port).__emitMessage({ request_id: picks.rid, results: [] });
        break;
      case "StreamTimeout":
        scheduler.fire((t) => t.ms === NATIVE_TIMEOUT_MS && t.tag === picks.port);
        break;
      case "StreamDrop":
        nativePort(picks.port).__emitDisconnect();
        break;
      case "NavigateTab":
        for (const frameId of [0, 1, 2]) {
          dropFrame(frameId);
        }
        syncWorld(m);
        break;
      case "SetFrame":
        dropFrame(picks.frame);
        syncWorld(m);
        break;
      case "SetField":
      case "SetFocus":
      case "SwitchTab":
      case "EditPolicy":
        syncWorld(m);
        break;
      default:
        throw new Error(`no replay for action ${action}`);
    }
    await settle();
  }

  // Compares the code with the model state `m` after step `at`.
  function check(m, at) {
    const where = (what) => `step ${at}: ${what}`;

    // Every native connection the code opened is one the model opened,
    // carrying the request the model sent.
    expect(api.__ports.length, where("native connections")).toBe(m.nextPort);
    for (const [index, req] of m.native) {
      // A connection the model has closed is one the code disconnected.
      expect(api.__ports[index].disconnect.mock.calls.length > 0, where(`port ${index} closed`)).toBe(
        !req.open,
      );
      const posted = api.__ports[index].postMessage.mock.calls.map(([msg]) => msg);
      if (req.kind === "list_stores") {
        expect(posted, where(`request on ${index}`)).toEqual([{ action: "list_stores" }]);
      } else if (req.kind === "query") {
        expect(posted, where(`request on ${index}`)).toEqual([
          { action: "query", domain: req.domain, store: req.store },
        ]);
      } else if (req.kind === "reveal") {
        expect(posted, where(`request on ${index}`)).toEqual([
          { action: "reveal", store: req.store, name: req.name, domain: req.domain },
        ]);
      } else {
        expect(posted, where(`requests on ${index}`)).toEqual(
          STORES.map((store, i) => ({
            request_id: i + 1,
            action: "query",
            domain: req.domain,
            store,
          })),
        );
      }
    }

    // Every credential a frame received, in order.
    expect(delivered, where("fills")).toEqual(
      m.delivered.map((d) => ({
        frame: d.frame,
        origin: d.origin,
        username: catalog.get(d.name).username,
        password: passwordOf(d.name),
      })),
    );

    // Which frames hold a live fill-script port.
    for (const [frameId, frame] of m.frames) {
      expect(world.ports.has(frameId), where(`port of frame ${frameId}`)).toBe(frame.port);
    }

    // What every stream posted to its popup: the reply to request id
    // `index + 1`, for that request's store, then `done`.
    for (const [index, stream] of m.streams) {
      const record = streams.get(index);
      expect(record, where(`stream on ${index}`)).toBeDefined();
      expect(
        record.received.map((msg) => (msg.type === "done" ? -1 : msg.index)),
        where(`stream ${index} messages`),
      ).toEqual(stream.posted.map((e) => e.index));
      stream.posted.forEach((e, i) => {
        const msg = record.received[i];
        if (e.index === -1) {
          expect(msg, where("done")).toEqual({ type: "done" });
        } else if (e.outcome === "answer") {
          expect(msg.response, where(`stream ${index} slot ${e.index}`)).toEqual(
            queryReply(catalog, e.names),
          );
          for (const result of msg.response.results) {
            expect(result.store, where("slot store")).toBe(STORES[e.index]);
          }
        } else {
          expect(msg.response.error, where(`stream ${index} slot ${e.index}`)).toBe(
            e.outcome === "error" ? "identity_locked" : "transport_error",
          );
        }
      });
    }

    if (!m.popup.open) {
      return;
    }
    const titles = [...document.querySelectorAll("#results li")].map((li) => li.title);
    expect(titles.sort(), where("rows")).toEqual(sorted(m.popup.rows));
    const prompt = document.querySelector("#results .confirm");
    expect(prompt?.closest("li")?.title ?? "", where("confirmation prompt")).toBe(
      m.popup.confirming,
    );
    if (prompt !== null) {
      expect(
        prompt.querySelector("button").getAttribute("aria-disabled") !== "true",
        where("prompt armed"),
      ).toBe(m.popup.armed);
    }
    expect(session.popup.state.filling, where("filling")).toBe(m.popup.filling);

    // A fill that ended in this step left its outcome on the status line.
    if (m.popup.attempts !== session.attempts) {
      session.attempts = m.popup.attempts;
      const status = session.popup.elements.status;
      const expected = fillStatus(m.popup.outcome, m.popup.filled, m.popup.otpShown);
      // A long status is cut short on screen and kept whole in `title`.
      expect(
        status.getAttribute("title") ?? status.textContent,
        where(`status after ${m.popup.outcome}`),
      ).toBe(expected.text);
      expect(status.classList.contains("error"), where("status kind")).toBe(expected.error);
    }
  }

  return {
    apply,
    check,
    dispose() {
      scheduler.restore();
      delete globalThis.chrome;
      delete globalThis.PASEJO;
      document.body.innerHTML = "";
    },
  };
}

// Replays decoded trace `steps` (see `decodeTrace`) against the code.
export async function replay(steps) {
  const harness = createHarness(steps[0].s);
  try {
    for (let at = 1; at < steps.length; at += 1) {
      await harness.apply(steps[at]);
      harness.check(steps[at].s, at);
    }
  } finally {
    harness.dispose();
  }
}
