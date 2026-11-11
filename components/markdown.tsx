// Renders lib/markdown.ts blocks as React elements: text is always text
// (React escapes it), links are http(s)/mailto only and open as plain
// external links. No HTML from the source ever reaches the page.
import { parseMarkdown, type Inline } from "@/lib/markdown";

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        if (node.type === "text") return node.text;
        if (node.type === "code") return <code key={i}>{node.text}</code>;
        if (node.type === "strong")
          return (
            <strong key={i}>
              <Inlines nodes={node.children} />
            </strong>
          );
        if (node.type === "em")
          return (
            <em key={i}>
              <Inlines nodes={node.children} />
            </em>
          );
        return (
          <a key={i} href={node.href} rel="noopener noreferrer nofollow ugc" target="_blank">
            <Inlines nodes={node.children} />
          </a>
        );
      })}
    </>
  );
}

export function Markdown({ source, headingOffset = 1 }: { source: string; headingOffset?: number }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="prose">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading": {
            const Tag = `h${Math.min(6, block.level + headingOffset)}` as "h2";
            return (
              <Tag key={i}>
                <Inlines nodes={block.children} />
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={i}>
                <Inlines nodes={block.children} />
              </p>
            );
          case "quote":
            return (
              <blockquote key={i}>
                <Inlines nodes={block.children} />
              </blockquote>
            );
          case "code":
            return (
              <pre key={i}>
                <code>{block.text}</code>
              </pre>
            );
          case "rule":
            return <hr key={i} />;
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inlines nodes={item} />
                  </li>
                ))}
              </List>
            );
          }
        }
      })}
    </div>
  );
}
