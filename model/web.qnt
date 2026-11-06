// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

// The browser side of the model: origins as the browser reports them,
// the frames of the tab the popup opens on, and the `activeTab` grant.
// Nothing here knows about credentials, so a further module (WebAuthn,
// for example) can reuse the origin and permission rules unchanged.
module web {
  // An opaque origin: `about:blank`, `data:` and sandboxed frames.
  pure val NULL_ORIGIN = "null"

  pure val WEB_ORIGINS = Set(
    "https://example.com",
    "https://login.example.com",
    "https://examp1e.com",
    "https://evil.test",
  )

  pure val ORIGINS = WEB_ORIGINS.union(Set(NULL_ORIGIN))

  // The hostname the popup derives from an origin; "" when it has none
  // (an opaque origin, or no origin at all).
  pure val HOST: str -> str = Map(
    "https://example.com" -> "example.com",
    "https://login.example.com" -> "login.example.com",
    "https://examp1e.com" -> "examp1e.com",
    "https://evil.test" -> "evil.test",
    NULL_ORIGIN -> "",
    "" -> "",
  )

  // The registrable domain the host computes with its public-suffix list.
  pure val SITE: str -> str = Map(
    "example.com" -> "example.com",
    "login.example.com" -> "example.com",
    "examp1e.com" -> "examp1e.com",
    "evil.test" -> "evil.test",
    "" -> "",
  )

  pure def hostOf(origin: str): str = HOST.get(origin)

  pure def siteOf(host: str): str = SITE.get(host)

  // The tab the popup opens on, and a second tab the user can switch to.
  pure val PAGE_TAB = 1
  pure val OTHER_TAB = 2
  pure val OTHER_TAB_ORIGIN = "https://evil.test"

  // Frame slots of the page tab: 0 is the top frame, 1 and 2 are iframes.
  pure val TOP = 0
  pure val FRAME_IDS = List(0, 1, 2)
  pure val SUBFRAMES = Set(1, 2)

  // What the fill script finds in a frame: a field it fills, a field its
  // visibility check refuses, or no field at all.
  pure val FIELDS = Set("fillable", "hidden", "offscreen", "covered", "none")

  // `port` is true while the frame's document holds a live `pasejo-frame`
  // port from the current fill attempt. Any navigation of the frame
  // replaces its document and so closes the port.
  type Frame = { present: bool, origin: str, field: str, port: bool }

  pure val NO_FRAME: Frame = { present: false, origin: NULL_ORIGIN, field: "none", port: false }

  pure def newDocument(origin: str, content: str): Frame =
    { present: true, origin: origin, field: content, port: false }

  type Grant = { granted: bool, tab: int, origin: str }

  pure val NO_GRANT: Grant = { granted: false, tab: 0, origin: NULL_ORIGIN }

  // Whether `grant` lets the extension inject into `tab` while it shows
  // `origin`.
  pure def covers(grant: Grant, tab: int, origin: str): bool =
    grant.granted and grant.tab == tab and grant.origin == origin

  // The grant after the tab navigates to `origin`. A navigation to another
  // origin revokes it; whether a same-origin navigation keeps it differs
  // between browsers, so the caller decides with `keepOnSameOrigin`.
  pure def afterNavigation(grant: Grant, tab: int, origin: str, keepOnSameOrigin: bool): Grant =
    if (grant.granted and grant.tab == tab and grant.origin == origin and keepOnSameOrigin) grant
    else if (grant.tab == tab) NO_GRANT
    else grant
}
