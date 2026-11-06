// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

// Scenarios of the extension model, run by `npm run model:test`. Each
// one drives the machine through fixed events and checks where it ends
// up and that every invariant held on the way.
module extension_test {
  import web.* from "./web"
  import host.* from "./host"
  import extension.* from "./extension"

  action start(origin: str, content: str): bool = s' = initialState(origin, content)

  // Every step checks the invariants of the state it leaves.
  action goTo(st: State): bool = all {
    assert(allInvariantsIn(st)),
    s' = st,
  }

  action open = goTo(openPopup(s))
  action answer(port: int, outcome: str): bool = goTo(hostAnswer(s, port, outcome))
  action click(name: str, reach: Set[int]): bool = goTo(clickRow(s, name, reach))
  action arm = goTo(armConfirm(s))
  action confirm(reach: Set[int]): bool = goTo(clickConfirm(s, reach))
  action choose(choice: str): bool = goTo(selectStore(s, choice))
  action reply(port: int, rid: int, outcome: str): bool = goTo(streamReply(s, port, rid, outcome))
  action expire(port: int): bool = goTo(streamFail(s, port))
  action close = goTo(closePopup(s))
  action navigate(origin: str, content: str, keep: bool): bool = goTo(navigateTab(s, origin, content, keep))
  action frame(f: int, origin: str, content: str): bool = goTo(setFrame(s, f, true, origin, content))
  action focus(f: int): bool = goTo(setFocus(s, f))
  action switch = goTo(switchTab(s))
  action edit(name: str, policy: str): bool = goTo(editPolicy(s, name, policy))

  pure val ROSTER_PORT = 0
  pure val LIST_PORT = 1

  pure def deliveredFrames(st: State): List[int] =
    st.delivered.foldl(List(), (l, d) => l.append(d.frame))

  // The list carries no credential; the click asks the host to release
  // one, and the fill follows the release.
  run releasesOnlyOnClickTest =
    start("https://example.com", "fillable")
      .then(open)
      .then(answer(LIST_PORT, "answer"))
      .expect(s.popup.rows == Set("alice", "dave") and s.releases.length() == 0)
      .then(click("alice", Set(0)))
      .expect(s.native.get(2).kind == "reveal" and s.native.get(2).domain == "example.com" and s.releases.length() == 0)
      .then(answer(2, "answer"))
      .expect(and {
        s.releases.length() == 1,
        s.releases[0].otp,
        deliveredFrames(s) == List(0),
        // The code went to the row because the page has no code field, so
        // the popup stays open and usable.
        not(s.popup.filling),
        s.popup.outcome == "filled",
        s.popup.otpShown,
      })

  // A secret with `pasejo-confirm` opens a prompt; a click before the arm
  // delay does nothing, and only the armed confirm releases it.
  run confirmSecretAsksFirstTest =
    start("https://example.com", "fillable")
      .then(open)
      .then(answer(LIST_PORT, "answer"))
      .then(click("dave", Set(0)))
      .expect(s.popup.confirming == "dave" and s.nextPort == 2)
      .then(confirm(Set(0)))
      .expect(s.popup.confirming == "dave" and s.nextPort == 2)
      .then(arm)
      .then(confirm(Set(0)))
      .expect(s.popup.confirming == "" and s.native.get(2).name == "dave")
      .then(answer(2, "answer"))
      .expect(deliveredFrames(s) == List(0) and s.popup.filling)

  // The tab navigates while the reveal waits for a security key: the host
  // still releases the credential, but the frame it was meant for is gone.
  run navigationDuringRevealFillsNothingTest =
    start("https://example.com", "fillable")
      .then(open)
      .then(answer(LIST_PORT, "answer"))
      .then(click("alice", Set(0)))
      .then(navigate("https://evil.test", "fillable", true))
      .then(answer(2, "answer"))
      .expect(and {
        s.releases.length() == 1,
        s.delivered.length() == 0,
        not(s.popup.filling),
        s.popup.outcome == "refusedNoField",
        s.popup.otpShown,
      })

  // A focused iframe on another site is asked about first and refused;
  // the visible-field check refuses the covered field of the top frame.
  run foreignFrameIsNotFilledTest =
    start("https://example.com", "covered")
      .then(frame(1, "https://evil.test", "fillable"))
      .then(focus(1))
      .then(open)
      .then(answer(LIST_PORT, "answer"))
      .then(click("alice", Set(0, 1)))
      .expect(s.native.get(2).purpose == "check" and s.native.get(2).domain == "evil.test")
      .then(answer(2, "answer"))
      .expect(s.native.get(3).kind == "reveal")
      .then(answer(3, "answer"))
      .expect(deliveredFrames(s) == List(0) and not(s.popup.filling) and s.popup.outcome == "refusedCovered")

  // An iframe on the secret's stored host gets the fill without a check.
  run storedHostFrameIsFilledTest =
    start("https://example.com", "none")
      .then(frame(2, "https://login.example.com", "fillable"))
      .then(open)
      .then(answer(LIST_PORT, "answer"))
      .then(edit("bob", "any"))
      .then(choose("work"))
      .then(choose("personal"))
      .then(answer(3, "answer"))
      .expect(s.popup.rows.contains("bob"))
      .then(click("bob", Set(0, 2)))
      .then(answer(4, "answer"))
      .expect(deliveredFrames(s) == List(0, 2))

  // An `exact-host` secret does not go to a frame on a sibling host.
  run exactHostSecretStaysOnItsHostTest =
    start("https://login.example.com", "none")
      .then(frame(1, "https://example.com", "fillable"))
      .then(focus(1))
      .then(open)
      .then(answer(LIST_PORT, "answer"))
      .expect(s.popup.rows == Set("alice", "bob", "dave"))
      .then(click("bob", Set(0, 1)))
      .expect(s.native.get(2).purpose == "check" and s.native.get(2).domain == "example.com")
      .then(answer(2, "answer"))
      .expect(s.native.get(2).names == Set("alice", "dave") and s.native.get(3).kind == "reveal")
      .then(answer(3, "answer"))
      .expect(deliveredFrames(s) == List(0))

  // A store edit after the list: the host re-checks at click time and
  // refuses, so nothing is released.
  run neverPolicyIsRefusedAtClickTimeTest =
    start("https://example.com", "fillable")
      .then(open)
      .then(answer(LIST_PORT, "answer"))
      .expect(not(s.popup.rows.contains("carol")))
      .then(edit("alice", "never"))
      .then(click("alice", Set(0)))
      .then(answer(2, "answer"))
      .expect(and {
        not(s.native.get(2).matched),
        s.releases.length() == 0,
        s.delivered.length() == 0,
        s.popup.outcome == "revealRefused",
      })

  // A switch to another tab or a revoked grant stops the fill before
  // anything is injected or released.
  run changedTabRefusesFillTest =
    start("https://example.com", "fillable")
      .then(open)
      .then(answer(LIST_PORT, "answer"))
      .then(switch)
      .then(click("alice", Set(0)))
      .expect(s.nextPort == 2 and not(s.popup.filling) and s.popup.outcome == "pageChanged")
      .then(switch)
      .then(navigate("https://example.com", "fillable", false))
      .then(click("alice", Set(0)))
      .expect(s.nextPort == 2 and not(s.grant.granted) and s.intents.size() == 1 and s.popup.outcome == "noAccess")

  // Replies come back out of order and a duplicate is dropped; each slot
  // is posted once, under its own store, then `done`.
  run streamCorrelatesRepliesTest =
    start("https://example.com", "fillable")
      .then(open)
      .then(choose("all"))
      .then(reply(2, 2, "answer"))
      .then(goTo(s))
      .then(reply(2, 1, "answer"))
      .expect(and {
        s.streams.get(2).done,
        s.streams.get(2).posted.length() == 3,
        s.streams.get(2).posted[0].store == "work",
        s.streams.get(2).posted[1].store == "personal",
        s.popup.rows == Set("alice", "dave", "example.com/erin"),
        not(s.native.get(2).open),
      })

  run streamTimeoutEndsTheStreamTest =
    start("https://example.com", "fillable")
      .then(open)
      .then(choose("all"))
      .then(reply(2, 1, "error"))
      .then(expire(2))
      .expect(s.streams.get(2).done and s.streams.get(2).posted[1].outcome == "transport")

  run closingThePopupAbandonsTheStreamTest =
    start("https://example.com", "fillable")
      .then(open)
      .then(choose("all"))
      .then(close)
      .expect(s.streams.get(2).abandoned and not(s.native.get(2).open) and s.popup.rows == Set())

  // A reply to a list query that a newer query replaced is ignored.
  run staleListIsIgnoredTest =
    start("https://example.com", "fillable")
      .then(open)
      .then(choose("work"))
      .then(answer(2, "answer"))
      .then(answer(LIST_PORT, "answer"))
      .expect(s.popup.rows == Set("example.com/erin"))
}
