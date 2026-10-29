import type { ComponentChildren, JSX } from "preact";
import { renderToString } from "preact-render-to-string";
import MarkdownIt from "markdown-it";
import { dirname, resolve, relative } from "node:path";
import { splitFrontmatter } from "../record-document.js";
import { yamlMetadata } from "../record-metadata.js";
import type { BrowserRecord } from "../record-service.js";
import type { RecordLookup } from "../record-lookup.js";
import { recordURL } from "./locations.js";
import { projectPath } from "./project-paths.js";
import { metadataSections } from "./record-content.js";
import { referenceAttributes } from "./record-links.js";
/** Kept headings and a suppressed document title use identical fragment identifiers. */
function headingId(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/^-|-$/g, "");
}
/** Raw HTML remains visible text; local links resolve only to registered records or their owned files. */
export function markdown(
  contents: string,
  record: (Pick<BrowserRecord, "directory" | "path"> & { title?: string }) | undefined,
  records: RecordLookup,
  pageTitle?: string,
): JSX.Element {
  const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const safeLink = (href: string): string | undefined => {
    if (/^(https?:|mailto:)/i.test(href) || href.startsWith("#")) return href;
    if (!record || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(href.split("#")[0] ?? "");
    } catch {
      return undefined;
    }
    const target = resolve(record.directory, dirname(record.path), decoded);
    const linked = records.path(target);
    if (linked) return recordURL(linked.id) + (href.includes("#") ? `#${href.split("#").slice(1).join("#")}` : "");
    const owner = records.owner(target);
    if (owner)
      return projectPath(
        `/file?id=${encodeURIComponent(owner.id)}&path=${encodeURIComponent(relative(owner.directory, target).replaceAll("\\", "/"))}`,
      );
    return undefined;
  };
  const headings = new Map<string, number>();
  parser.renderer.rules.heading_open = (tokens, index, options, _environment: unknown, renderer) => {
    const token = tokens[index];
    const text = tokens[index + 1]?.content ?? "";
    const base = headingId(text);
    const count = headings.get(base) ?? 0;
    headings.set(base, count + 1);
    token?.attrSet("id", count ? `${base}-${String(count)}` : base);
    return renderer.renderToken(tokens, index, options);
  };
  parser.renderer.rules.link_open = (tokens, index, options, _environment: unknown, renderer) => {
    const token = tokens[index];
    if (token) {
      const link = safeLink(String(token.attrGet("href") ?? ""));
      token.attrSet("href", link ?? "#unavailable-link");
      if (link?.startsWith(projectPath("/record?"))) {
        const target = records.record(new URL(link, "http://workbench.invalid").searchParams.get("id") ?? "");
        if (target) for (const [key, value] of Object.entries(referenceAttributes(target))) token.attrSet(key, value);
      }
      if (!link) token.attrSet("title", "This link is outside the registered record views.");
      token.attrSet("rel", "noreferrer noopener");
    }
    return renderer.renderToken(tokens, index, options);
  };
  parser.renderer.rules.image = (tokens, index) =>
    renderToString(<span class="muted">[Image: {tokens[index]?.content ?? ""}]</span>);
  const parts = splitFrontmatter(contents);
  let metadata: ComponentChildren = null;
  if (parts) {
    try {
      metadata = metadataSections(yamlMetadata(parts.yaml), records);
    } catch {
      metadata = (
        <section>
          <h2>Metadata</h2>
          <p class="notice">Metadata could not be parsed. Exact source:</p>
          <pre class="source">{parts.yaml}</pre>
        </section>
      );
    }
  }
  const tokens = parser.parse(parts?.body ?? contents, {});
  let anchor = "";
  if (tokens[0]?.type === "heading_open" && tokens[0].tag === "h1" && tokens[1]?.content === pageTitle) {
    const id = headingId(tokens[1]?.content ?? "");
    anchor = renderToString(<span id={id} />);
    headings.set(id, 1);
    tokens.splice(0, 3);
  }
  for (const token of tokens)
    if (["heading_open", "heading_close"].includes(token.type) && token.tag === "h1") token.tag = "h2";
  // MarkdownIt escapes document text and restricts links above; this is the sole raw HTML boundary.
  return (
    <>
      {metadata}
      <article
        class="document"
        dangerouslySetInnerHTML={{ __html: anchor + parser.renderer.render(tokens, parser.options, {}) }}
      />
    </>
  );
}
