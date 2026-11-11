import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { containsHtml, markdownText, parseMarkdown, safeHref, stripHtml } from "../lib/markdown";
import { Markdown } from "../components/markdown";

const html = (source: string) => renderToStaticMarkup(createElement(Markdown, { source }));

test("raw HTML never reaches the page", () => {
  const out = html('Hallo <script>alert(1)</script><img src=x onerror="alert(2)"><b onclick=x>fett</b> <iframe src="https://evil"></iframe>');
  assert.doesNotMatch(out, /<script|<img|onerror|onclick|<iframe|<b>/i);
  assert.match(out, /Hallo/);
  assert.match(out, /fett/);
  assert.doesNotMatch(out, /alert\(1\)/);
  // Text that only looks like a tag is escaped, not interpreted.
  assert.match(html("1 < 2 and 3 > 2"), /1 &lt; 2 and 3 &gt; 2/);
  assert.equal(stripHtml("a<!-- x -->b<style>p{}</style>c"), "abc");
  assert.equal(containsHtml("a <div>b</div>"), true);
  assert.equal(containsHtml("a < b"), false);
});

test("links only to http(s) and mailto, opened safely", () => {
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,x"), null);
  assert.equal(safeHref("JAVASCRIPT:alert(1)"), null);
  assert.equal(safeHref("https://flowplan.org/x"), "https://flowplan.org/x");
  assert.equal(safeHref("mailto:a@b.org"), "mailto:a@b.org");
  const out = html("[klick](javascript:alert(1)) [ok](https://flowplan.org) https://docs.flowplan.org");
  assert.doesNotMatch(out, /href="(?!https?:)/);
  assert.doesNotMatch(html("[x](javascript:void0)"), /href/);
  assert.match(out, /<a href="https:\/\/flowplan.org\/" rel="noopener noreferrer nofollow ugc" target="_blank">ok<\/a>/);
  assert.match(out, /href="https:\/\/docs.flowplan.org\/"/);
  assert.match(out, /klick/);
});

test("the Markdown subset", () => {
  const blocks = parseMarkdown("# Titel\n\nText mit **fett** und *kursiv* und `code`.\n\n- eins\n- zwei\n\n1. a\n2. b\n\n> Zitat\n\n```\n<b>x</b>\n```\n\n---");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading", "paragraph", "list", "list", "quote", "code", "rule"],
  );
  const out = html("## Was drin ist\n\n- **Agenda**\n- *Entscheidungen*");
  assert.match(out, /<h3>Was drin ist<\/h3>/);
  assert.match(out, /<li><strong>Agenda<\/strong><\/li>/);
  assert.equal(markdownText("**a** [b](https://x.org)"), "a b");
});
