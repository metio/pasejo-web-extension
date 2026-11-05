// SPDX-FileCopyrightText: The pasejo Authors
// SPDX-License-Identifier: 0BSD

import { describe, expect, it } from "vitest";

import en from "../src/_locales/en/messages.json";
import de from "../src/_locales/de/messages.json";
import es from "../src/_locales/es/messages.json";
import fr from "../src/_locales/fr/messages.json";
import itLocale from "../src/_locales/it/messages.json";
import ja from "../src/_locales/ja/messages.json";
import ko from "../src/_locales/ko/messages.json";
import zh from "../src/_locales/zh/messages.json";

// English is the `default_locale`; every other catalog must cover the same
// keys so the browser never falls back to English for a translated build.
// These match the CLI's eight-language set (en + de/es/fr/it/ja/ko/zh).
const TRANSLATIONS = { de, es, fr, it: itLocale, ja, ko, zh };

const enKeys = Object.keys(en).sort();

// The named `$PLACEHOLDER$` tokens a message's text must keep so the
// runtime substitution still lands.
function tokensOf(message) {
  return (message.match(/\$[A-Za-z0-9_]+\$/g) ?? []).sort();
}

describe("_locales catalogs", () => {
  it("English defines at least one message", () => {
    expect(enKeys.length).toBeGreaterThan(0);
  });

  for (const [lang, catalog] of Object.entries(TRANSLATIONS)) {
    describe(lang, () => {
      it("defines exactly the English key set", () => {
        expect(Object.keys(catalog).sort()).toEqual(enKeys);
      });

      it("carries a non-empty message for every key", () => {
        for (const key of enKeys) {
          expect(catalog[key]?.message, key).toBeTypeOf("string");
          expect(catalog[key].message.length, key).toBeGreaterThan(0);
        }
      });

      it("preserves each entry's `placeholders` table verbatim", () => {
        for (const key of enKeys) {
          expect(catalog[key].placeholders ?? null, key).toEqual(
            en[key].placeholders ?? null,
          );
        }
      });

      it("keeps every English placeholder token in the translated text", () => {
        for (const key of enKeys) {
          expect(tokensOf(catalog[key].message), key).toEqual(
            tokensOf(en[key].message),
          );
        }
      });

      it("leaves the brand name untranslated", () => {
        expect(catalog.extensionName.message).toBe("pasejo");
      });
    });
  }
});
