import MarkdownIt from "markdown-it";
const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
/** A readable excerpt, never markup or an independent rendering boundary. */
export function markdownExcerpt(contents: string, preferredSections: readonly string[] = []): string {
  const tokens = parser.parse(contents, {});
  const headings = new Set(preferredSections.map((title) => title.toLowerCase()));
  const heading = !headings.size
    ? -1
    : tokens.findIndex(
        (token, index) =>
          token.type === "heading_open" &&
          token.level === 0 &&
          headings.has(tokens[index + 1]?.content.toLowerCase() ?? ""),
      );
  const level = Number(tokens[heading]?.tag.slice(1));
  const end =
    heading < 0
      ? -1
      : tokens.findIndex(
          (token, index) =>
            index > heading &&
            token.type === "heading_open" &&
            token.level === 0 &&
            Number(token.tag.slice(1)) <= level,
        );
  const preferred =
    heading < 0
      ? -1
      : tokens.findIndex(
          (token, index) => index > heading && (end < 0 || index < end) && token.type === "paragraph_open",
        );
  const index = preferred < 0 ? tokens.findIndex((token) => token.type === "paragraph_open") : preferred;
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
