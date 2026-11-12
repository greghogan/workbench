import MarkdownIt from "markdown-it";
const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
/** A readable excerpt, never markup or an independent rendering boundary. */
export function markdownExcerpt(contents: string): string {
  const tokens = parser.parse(contents, {});
  const index = tokens.findIndex((token) => token.type === "paragraph_open");
  const inline = index < 0 ? undefined : tokens[index + 1];
  return (inline?.children ?? [])
    .map((token) => {
      if (token.type === "softbreak" || token.type === "hardbreak") return " ";
      return ["text", "code_inline", "image"].includes(token.type) ? token.content : "";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
