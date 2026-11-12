import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_INSTANCE, config } from "../lib/config";
import { boxMode, hostOf, parseFromFragment } from "../lib/instance";
import { OpenInFlowplan } from "../components/open-in-flowplan";
import { LocaleProvider } from "../components/i18n";

const VAR = "MARKETPLACE_DEFAULT_INSTANCE";
const restore = process.env[VAR];
const reset = () => (restore === undefined ? delete process.env[VAR] : (process.env[VAR] = restore));

test("MARKETPLACE_DEFAULT_INSTANCE: default app.flowplan.org, empty/off = none, https origins only", () => {
  try {
    delete process.env[VAR];
    assert.equal(DEFAULT_INSTANCE, "https://app.flowplan.org");
    assert.equal(config.defaultInstance(), "https://app.flowplan.org");
    for (const off of ["", "  ", "off", "OFF"]) {
      process.env[VAR] = off;
      assert.equal(config.defaultInstance(), null, JSON.stringify(off));
    }
    process.env[VAR] = " https://flowplan.example.org/ ";
    assert.equal(config.defaultInstance(), "https://flowplan.example.org");
    for (const bad of ["http://flowplan.example.org", "flowplan.example.org", "javascript:alert(1)", "https://user:pw@flowplan.example.org", "https://flowplan.example.org/app", "https://flowplan.example.org/?x=1"]) {
      process.env[VAR] = bad;
      assert.throws(() => config.defaultInstance(), /MARKETPLACE_DEFAULT_INSTANCE/, bad);
    }
  } finally {
    reset();
  }
});

test("#from= fragment: valid origins are taken, the rest of the fragment stays", () => {
  assert.deepEqual(parseFromFragment(`#from=${encodeURIComponent("https://flowplan.example.org")}`), { origin: "https://flowplan.example.org", rest: "" });
  assert.deepEqual(parseFromFragment(`from=${encodeURIComponent("https://flowplan.example.org/")}`), { origin: "https://flowplan.example.org", rest: "" });
  assert.deepEqual(parseFromFragment(`#from=${encodeURIComponent("https://Flowplan.Example.org:8443")}`), { origin: "https://flowplan.example.org:8443", rest: "" });
  // http only for localhost and private networks, like the address field.
  assert.equal(parseFromFragment(`#from=${encodeURIComponent("http://localhost:3000")}`)!.origin, "http://localhost:3000");
  assert.equal(parseFromFragment(`#from=${encodeURIComponent("http://192.168.1.20:3000")}`)!.origin, "http://192.168.1.20:3000");
  // Other fragment parts survive; no from → nothing to do.
  assert.deepEqual(parseFromFragment(`#browse&from=${encodeURIComponent("https://a.example.org")}`), { origin: "https://a.example.org", rest: "#browse" });
  assert.equal(parseFromFragment("#browse"), null);
  assert.equal(parseFromFragment(""), null);
  assert.equal(parseFromFragment("#"), null);
});

test("#from= fragment: public http, other schemes and garbage are refused (but still removed)", () => {
  for (const bad of [
    "http://flowplan.example.org",
    "javascript:alert(1)",
    "javascript://flowplan.example.org/%0aalert(1)",
    "data:text/html,x",
    "flowplan.example.org",
    "https://flowplan.example.org/app",
    "https://flowplan.example.org/?x=1",
    "https://user:pw@flowplan.example.org",
    "https://",
    "",
    "not a url",
    `https://${"a".repeat(400)}.org`,
  ]) {
    const parsed = parseFromFragment(`#from=${encodeURIComponent(bad)}`);
    assert.deepEqual(parsed, { origin: null, rest: "" }, bad);
  }
  // Broken percent-encoding.
  assert.deepEqual(parseFromFragment("#from=%E0%A4%A"), { origin: null, rest: "" });
  assert.deepEqual(parseFromFragment("#x=1&from=%zz"), { origin: null, rest: "#x=1" });
});

test("the box: saved instance, preselected default, or the address field", () => {
  const def = "https://app.flowplan.org";
  assert.equal(boxMode(null, def, false), "default");
  assert.equal(boxMode(null, null, false), "field");
  assert.equal(boxMode("https://flowplan.example.org", def, false), "saved");
  assert.equal(boxMode("https://flowplan.example.org", null, false), "saved");
  assert.equal(boxMode("https://flowplan.example.org", def, true), "field");
  assert.equal(boxMode(null, def, true), "field");
  // A broken stored value counts as nothing saved.
  assert.equal(boxMode("http://flowplan.example.org", def, false), "default");
  assert.equal(hostOf("https://app.flowplan.org"), "app.flowplan.org");
});

const template = { id: "t1", slug: "demo", version: 1, minVersion: "0.9.4", sha256: "a".repeat(64), title: "Demo", kind: "template", author: "A", license: "CC0-1.0" };
const render = (locale: "de" | "en", defaultInstance: string | null) =>
  renderToStaticMarkup(createElement(LocaleProvider, { locale, children: createElement(OpenInFlowplan, { template, defaultInstance }) }));

test("the box renders the preselected instance without an address field", () => {
  const html = render("de", "https://app.flowplan.org");
  assert.match(html, /In app\.flowplan\.org öffnen/);
  assert.match(html, /Eigene Instanz verwenden …/);
  assert.doesNotMatch(html, /<input/);
  assert.match(render("en", "https://app.flowplan.org"), /Open in app\.flowplan\.org/);
});

test("the box without a default instance asks for the address as before", () => {
  const html = render("de", null);
  assert.match(html, /<input[^>]*id="instance"/);
  assert.match(html, /Gib einmal die Adresse deiner Flowplan-Instanz an/);
  assert.doesNotMatch(html, /Eigene Instanz verwenden/);
});
