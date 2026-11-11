import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useTempData, req } from "./helpers";
import { DEFAULT_IMPRESSUM_URL, DEFAULT_PRIVACY_URL, config } from "../lib/config";
import { legalRedirect, legalUrl, termsText } from "../lib/legal";

useTempData();
const VARS = ["MARKETPLACE_IMPRESSUM_URL", "MARKETPLACE_PRIVACY_URL"];
beforeEach(() => {
  for (const name of VARS) delete process.env[name];
});

test("Impressum and privacy policy default to the Flowplan website", () => {
  assert.equal(DEFAULT_IMPRESSUM_URL, "https://flowplan.org/impressum");
  assert.equal(DEFAULT_PRIVACY_URL, "https://flowplan.org/datenschutz");
  assert.equal(config.impressumUrl(), DEFAULT_IMPRESSUM_URL);
  assert.equal(config.privacyUrl(), DEFAULT_PRIVACY_URL);
});

test("legal addresses must be https URLs", () => {
  process.env.MARKETPLACE_IMPRESSUM_URL = " https://example.org/legal ";
  assert.equal(config.impressumUrl(), "https://example.org/legal");
  for (const bad of ["http://example.org/impressum", "example.org/impressum", "javascript:alert(1)", "https://user:pw@example.org/", "/impressum"]) {
    process.env.MARKETPLACE_IMPRESSUM_URL = bad;
    process.env.MARKETPLACE_PRIVACY_URL = bad;
    assert.throws(() => config.impressumUrl(), /MARKETPLACE_IMPRESSUM_URL/, bad);
    assert.throws(() => config.privacyUrl(), /MARKETPLACE_PRIVACY_URL/, bad);
  }
});

test("footer links: the website's page in the visitor's language", () => {
  assert.equal(legalUrl("impressum", "de"), "https://flowplan.org/de/impressum");
  assert.equal(legalUrl("impressum", "en"), "https://flowplan.org/en/impressum");
  assert.equal(legalUrl("datenschutz", "de"), "https://flowplan.org/de/datenschutz");
  assert.equal(legalUrl("datenschutz", "en"), "https://flowplan.org/en/datenschutz");
});

test("custom addresses are used as given", () => {
  process.env.MARKETPLACE_IMPRESSUM_URL = "https://example.org/impressum";
  process.env.MARKETPLACE_PRIVACY_URL = "https://flowplan.org/privacy";
  for (const locale of ["de", "en"] as const) {
    assert.equal(legalUrl("impressum", locale), "https://example.org/impressum");
    assert.equal(legalUrl("datenschutz", locale), "https://flowplan.org/privacy");
  }
});

test("/impressum and /datenschutz redirect permanently in the visitor's language", () => {
  const cases: [Record<string, string>, string][] = [
    [{ "accept-language": "de-DE,de;q=0.9" }, "de"],
    [{ "accept-language": "en-GB,en;q=0.9" }, "en"],
    [{}, "en"],
    // The footer's language choice wins over the browser's.
    [{ "accept-language": "en", cookie: "mp_lang=de" }, "de"],
  ];
  for (const [headers, locale] of cases)
    for (const page of ["impressum", "datenschutz"] as const) {
      const r = legalRedirect(page, req(`/${page}`, { headers }));
      assert.equal(r.status, 308);
      assert.equal(r.headers.get("location"), `https://flowplan.org/${locale}/${page}`);
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
  process.env.MARKETPLACE_PRIVACY_URL = "https://example.org/privacy";
  assert.equal(legalRedirect("datenschutz", req("/datenschutz", { headers: { "accept-language": "de" } })).headers.get("location"), "https://example.org/privacy");
});

test("the Nutzungsbedingungen are the shipped text in both languages", () => {
  const de = termsText("de");
  const en = termsText("en");
  assert.match(de, /^# Nutzungsbedingungen\n/);
  assert.match(en, /^# Terms of use\n/);
  for (const text of [de, en]) {
    assert.doesNotMatch(text, /Platzhalter|Placeholder/i);
    // Their links point to the website's legal pages.
    assert.match(text, /\]\(https:\/\/flowplan\.org\/impressum\)/);
    assert.match(text, /\]\(https:\/\/flowplan\.org\/datenschutz\)/);
  }
});
