// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

// The extension as a state machine: the popup (src/popup/popup.js), the
// background's native requests and multi-store stream
// (src/background.js), driven by the browser (module web) and answered by
// the native host (module host).
//
// One step is one event the extension cannot control: a user click, a
// reply from the host, a navigation, a timer. Between two events the code
// runs until it waits on the host again, and each transition below
// computes that whole run. tests/model-replay.test.js replays traces of
// this machine against the real scripts and compares the two after every
// step.
module extension {
  import web.* from "./web"
  import host.* from "./host"

  // One native-messaging connection. `kind` is the action sent (or
  // "stream" for the multi-store batch), `purpose` what the popup does
  // with the reply: "roster", "results" (the list), "check" (may a frame
  // on another host get the credential), "fill" (the reveal) or "stream".
  // `outcome` stays "" until the host answers: "answer", "error" or
  // "drop" (the connection closes without a reply). `names`, `matched`
  // and `otp` describe the reply.
  type Req = {
    kind: str,
    purpose: str,
    store: str,
    domain: str,
    name: str,
    session: int,
    gen: int,
    pageOrigin: str,
    open: bool,
    outcome: str,
    names: Set[str],
    matched: bool,
    otp: bool,
  }

  // A message the background posted on a stream port: a result for slot
  // `index` (the reply to request id `index + 1`, for `store`), or the
  // final `done` with index -1.
  type Posted = { index: int, store: str, outcome: str, names: Set[str] }

  // A multi-store batch, keyed by its native connection. `pending` holds
  // the request ids without a settled reply.
  type Stream = {
    session: int,
    gen: int,
    domain: str,
    pending: Set[int],
    posted: List[Posted],
    done: bool,
    abandoned: bool,
  }

  // The frame walk of one fill (`fillAcrossFrames`): the frames that
  // reported ready, in the order the walk tries them, with the origin the
  // browser stamped on each port; the host verdicts for frames on other
  // hosts; and whether the credential has been released. `waiting` is
  // "check" or "reveal" while the walk waits on connection `port`.
  // `refused` counts the frames the walk would not send the credential
  // to, `reason` is the first visible-field refusal a frame gave.
  type Walk = {
    active: bool,
    name: str,
    store: str,
    order: List[int],
    origins: int -> str,
    pos: int,
    lookups: str -> bool,
    waiting: str,
    checking: str,
    port: int,
    revealed: bool,
    otp: bool,
    refused: int,
    reason: str,
  }

  pure val NO_WALK: Walk = {
    active: false,
    name: "",
    store: "",
    order: List(),
    origins: Map(),
    pos: 0,
    lookups: Map(),
    waiting: "",
    checking: "",
    port: -1,
    revealed: false,
    otp: false,
    refused: 0,
    reason: "",
  }

  // The popup of one session. `origin` is the page it opened on, `gen`
  // its query generation, `store` the dropdown choice ("all" for every
  // store), `rows` the secret names it lists, `confirming` the row whose
  // confirmation prompt is open, `filling` the double-click guard.
  // `attempts` counts the fills that ended, `outcome` says how the last
  // one ended: "pageChanged", "noAccess", "filled", a refusal (see
  // `REFUSALS`), "revealRefused" (the host's re-check said no),
  // "revealError" or "revealDropped"; `filled` the secret it was for,
  // `otpShown` whether it left the released code on the row.
  type Popup = {
    open: bool,
    session: int,
    origin: str,
    gen: int,
    store: str,
    rows: Set[str],
    confirming: str,
    armed: bool,
    filling: bool,
    walk: Walk,
    attempts: int,
    outcome: str,
    filled: str,
    otpShown: bool,
  }

  pure val CLOSED_POPUP: Popup = {
    open: false,
    session: 0,
    origin: NULL_ORIGIN,
    gen: 0,
    store: "",
    rows: Set(),
    confirming: "",
    armed: false,
    filling: false,
    walk: NO_WALK,
    attempts: 0,
    outcome: "",
    filled: "",
    otpShown: false,
  }

  // A credential the host released to the extension.
  type Release = {
    session: int,
    store: str,
    name: str,
    domain: str,
    pageOrigin: str,
    otp: bool,
    policy: str,
  }

  // A fill message carrying a credential, as a frame received it, with
  // the state of the tab at that moment.
  type Delivery = {
    session: int,
    name: str,
    frame: int,
    origin: str,
    topOrigin: str,
    pageOrigin: str,
    tab: int,
    policy: str,
    granted: bool,
    port: bool,
  }

  type State = {
    catalog: str -> Secret,
    policy: str -> str,
    activeTab: int,
    frames: int -> Frame,
    focus: int,
    grant: Grant,
    popup: Popup,
    sessions: int,
    native: int -> Req,
    nextPort: int,
    streams: int -> Stream,
    releases: List[Release],
    delivered: List[Delivery],
    intents: Set[(int, str)],
    confirmed: Set[(int, str)],
  }

  pure val OUTCOMES = Set("answer", "error", "drop")
  pure val STREAM_OUTCOMES = Set("answer", "error")
  pure val CHOICES = Set("personal", "work", "all")
  pure val REQUEST_IDS = Set(1, 2)

  pure def newReq(kind: str, purpose: str, store: str, domain: str, name: str, popup: Popup): Req = {
    kind: kind,
    purpose: purpose,
    store: store,
    domain: domain,
    name: name,
    session: popup.session,
    gen: popup.gen,
    pageOrigin: popup.origin,
    open: true,
    outcome: "",
    names: Set(),
    matched: false,
    otp: false,
  }

  pure def openNative(st: State, req: Req): State =
    { ...st, native: st.native.put(st.nextPort, req), nextPort: st.nextPort + 1 }

  pure def initialState(origin: str, content: str): State = {
    catalog: CATALOG,
    policy: INITIAL_POLICY,
    activeTab: PAGE_TAB,
    frames: Map(0 -> newDocument(origin, content), 1 -> NO_FRAME, 2 -> NO_FRAME),
    focus: -1,
    grant: NO_GRANT,
    popup: CLOSED_POPUP,
    sessions: 0,
    native: Map(),
    nextPort: 0,
    streams: Map(),
    releases: List(),
    delivered: List(),
    intents: Set(),
    confirmed: Set(),
  }

  pure def pageHost(st: State): str = hostOf(st.popup.origin)

  pure def activeTabOrigin(st: State): str =
    if (st.activeTab == PAGE_TAB) st.frames.get(TOP).origin else OTHER_TAB_ORIGIN

  pure def closePorts(frames: int -> Frame): int -> Frame =
    frames.keys().mapBy(f => { ...frames.get(f), port: false })

  pure def presentFrames(st: State): Set[int] =
    st.frames.keys().filter(f => st.frames.get(f).present)

  // ---------------------------------------------------------------- popup

  // The user goes to the page tab and clicks the toolbar button: the
  // browser grants `activeTab` for the tab and its origin, the popup
  // records the page, asks for the store roster (which the model takes as
  // answered with both stores) and queries the default store.
  pure def openPopup(st: State): State =
    val origin = st.frames.get(TOP).origin
    val session = st.sessions + 1
    val popup = { ...CLOSED_POPUP, open: true, session: session, origin: origin, gen: 1, store: "personal" }
    val st1 = {
      ...st,
      activeTab: PAGE_TAB,
      popup: popup,
      sessions: session,
      grant: { granted: true, tab: PAGE_TAB, origin: origin },
    }
    val roster = { ...newReq("list_stores", "roster", "", "", "", popup), open: false, outcome: "answer" }
    openNative(openNative(st1, roster), newReq("query", "results", "personal", hostOf(origin), "", popup))

  pure def ended(st: State, outcome: str, otp: bool): State = {
    ...st,
    frames: closePorts(st.frames),
    popup: {
      ...st.popup,
      filling: outcome == "filled" and not(otp),
      walk: NO_WALK,
      attempts: st.popup.attempts + 1,
      outcome: outcome,
      filled: st.popup.walk.name,
      otpShown: otp,
    },
  }

  // A fill that stops before any frame is tried.
  pure def stopped(st: State, name: str, outcome: str): State =
    { ...st, popup: { ...st.popup, attempts: st.popup.attempts + 1, outcome: outcome, filled: name, otpShown: false } }

  // How a walk that filled nothing ended: a frame's visible-field check
  // refused, a frame on another site was skipped, or no frame had a field.
  pure val REFUSALS: str -> str = Map(
    "hidden" -> "refusedHidden",
    "offscreen" -> "refusedOffscreen",
    "covered" -> "refusedCovered",
  )

  pure def refusal(w: Walk): str =
    if (w.reason != "") REFUSALS.get(w.reason)
    else if (w.refused > 0) "refusedOtherSite"
    else "refusedNoField"

  type WalkAcc = { walk: Walk, stop: bool, result: str, need: str, host: str, deliveries: List[int] }

  // One frame of the walk: decide whether the frame may get the
  // credential, release it before the first frame that may, and send the
  // fill. Stops when it has to wait on the host or a frame filled.
  pure def walkFrame(acc: WalkAcc, frames: int -> Frame, page: str, urlHost: str): WalkAcc =
    if (acc.stop) acc
    else if (acc.walk.pos >= acc.walk.order.length()) { ...acc, stop: true, result: "refused" }
    else
      val f = acc.walk.order[acc.walk.pos]
      val h = hostOf(acc.walk.origins.get(f))
      val cached = acc.walk.lookups.keys().contains(h)
      val known = h == "" or h == page or h == urlHost or cached
      val allowed = h != "" and (h == page or h == urlHost or (cached and acc.walk.lookups.get(h)))
      val advanced = { ...acc.walk, pos: acc.walk.pos + 1 }
      if (not(known)) { ...acc, stop: true, need: "check", host: h }
      else if (not(allowed)) { ...acc, walk: { ...advanced, refused: acc.walk.refused + 1 } }
      else if (not(acc.walk.revealed)) { ...acc, stop: true, need: "reveal" }
      else if (not(frames.get(f).port)) { ...acc, walk: advanced }
      else if (frames.get(f).field == "fillable") { ...acc, stop: true, result: "ok", deliveries: acc.deliveries.append(f) }
      else
        val form = frames.get(f).field
        val reason = if (acc.walk.reason == "" and form != "none") form else acc.walk.reason
        { ...acc, walk: { ...advanced, reason: reason }, deliveries: acc.deliveries.append(f) }

  pure def delivery(st: State, name: str, f: int): Delivery = {
    session: st.popup.session,
    name: name,
    frame: f,
    origin: st.frames.get(f).origin,
    topOrigin: st.frames.get(TOP).origin,
    pageOrigin: st.popup.origin,
    tab: PAGE_TAB,
    policy: st.policy.get(name),
    granted: covers(st.grant, PAGE_TAB, st.frames.get(TOP).origin),
    port: st.frames.get(f).port,
  }

  // Runs the walk from its position until it waits on the host or ends.
  pure def runWalk(st: State): State =
    val w = st.popup.walk
    val start: WalkAcc = { walk: w, stop: false, result: "", need: "", host: "", deliveries: List() }
    val urlHost = hostOf(st.catalog.get(w.name).url)
    val acc = List(0, 1, 2, 3).foldl(start, (a, i) => walkFrame(a, st.frames, pageHost(st), urlHost))
    val delivered = acc.deliveries.foldl(st.delivered, (l, f) => l.append(delivery(st, w.name, f)))
    val st1 = { ...st, delivered: delivered }
    if (acc.need == "check")
      val walk = { ...acc.walk, waiting: "check", checking: acc.host, port: st.nextPort }
      openNative({ ...st1, popup: { ...st.popup, walk: walk } }, newReq("query", "check", w.store, acc.host, "", st.popup))
    else if (acc.need == "reveal")
      val walk = { ...acc.walk, waiting: "reveal", port: st.nextPort }
      openNative({ ...st1, popup: { ...st.popup, walk: walk } }, newReq("reveal", "fill", w.store, pageHost(st), w.name, st.popup))
    else ended({ ...st1, popup: { ...st.popup, walk: acc.walk } }, if (acc.result == "ok") "filled" else refusal(acc.walk), acc.walk.otp)

  // `fillIntoActiveTab` past its confirmation gate: re-check the active
  // tab, inject the fill script into the frames the browser reaches
  // (`reach`, any subset of the page's frames), stop when the top frame
  // reports another origin, then walk the frames.
  pure def startFill(st: State, name: str, reach: Set[int]): State =
    val p = st.popup
    if (p.filling) st
    else
      val st1 = { ...st, intents: st.intents.union(Set((p.session, name))) }
      val samePage = p.origin != NULL_ORIGIN and st.activeTab == PAGE_TAB and activeTabOrigin(st) == p.origin
      if (not(samePage)) stopped(st1, name, "pageChanged")
      else if (not(covers(st.grant, PAGE_TAB, st.frames.get(TOP).origin))) stopped(st1, name, "noAccess")
      else
        val reached = reach.filter(f => st.frames.get(f).present)
        val frames = st.frames.keys().mapBy(f => { ...st.frames.get(f), port: reached.contains(f) })
        val inOrder = FRAME_IDS.select(f => reached.contains(f))
        val order =
          if (reached.contains(st.focus)) List(st.focus).concat(inOrder.select(f => f != st.focus))
          else inOrder
        if (reached.contains(TOP) and st.frames.get(TOP).origin != p.origin)
          stopped({ ...st1, frames: closePorts(frames) }, name, "pageChanged")
        else
          val walk = {
            ...NO_WALK,
            active: true,
            name: name,
            store: st.catalog.get(name).store,
            order: order,
            origins: reached.mapBy(f => st.frames.get(f).origin),
          }
          runWalk({ ...st1, frames: frames, popup: { ...p, filling: true, walk: walk } })

  // A click on a row (or its Fill button). A secret that asks for
  // confirmation opens the prompt instead; nothing is released.
  pure def clickRow(st: State, name: str, reach: Set[int]): State =
    if (st.popup.filling) st
    else if (st.catalog.get(name).confirm)
      if (st.popup.confirming == name) st
      else { ...st, popup: { ...st.popup, confirming: name, armed: false } }
    else startFill(st, name, reach)

  pure def armConfirm(st: State): State =
    { ...st, popup: { ...st.popup, armed: true } }

  // The prompt's Fill now button. Until the arm delay passed it ignores
  // clicks, so the second click of a double-click cannot confirm.
  pure def clickConfirm(st: State, reach: Set[int]): State =
    if (not(st.popup.armed)) st
    else
      val name = st.popup.confirming
      val st1 = { ...st, popup: { ...st.popup, confirming: "", armed: false } }
      startFill({ ...st1, confirmed: st.confirmed.union(Set((st.popup.session, name))) }, name, reach)

  pure def clickCancel(st: State): State =
    { ...st, popup: { ...st.popup, confirming: "", armed: false } }

  // A new dropdown choice: `runQuery` bumps the generation, closes the
  // prompt, clears the list and queries one store or streams all.
  pure def selectStore(st: State, choice: str): State =
    val popup = { ...st.popup, store: choice, gen: st.popup.gen + 1, rows: Set(), confirming: "", armed: false }
    val st1 = { ...st, popup: popup }
    if (choice == "all")
      val stream = { session: popup.session, gen: popup.gen, domain: pageHost(st), pending: REQUEST_IDS, posted: List(), done: false, abandoned: false }
      openNative({ ...st1, streams: st.streams.put(st.nextPort, stream) }, newReq("stream", "stream", "", pageHost(st), "", popup))
    else openNative(st1, newReq("query", "results", choice, pageHost(st), "", popup))

  // ----------------------------------------------------------------- host

  // The host answers connection `port`: a query lists the matching
  // secrets, a reveal releases the credential when the secret still
  // matches the domain. The popup that sent it reacts if it is still open.
  pure def hostAnswer(st: State, port: int, outcome: str): State =
    val req = st.native.get(port)
    val answered = outcome == "answer"
    val names = if (answered and req.kind == "query") queryNames(st.catalog, st.policy, req.store, req.domain) else Set()
    val matched = answered and req.kind == "reveal" and revealMatches(st.catalog, st.policy, req.store, req.name, req.domain)
    val otp = matched and revealOtp(st.catalog, st.policy, req.name, req.domain)
    val release = {
      session: req.session,
      store: req.store,
      name: req.name,
      domain: req.domain,
      pageOrigin: req.pageOrigin,
      otp: otp,
      policy: st.policy.get(req.name),
    }
    val st1 = {
      ...st,
      native: st.native.set(port, { ...req, open: false, outcome: outcome, names: names, matched: matched, otp: otp }),
      releases: if (matched) st.releases.append(release) else st.releases,
    }
    val p = st1.popup
    val w = p.walk
    if (not(p.open) or p.session != req.session) st1
    else if (req.purpose == "results")
      if (req.gen == p.gen) { ...st1, popup: { ...p, rows: names } } else st1
    else if (req.purpose == "check" and w.active and w.waiting == "check" and w.port == port)
      val verdict = answered and names.contains(w.name)
      runWalk({ ...st1, popup: { ...p, walk: { ...w, waiting: "", lookups: w.lookups.put(w.checking, verdict) } } })
    else if (req.purpose == "fill" and w.active and w.waiting == "reveal" and w.port == port)
      if (matched) runWalk({ ...st1, popup: { ...p, walk: { ...w, waiting: "", revealed: true, otp: otp } } })
      else
        val failure = if (outcome == "answer") "revealRefused" else if (outcome == "error") "revealError" else "revealDropped"
        ended(st1, failure, false)
    else st1

  pure def streamSlot(st: State, port: int, rid: int, outcome: str): State =
    val s = st.streams.get(port)
    val store = STORES[rid - 1]
    val names = if (outcome == "answer") queryNames(st.catalog, st.policy, store, s.domain) else Set()
    val posted = s.posted.append({ index: rid - 1, store: store, outcome: outcome, names: names })
    val pending = s.pending.exclude(Set(rid))
    val done = pending.size() == 0
    val stream = {
      ...s,
      pending: pending,
      done: done,
      posted: if (done) posted.append({ index: -1, store: "", outcome: "done", names: Set() }) else posted,
    }
    val p = st.popup
    val current = p.open and p.session == s.session and p.gen == s.gen
    // The popup redraws the whole list for every slot, which removes an
    // open confirmation prompt from view.
    {
      ...st,
      streams: st.streams.set(port, stream),
      native: if (done) st.native.set(port, { ...st.native.get(port), open: false }) else st.native,
      popup: if (current) { ...p, rows: p.rows.union(names), confirming: "", armed: false } else p,
    }

  // The host answers request id `rid` on stream `port`.
  pure def streamReply(st: State, port: int, rid: int, outcome: str): State =
    streamSlot(st, port, rid, outcome)

  // Every pending slot settles as a transport error, in request-id order:
  // the per-request timers fire, or the native connection closes.
  pure def streamFail(st: State, port: int): State =
    List(1, 2).foldl(st, (acc, rid) =>
      if (acc.streams.get(port).pending.contains(rid)) streamSlot(acc, port, rid, "transport") else acc)

  pure def streamOpen(st: State, port: int): bool =
    val s = st.streams.get(port)
    not(s.done) and not(s.abandoned)

  // ---------------------------------------------------------- environment

  // The popup closes: its port to the background and the frame ports go
  // away, the background abandons its streams. The host still answers
  // what it was asked.
  pure def closePopup(st: State): State =
    val session = st.popup.session
    val abandon = st.streams.keys().filter(q => st.streams.get(q).session == session and streamOpen(st, q))
    {
      ...st,
      popup: { ...CLOSED_POPUP, session: session },
      frames: closePorts(st.frames),
      streams: st.streams.keys().mapBy(q => if (abandon.contains(q)) { ...st.streams.get(q), abandoned: true } else st.streams.get(q)),
      native: st.native.keys().mapBy(q => if (abandon.contains(q)) { ...st.native.get(q), open: false } else st.native.get(q)),
    }

  pure def navigateTab(st: State, origin: str, content: str, keep: bool): State = {
    ...st,
    frames: Map(0 -> newDocument(origin, content), 1 -> NO_FRAME, 2 -> NO_FRAME),
    focus: -1,
    grant: afterNavigation(st.grant, PAGE_TAB, origin, keep),
  }

  // An iframe is added, navigates (to `origin`) or is removed.
  pure def setFrame(st: State, f: int, present: bool, origin: str, content: str): State = {
    ...st,
    frames: st.frames.set(f, if (present) newDocument(origin, content) else NO_FRAME),
    focus: if (st.focus == f) -1 else st.focus,
  }

  // The page changes a frame's form without navigating.
  pure def setField(st: State, f: int, content: str): State =
    { ...st, frames: st.frames.set(f, { ...st.frames.get(f), field: content }) }

  pure def setFocus(st: State, f: int): State = { ...st, focus: f }

  pure def switchTab(st: State): State =
    { ...st, activeTab: if (st.activeTab == PAGE_TAB) OTHER_TAB else PAGE_TAB }

  // The store is edited outside the browser, e.g. `pasejo secret edit`.
  pure def editPolicy(st: State, name: str, policy: str): State =
    { ...st, policy: st.policy.set(name, policy) }

  // ---------------------------------------------------------- invariants

  // A credential reaches only a frame of the page's tab whose
  // browser-reported origin the secret names under the host's rule, and
  // never one its fill policy rules out.
  pure def fillOnlyIntoMatchingFramesIn(st: State): bool =
    st.delivered.foldl(true, (ok, d) =>
      val secret = st.catalog.get(d.name)
      val h = hostOf(d.origin)
      ok and d.tab == PAGE_TAB and h != "" and namesHost(secret, h) and d.policy != "never"
        and (d.policy == "exact-host" implies h == hostOf(secret.url)))

  // A credential reaches a frame only while the tab still shows the
  // origin the popup opened on, the `activeTab` grant still covers it, and
  // the frame's port is the one the fill script opened.
  pure def fillOnlyOnQueriedPageIn(st: State): bool =
    st.delivered.foldl(true, (ok, d) => ok and d.topOrigin == d.pageOrigin and d.granted and d.port)

  // The host releases a credential only after the user picked that secret
  // in the same popup session, and only for the page that popup opened on.
  pure def revealOnlyAfterClickIn(st: State): bool =
    st.releases.foldl(true, (ok, r) => ok and st.intents.contains((r.session, r.name)) and r.domain == hostOf(r.pageOrigin))

  // A secret that asks for confirmation is released only after the user
  // confirmed the prompt of that session.
  pure def confirmBeforeRevealIn(st: State): bool =
    st.releases.foldl(true, (ok, r) => ok and (st.catalog.get(r.name).confirm implies st.confirmed.contains((r.session, r.name))))

  pure def neverPolicyNeverReleasedIn(st: State): bool =
    st.releases.foldl(true, (ok, r) => ok and r.policy != "never")

  pure def otpOnlyForExactHostIn(st: State): bool =
    st.releases.foldl(true, (ok, r) => ok and (r.otp implies hostOf(st.catalog.get(r.name).url) == r.domain))

  pure def resultIndices(s: Stream): List[int] =
    s.posted.select(e => e.index >= 0).foldl(List(), (l, e) => l.append(e.index))

  // Every result a stream posts is the reply to the request whose id is
  // its index plus one, for that request's store; each slot is posted at
  // most once; `done` comes once, last, after every slot.
  pure def streamCorrelatesRepliesIn(st: State): bool =
    st.streams.keys().forall(q =>
      val s = st.streams.get(q)
      val slots = resultIndices(s)
      val doneAt = s.posted.indices().filter(i => s.posted[i].index == -1)
      and {
        s.posted.foldl(true, (ok, e) => ok and (e.index == -1 or STORES[e.index] == e.store)),
        slots.indices().forall(i => slots.indices().forall(j => i == j or slots[i] != slots[j])),
        slots.foldl(true, (ok, i) => ok and i >= 0 and i < STORES.length()),
        s.done iff doneAt.size() == 1,
        s.done implies (doneAt.contains(s.posted.length() - 1) and slots.length() == STORES.length()),
        not(s.done) implies doneAt.size() == 0,
      })

  // A stream that has not ended still has a pending slot and a live
  // native connection, and its per-request timers, which are armed for
  // every pending slot, end it when they fire. An ended stream's
  // connection is closed. Every stream therefore ends with `done` or the
  // popup's disconnect.
  pure def streamAlwaysEndsIn(st: State): bool =
    st.streams.keys().forall(q =>
      val s = st.streams.get(q)
      if (s.done or s.abandoned) not(st.native.get(q).open)
      else s.pending.size() > 0 and st.native.get(q).open and streamFail(st, q).streams.get(q).done)

  // The names the host returned to the popup's current query: the list
  // reply of its generation, or every slot of its stream.
  pure def listedNames(st: State): Set[str] =
    val p = st.popup
    val replies = st.native.keys().filter(q =>
      val r = st.native.get(q)
      r.purpose == "results" and r.session == p.session and r.gen == p.gen)
    val streams = st.streams.keys().filter(q => st.streams.get(q).session == p.session and st.streams.get(q).gen == p.gen)
    replies.fold(Set(), (acc, q) => acc.union(st.native.get(q).names)).union(
      streams.fold(Set(), (acc, q) => st.streams.get(q).posted.foldl(acc, (a, e) => a.union(e.names))))

  // The popup lists only secrets the host returned for its current query,
  // and nothing once it is closed.
  pure def rowsComeFromHostRepliesIn(st: State): bool =
    st.popup.rows.subseteq(listedNames(st)) and (not(st.popup.open) implies st.popup.rows == Set())

  pure def allInvariantsIn(st: State): bool = and {
    fillOnlyIntoMatchingFramesIn(st),
    fillOnlyOnQueriedPageIn(st),
    revealOnlyAfterClickIn(st),
    confirmBeforeRevealIn(st),
    neverPolicyNeverReleasedIn(st),
    otpOnlyForExactHostIn(st),
    streamCorrelatesRepliesIn(st),
    streamAlwaysEndsIn(st),
    rowsComeFromHostRepliesIn(st),
  }

  // ---------------------------------------------------------- the machine

  var s: State

  val fillOnlyIntoMatchingFrames = fillOnlyIntoMatchingFramesIn(s)
  val fillOnlyOnQueriedPage = fillOnlyOnQueriedPageIn(s)
  val revealOnlyAfterClick = revealOnlyAfterClickIn(s)
  val confirmBeforeReveal = confirmBeforeRevealIn(s)
  val neverPolicyNeverReleased = neverPolicyNeverReleasedIn(s)
  val otpOnlyForExactHost = otpOnlyForExactHostIn(s)
  val streamCorrelatesReplies = streamCorrelatesRepliesIn(s)
  val streamAlwaysEnds = streamAlwaysEndsIn(s)
  val rowsComeFromHostReplies = rowsComeFromHostRepliesIn(s)
  val allInvariants = allInvariantsIn(s)

  action init = {
    nondet origin = WEB_ORIGINS.oneOf()
    nondet content = FIELDS.oneOf()
    s' = initialState(origin, content)
  }

  action OpenPopup = all {
    not(s.popup.open),
    s' = openPopup(s),
  }

  action ClosePopup = all {
    s.popup.open,
    s' = closePopup(s),
  }

  action ClickRow = all {
    s.popup.open,
    s.popup.rows.size() > 0,
    nondet name = s.popup.rows.oneOf()
    nondet reach = presentFrames(s).powerset().oneOf()
    s' = clickRow(s, name, reach),
  }

  action ArmConfirm = all {
    s.popup.open,
    s.popup.confirming != "",
    not(s.popup.armed),
    s' = armConfirm(s),
  }

  action ClickConfirm = all {
    s.popup.open,
    s.popup.confirming != "",
    nondet reach = presentFrames(s).powerset().oneOf()
    s' = clickConfirm(s, reach),
  }

  action ClickCancel = all {
    s.popup.open,
    s.popup.confirming != "",
    s' = clickCancel(s),
  }

  action SelectStore = all {
    s.popup.open,
    nondet choice = CHOICES.exclude(Set(s.popup.store)).oneOf()
    s' = selectStore(s, choice),
  }

  action HostAnswer = {
    val waiting = s.native.keys().filter(q => s.native.get(q).open and s.native.get(q).kind != "stream")
    all {
      waiting.size() > 0,
      nondet port = waiting.oneOf()
      nondet outcome = OUTCOMES.oneOf()
      s' = hostAnswer(s, port, outcome),
    }
  }

  action StreamReply = {
    val open = s.streams.keys().filter(q => streamOpen(s, q))
    all {
      open.size() > 0,
      nondet port = open.oneOf()
      nondet rid = REQUEST_IDS.oneOf()
      nondet outcome = STREAM_OUTCOMES.oneOf()
      all {
        s.streams.get(port).pending.contains(rid),
        s' = streamReply(s, port, rid, outcome),
      },
    }
  }

  // A reply the background must drop: an id it never sent (0, 3) or one
  // it already settled.
  action StreamStray = {
    val open = s.streams.keys().filter(q => streamOpen(s, q))
    all {
      open.size() > 0,
      nondet port = open.oneOf()
      nondet rid = Set(0, 1, 2, 3).oneOf()
      all {
        not(s.streams.get(port).pending.contains(rid)),
        s' = s,
      },
    }
  }

  action StreamTimeout = {
    val open = s.streams.keys().filter(q => streamOpen(s, q))
    all {
      open.size() > 0,
      nondet port = open.oneOf()
      s' = streamFail(s, port),
    }
  }

  action StreamDrop = {
    val open = s.streams.keys().filter(q => streamOpen(s, q))
    all {
      open.size() > 0,
      nondet port = open.oneOf()
      s' = streamFail(s, port),
    }
  }

  action NavigateTab = {
    nondet origin = WEB_ORIGINS.oneOf()
    nondet content = FIELDS.oneOf()
    nondet keep = Set(true, false).oneOf()
    s' = navigateTab(s, origin, content, keep)
  }

  action SetFrame = {
    nondet frame = SUBFRAMES.oneOf()
    nondet present = Set(true, false).oneOf()
    nondet origin = ORIGINS.oneOf()
    nondet content = FIELDS.oneOf()
    s' = setFrame(s, frame, present, origin, content)
  }

  action SetField = all {
    nondet frame = presentFrames(s).oneOf()
    nondet content = FIELDS.oneOf()
    s' = setField(s, frame, content),
  }

  action SetFocus = {
    nondet frame = presentFrames(s).union(Set(-1)).oneOf()
    s' = setFocus(s, frame)
  }

  action SwitchTab = s' = switchTab(s)

  // Only between fills: a store edit during a walk could leave the walk's
  // cached frame verdicts out of date for the rest of that one fill.
  action EditPolicy = all {
    not(s.popup.walk.active),
    nondet name = NAMES.oneOf()
    nondet policy = POLICIES.oneOf()
    s' = editPolicy(s, name, policy),
  }

  // The page and the store change behind the extension's back.
  action Environment = any {
    NavigateTab,
    SetFrame,
    SetField,
    SetFocus,
    SwitchTab,
    EditPolicy,
  }

  // Events that cut a flow short are grouped into one choice, so a random
  // run reaches the end of a fill often enough while still interleaving
  // them at every point.
  action Interruption = any {
    ClosePopup,
    SelectStore,
    StreamDrop,
    Environment,
  }

  action step = any {
    OpenPopup,
    ClickRow,
    ArmConfirm,
    ClickConfirm,
    ClickCancel,
    HostAnswer,
    StreamReply,
    StreamStray,
    StreamTimeout,
    Interruption,
  }
}
