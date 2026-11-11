import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTempData, req } from "./helpers";
import { DEFAULT_IMPRESSUM_URL, DEFAULT_PRIVACY_URL, config } from "../lib/config";
import { legalHref, legalRedirect, legalUrl, termsText } from "../lib/legal";

const dir = useTempData();
const VARS = ["MARKETPLACE_IMPRESSUM_URL", "MARKETPLACE_PRIVACY_URL", "MARKETPLACE_TERMS_URL", "MARKETPLACE_LEGAL_DIR"];
beforeEach(() => {
  for (const name of VARS) delete process.env[name];
});

test("Impressum and privacy policy default to the Flowplan website, terms to the own page", () => {
  assert.equal(DEFAULT_IMPRESSUM_URL, "https://flowplan.org/impressum");
  assert.equal(DEFAULT_PRIVACY_URL, "https://flowplan.org/datenschutz");
  assert.equal(config.impressumUrl(), DEFAULT_IMPRESSUM_URL);
  assert.equal(config.privacyUrl(), DEFAULT_PRIVACY_URL);
  assert.equal(config.termsUrl(), null);
});

test("legal addresses must be https URLs", () => {
  process.env.MARKETPLACE_IMPRESSUM_URL = " https://example.org/legal ";
  assert.equal(config.impressumUrl(), "https://example.org/legal");
  for (const bad of ["http://example.org/impressum", "example.org/impressum", "javascript:alert(1)", "https://user:pw@example.org/", "/impressum"]) {
    process.env.MARKETPLACE_IMPRESSUM_URL = bad;
    process.env.MARKETPLACE_PRIVACY_URL = bad;
    process.env.MARKETPLACE_TERMS_URL = bad;
    assert.throws(() => config.impressumUrl(), /MARKETPLACE_IMPRESSUM_URL/, bad);
    assert.throws(() => config.privacyUrl(), /MARKETPLACE_PRIVACY_URL/, bad);
    assert.throws(() => config.termsUrl(), /MARKETPLACE_TERMS_URL/, bad);
  }
});

test("footer links: the website's page in the visitor's language, the local terms page", () => {
  assert.equal(legalHref("impressum", "de"), "https://flowplan.org/de/impressum");
  assert.equal(legalHref("impressum", "en"), "https://flowplan.org/en/impressum");
  assert.equal(legalHref("datenschutz", "de"), "https://flowplan.org/de/datenschutz");
  assert.equal(legalHref("datenschutz", "en"), "https://flowplan.org/en/datenschutz");
  assert.equal(legalHref("nutzungsbedingungen", "en"), "/nutzungsbedingungen");
  assert.equal(legalUrl("nutzungsbedingungen", "de"), null);
});

test("custom addresses are used as given", () => {
  process.env.MARKETPLACE_IMPRESSUM_URL = "https://example.org/impressum";
  process.env.MARKETPLACE_PRIVACY_URL = "https://flowplan.org/privacy";
  process.env.MARKETPLACE_TERMS_URL = "https://example.org/terms?x=1";
  for (const locale of ["de", "en"] as const) {
    assert.equal(legalHref("impressum", locale), "https://example.org/impressum");
    assert.equal(legalHref("datenschutz", locale), "https://flowplan.org/privacy");
    assert.equal(legalHref("nutzungsbedingungen", locale), "https://example.org/terms?x=1");
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

test("terms: the operator's file, else the placeholder", () => {
  const placeholder = termsText("de");
  assert.equal(placeholder.placeholder, true);
  assert.match(placeholder.text, /^# Nutzungsbedingungen/);
  const legal = join(dir, "legal");
  mkdirSync(legal, { recursive: true });
  writeFileSync(join(legal, "nutzungsbedingungen.de.md"), "# Unsere Bedingungen\n");
  assert.deepEqual(termsText("de"), { text: "# Unsere Bedingungen\n", placeholder: false });
  // English falls back to the German file before the placeholder.
  assert.deepEqual(termsText("en"), { text: "# Unsere Bedingungen\n", placeholder: false });
});
