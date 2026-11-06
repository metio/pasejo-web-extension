// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

// The native host as the extension sees it: two stores of secrets, the
// per-secret fill policy, the matcher, and the replies to `query` and
// `reveal`. The rules mirror src/browser/matcher.rs and policy.rs in
// pasejo; the model abstracts URLs to origins and secret names to the
// registrable domain their path segment names.
module host {
  import web.* from "./web"

  // `url` is the origin of the secret's URL field, "" when it has none.
  // `nameSite` is the registrable domain a segment of the secret's name
  // names, "" when none does.
  type Secret = {
    store: str,
    url: str,
    nameSite: str,
    username: str,
    confirm: bool,
    otp: bool,
  }

  pure val STORES = List("personal", "work")

  pure val CATALOG: str -> Secret = Map(
    "alice" -> { store: "personal", url: "https://example.com", nameSite: "", username: "alice", confirm: false, otp: true },
    "bob" -> { store: "personal", url: "https://login.example.com", nameSite: "", username: "bob", confirm: false, otp: false },
    "carol" -> { store: "personal", url: "https://example.com", nameSite: "", username: "carol", confirm: false, otp: false },
    "dave" -> { store: "personal", url: "https://example.com", nameSite: "", username: "dave", confirm: true, otp: false },
    "example.com/erin" -> { store: "work", url: "", nameSite: "example.com", username: "erin", confirm: false, otp: false },
    "frank" -> { store: "work", url: "https://evil.test", nameSite: "", username: "frank", confirm: false, otp: false },
  )

  pure val NAMES = CATALOG.keys()

  pure val POLICIES = Set("any", "exact-host", "never")

  pure val INITIAL_POLICY: str -> str = Map(
    "alice" -> "any",
    "bob" -> "exact-host",
    "carol" -> "never",
    "dave" -> "any",
    "example.com/erin" -> "any",
    "frank" -> "any",
  )

  // How a secret's URL field relates to `host`: "exact", "site" (same
  // registrable domain) or "none".
  pure def urlKind(secret: Secret, host: str): str =
    if (secret.url == "" or host == "") "none"
    else if (hostOf(secret.url) == host) "exact"
    else if (siteOf(hostOf(secret.url)) == siteOf(host)) "site"
    else "none"

  // The host's match of `secret` for `host` under `policy`: "exact",
  // "site", "name" or "none". The name rule applies only when no URL
  // field matches; `never` matches nothing and `exact-host` keeps only an
  // exact URL match.
  pure def matchKind(secret: Secret, policy: str, host: str): str =
    if (policy == "never" or host == "") "none"
    else if (policy == "exact-host") { if (urlKind(secret, host) == "exact") "exact" else "none" }
    else if (urlKind(secret, host) != "none") urlKind(secret, host)
    else if (secret.nameSite != "" and secret.nameSite == siteOf(host)) "name"
    else "none"

  // Whether `secret` names `host` under the URL or name rule, whatever its
  // policy says.
  pure def namesHost(secret: Secret, host: str): bool =
    matchKind(secret, "any", host) != "none"

  // The secrets of `store` a `query` for `host` lists.
  pure def queryNames(catalog: str -> Secret, policy: str -> str, store: str, host: str): Set[str] =
    catalog.keys().filter(n => catalog.get(n).store == store and matchKind(catalog.get(n), policy.get(n), host) != "none")

  // Whether a `reveal` of `name` in `store` for `host` releases the
  // credential: the host re-runs the matcher at click time.
  pure def revealMatches(catalog: str -> Secret, policy: str -> str, store: str, name: str, host: str): bool =
    catalog.keys().contains(name) and catalog.get(name).store == store and matchKind(catalog.get(name), policy.get(name), host) != "none"

  // Whether the released credential carries the TOTP code: only for an
  // exact-host match.
  pure def revealOtp(catalog: str -> Secret, policy: str -> str, name: str, host: str): bool =
    catalog.get(name).otp and matchKind(catalog.get(name), policy.get(name), host) == "exact"
}
