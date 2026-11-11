// A small, safe Markdown reader for template descriptions and legal texts.
// It never passes HTML through: tags are removed (script and style blocks with
// their content), everything else becomes plain text that React escapes.
// Links keep only http(s) and mailto addresses. Pure: no React, no DOM.
export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };
export type Block =
  | { type: "heading"; level: 1 | 2 | 3; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "quote"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "rule" };

// Removes HTML: whole <script>/<style>/<iframe> elements, comments, then any tag.
export function stripHtml(input: string) {
  return input
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/<(script|style|iframe|object|embed|template|noscript)\b[\s\S]*?(<\/\1\s*>|$)/gi, "")
    .replace(/<\/?[a-zA-Z][^<>]*(>|$)/g, "");
}
export const containsHtml = (input: string) => /<\/?[a-zA-Z][^<>]*>|<!--/.test(input);

export function safeHref(href: string): string | null {
  const value = href.trim();
  if (/^https?:\/\/[^\s]+$/i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  }
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(value)) return value;
  return null;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ type: "text", text: buffer });
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    // Escaped punctuation stays literal.
    if (rest[0] === "\\" && /^[\\`*_[\]()#+\-.!>]/.test(rest.slice(1))) {
      buffer += rest[1];
      i += 2;
      continue;
    }
    let m = /^`([^`\n]+)`/.exec(rest);
    if (m) {
      flush();
      out.push({ type: "code", text: m[1] });
      i += m[0].length;
      continue;
    }
    m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (m) {
      flush();
      out.push({ type: "strong", children: parseInline(m[2]) });
      i += m[0].length;
      continue;
    }
    m = /^(\*|_)(?=\S)([^*_\n]*?\S)\1(?![*_])/.exec(rest);
    if (m) {
      flush();
      out.push({ type: "em", children: parseInline(m[2]) });
      i += m[0].length;
      continue;
    }
    m = /^\[([^\]\n]{1,500})\]\(([^()\s]{1,2000})\)/.exec(rest);
    if (m) {
      flush();
      const href = safeHref(m[2]);
      if (href) out.push({ type: "link", href, children: parseInline(m[1]) });
      else out.push(...parseInline(m[1]));
      i += m[0].length;
      continue;
    }
    m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest);
    if (m && (i === 0 || /\s|\(/.test(text[i - 1]))) {
      const href = safeHref(m[0]);
      if (href) {
        flush();
        out.push({ type: "link", href, children: [{ type: "text", text: m[0] }] });
        i += m[0].length;
        continue;
      }
    }
    buffer += rest[0];
    i += 1;
  }
  flush();
  return out;
}

export function parseMarkdown(source: string, maxLength = 20_000): Block[] {
  const text = stripHtml(source.slice(0, maxLength)).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" ").trim()) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      endParagraph();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      endParagraph();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      endParagraph();
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, children: parseInline(heading[2]) });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      endParagraph();
      blocks.push({ type: "rule" });
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      endParagraph();
      const quote: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      i--;
      blocks.push({ type: "quote", children: parseInline(quote.join(" ").trim()) });
      continue;
    }
    const bullet = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+/;
    if (bullet.test(line)) {
      endParagraph();
      const ordered = /^\s{0,3}\d/.test(line);
      const items: Inline[][] = [];
      while (i < lines.length && bullet.test(lines[i]) && /^\s{0,3}\d/.test(lines[i]) === ordered) {
        let item = lines[i].replace(bullet, "");
        // Continuation lines (indented) belong to the item.
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !bullet.test(lines[i + 1])) item += " " + lines[++i].trim();
        items.push(parseInline(item.trim()));
        i++;
      }
      i--;
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    paragraph.push(line.trim());
  }
  endParagraph();
  return blocks;
}

// Plain text of some Markdown (for meta descriptions and search).
export function markdownText(source: string) {
  const walk = (nodes: Inline[]): string => nodes.map((n) => (n.type === "text" || n.type === "code" ? n.text : walk(n.children))).join("");
  return parseMarkdown(source)
    .map((b) => (b.type === "list" ? b.items.map(walk).join(" ") : b.type === "code" ? b.text : b.type === "rule" ? "" : walk(b.children)))
    .join(" ")
    .trim();
}
