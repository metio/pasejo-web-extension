// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

// Situations worth reaching. `npm run model:simulate` counts how many
// random runs reach each one (`--witnesses`); the replay suite asks for a
// run that stops at the first state where one holds
// (`--invariant 'not(<name>)'`) and replays that path against the code.
module scenarios {
  import web.* from "./web"
  import host.* from "./host"
  import extension.* from "./extension"

  pure def deliveredTo(st: State, pred: (Delivery) => bool): bool =
    st.delivered.foldl(false, (found, d) => found or pred(d))

  // A frame received a credential.
  val filled = s.delivered.length() > 0

  // An iframe received a credential.
  val filledIframe = deliveredTo(s, d => d.frame != TOP)

  // A fill went ahead after the host was asked about a frame's host.
  val filledAfterFrameCheck = and {
    s.delivered.length() > 0,
    s.native.keys().exists(q => s.native.get(q).purpose == "check" and s.native.get(q).outcome == "answer"),
  }

  // A secret behind a confirmation prompt was filled.
  val filledAfterConfirmation = deliveredTo(s, d => s.catalog.get(d.name).confirm)

  // A secret of the second store was filled.
  val filledFromSecondStore = deliveredTo(s, d => s.catalog.get(d.name).store == "work")

  // One popup session sent the credential to two frames: the first one
  // refused it.
  val triedSecondFrame = s.delivered.indices().exists(i =>
    i > 0 and s.delivered[i - 1].session == s.delivered[i].session)

  // The host released a TOTP code.
  val releasedOtp = s.releases.foldl(false, (found, r) => found or r.otp)

  // The host released a credential that no frame received.
  val releasedWithoutFill = s.releases.foldl(false, (found, r) =>
    found or not(deliveredTo(s, d => d.session == r.session and d.name == r.name)))

  // The host refused a reveal at click time.
  val refusedReveal = s.native.keys().exists(q =>
    val r = s.native.get(q)
    r.kind == "reveal" and r.outcome == "answer" and not(r.matched))

  // The credential was released for a frame that went away while the
  // reveal waited, and the popup is still open.
  val releasedForGoneFrame = s.popup.open and not(s.popup.walk.active) and s.releases.foldl(false, (found, r) =>
    found or (r.session == s.popup.session and not(deliveredTo(s, d => d.session == r.session and d.name == r.name))))

  // A fill stopped because the user had switched tabs or the page had
  // navigated.
  val stoppedForChangedPage = s.popup.outcome == "pageChanged"

  // A fill stopped because the browser no longer lets the extension in.
  val stoppedWithoutAccess = s.popup.outcome == "noAccess"

  // The visible-field check of a frame refused the fill.
  val refusedByVisibility = REFUSALS.keys().exists(r => s.popup.outcome == REFUSALS.get(r))

  // A frame on another site was skipped and nothing was filled.
  val refusedOtherSite = s.popup.outcome == "refusedOtherSite"

  // A multi-store stream ended with at least one answered slot.
  val answeredStream = s.streams.keys().exists(q =>
    val st = s.streams.get(q)
    st.done and st.posted.foldl(false, (found, e) => found or e.outcome == "answer"))

  // A stream was abandoned because its popup closed.
  val abandonedStream = s.streams.keys().exists(q => s.streams.get(q).abandoned)
}
