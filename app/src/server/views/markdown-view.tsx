import type { ComponentChildren, JSX } from "preact";
import { renderToString } from "preact-render-to-string";
import MarkdownIt, { type Token, type MarkdownIt as MarkdownParser } from "markdown-it";
import { dirname, resolve, relative, posix } from "node:path";
import { splitFrontmatter } from "../../core/records/record-document.js";
import { yamlMetadata } from "../../core/records/record-metadata.js";
import type { BrowserRecord } from "../../core/records/record-service.js";
import type { RecordLookup } from "../../core/records/record-lookup.js";
import { recordURL, routeURL } from "../routes/locations.js";
import { Route } from "../routes/routes.js";
import { metadataSections } from "./record-content.js";
import { referenceAttributes } from "./record-links.js";
import { normalizedNumber } from "../../core/records/record-identity.js";
import { experimentIsResult } from "../../core/experiments/experiment-workflow.js";
import { required } from "../../core/runtime/invariants.js";
import { diagramView, diagramComparisonView } from "./diagram-view.js";
import { markdownHeadingId } from "../../core/records/markdown-links.js";
const documentPrefix = "document-";

/** Raw HTML remains visible text; local links resolve only to registered records or their owned files. */
export type MarkdownRecord = Pick<BrowserRecord, "directory" | "path"> & {
  title?: string;
  scope?: string;
  type?: BrowserRecord["type"];
  planFiles?: { reference: string; names: readonly string[]; version?: "approved"; base?: string };
};
export function markdownParser(
  record: MarkdownRecord | undefined,
  records: RecordLookup,
  prefix = documentPrefix,
  headings = new Map<string, number>(),
): MarkdownParser {
  const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const owner = record
    ? (records.path(resolve(record.directory, record.path)) ?? records.owner(resolve(record.directory, record.path)))
    : undefined;
  parser.core.ruler.after("inline", "record-references", (state) => {
    for (const block of state.tokens) {
      if (!block.children) continue;
      let links = 0;
      block.children = block.children.flatMap((token) => {
        if (token.type === "link_open") links++;
        if (token.type === "link_close") links--;
        if (token.type !== "text" || links) return [token];
        const output: Token[] = [];
        let offset = 0;
        const pattern =
          /(?<![\p{L}\p{N}_:/-])(?:([a-z][a-z0-9_-]*):)?(?:(ADR|TSK|EXP|ENV|CIT|REL)-([0-9a-z][0-9a-z_]*)|plan\/([a-z][a-z0-9_-]{0,119}))(?![\p{L}\p{N}_/-])/giu;
        for (const match of token.content.matchAll(pattern)) {
          const scope = match[1]?.toLowerCase() ?? record?.scope ?? owner?.scope;
          if (!scope) continue;
          const reference = match[4]
            ? `${scope}:plan/${match[4]}`
            : match[2] && match[3]
              ? `${scope}:${match[2].toUpperCase()}-${normalizedNumber(match[3])}`
              : undefined;
          const target = reference ? records.record(reference) : undefined;
          if (!target) continue;
          const text = (value: string) => {
            const part = new state.Token("text", "", 0);
            part.content = value;
            return part;
          };
          if (match.index > offset) output.push(text(token.content.slice(offset, match.index)));
          const open = new state.Token("link_open", "a", 1);
          open.attrSet("href", recordURL(target.id));
          for (const [key, value] of Object.entries(referenceAttributes(target))) open.attrSet(key, value);
          output.push(open, text(match[0]), new state.Token("link_close", "a", -1));
          offset = match.index + match[0].length;
        }
        if (!output.length) return [token];
        if (offset < token.content.length) {
          const tail = new state.Token("text", "", 0);
          tail.content = token.content.slice(offset);
          output.push(tail);
        }
        return output;
      });
    }
  });
  const safeLink = (href: string): { href: string; target?: BrowserRecord } | undefined => {
    if (href.startsWith("#")) return { href: href === "#" ? "#main" : "#" + prefix + href.slice(1) };
    if (/^(https?:|mailto:)/i.test(href)) return { href };
    if (!record || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(href.split("#")[0] ?? "");
    } catch {
      return undefined;
    }
    const fragment = href.includes("#") ? "#" + documentPrefix + href.slice(href.indexOf("#") + 1) : "";
    if (record.planFiles) {
      const resolved = posix.normalize(posix.join(record.planFiles.base ?? "", decoded));
      const name = record.planFiles.base === undefined ? resolved.replace(/^files\//, "") : resolved;
      if (!record.planFiles.names.includes(name)) return undefined;
      return {
        href:
          routeURL(Route.PlanFile, {
            id: record.planFiles.reference,
            path: name,
            ...(record.planFiles.version ? { version: record.planFiles.version } : {}),
          }) + fragment,
      };
    }
    const target = resolve(record.directory, dirname(record.path), decoded);
    const linked = records.path(target);
    if (linked)
      return {
        href: recordURL(linked.id) + fragment,
        target: linked,
      };
    const owner = records.owner(target);
    if (owner)
      return {
        href:
          routeURL(Route.File, { id: owner.id, path: relative(owner.directory, target).replaceAll("\\", "/") }) +
          fragment,
      };
    return undefined;
  };
  parser.renderer.rules.heading_open = (tokens, index, options, _environment: unknown, renderer) => {
    const token = tokens[index];
    const text = tokens[index + 1]?.content ?? "";
    const base = markdownHeadingId(text);
    const count = headings.get(base) ?? 0;
    headings.set(base, count + 1);
    token?.attrSet("id", prefix + (count ? `${base}-${String(count)}` : base));
    return renderer.renderToken(tokens, index, options);
  };
  parser.renderer.rules.link_open = (tokens, index, options, _environment: unknown, renderer) => {
    const token = tokens[index];
    if (token) {
      const reference = String(token.attrGet("data-record-reference") ?? "");
      const target = reference ? records.record(reference) : undefined;
      const link = target ? { href: recordURL(target.id), target } : safeLink(String(token.attrGet("href") ?? ""));
      token.attrSet("href", link?.href ?? "#unavailable-link");
      if (link?.target)
        for (const [key, value] of Object.entries(referenceAttributes(link.target))) token.attrSet(key, value);
      if (!link) token.attrSet("title", "This link is outside the registered record views.");
      token.attrSet("rel", "noreferrer noopener");
    }
    return renderer.renderToken(tokens, index, options);
  };
  // Fixed wrappers keep wide authored tables scrollable and keyboard-accessible within the document.
  parser.renderer.rules.table_open = (tokens, index, options, _environment: unknown, renderer) =>
    '<div class="table-wrap" role="region" aria-label="Document table" tabindex="0">' +
    renderer.renderToken(tokens, index, options);
  parser.renderer.rules.table_close = (tokens, index, options, _environment: unknown, renderer) =>
    renderer.renderToken(tokens, index, options) + "</div>";
  parser.renderer.rules.image = (tokens, index) =>
    renderToString(<span class="muted">[Image: {tokens[index]?.content ?? ""}]</span>);
  const fence = required(parser.renderer.rules.fence, "Markdown code renderer is unavailable");
  parser.renderer.rules.fence = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    return token?.info.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid"
      ? renderToString(diagramView(token.content))
      : fence(tokens, index, options, environment, renderer);
  };
  parser.renderer.rules.review_diagram = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    if (!token) return "";
    const attribute = (name: string) => {
      const value = token.attrGet(name);
      return value === null ? null : String(value);
    };
    const side = attribute("side");
    if (side !== "unified" && side !== "previous" && side !== "current")
      throw new Error("Invalid diagram comparison side");
    const source = renderer.renderInline(token.children ?? [], options, environment);
    return renderToString(
      diagramComparisonView(
        attribute("before"),
        attribute("after"),
        attribute("comparison") ?? "",
        side,
        <pre>
          <code class="language-mermaid" dangerouslySetInnerHTML={{ __html: source }} />
        </pre>,
      ),
    );
  };
  return parser;
}

/** The renderer accepts only tokens produced with raw HTML disabled and trusted review annotations. */
export function markdownTokens(parser: MarkdownParser, tokens: Token[], anchor = ""): JSX.Element {
  return (
    <article
      class="document"
      dangerouslySetInnerHTML={{ __html: anchor + parser.renderer.render(tokens, parser.options, {}) }}
    />
  );
}

export function markdown(
  contents: string,
  record: MarkdownRecord | undefined,
  records: RecordLookup,
  pageTitle?: string,
  prefix = documentPrefix,
): JSX.Element {
  const headings = new Map<string, number>();
  const parser = markdownParser(record, records, prefix, headings);
  const parts = splitFrontmatter(contents);
  let metadata: ComponentChildren = null;
  if (parts) {
    try {
      const fields = yamlMetadata(parts.yaml),
        { status, ...rest } = fields;
      metadata = metadataSections(
        record?.type === "EXP" && typeof status === "string" && experimentIsResult(status)
          ? { "Candidate verdict": status, ...rest }
          : fields,
        records,
      );
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
    const id = markdownHeadingId(tokens[1]?.content ?? "");
    anchor = renderToString(<span id={prefix + id} />);
    headings.set(id, 1);
    tokens.splice(0, 3);
  }
  for (const token of tokens)
    if (["heading_open", "heading_close"].includes(token.type) && token.tag === "h1") token.tag = "h2";
  // MarkdownIt escapes document text and restricts links above; this is the sole raw HTML boundary.
  return (
    <>
      {metadata}
      {markdownTokens(parser, tokens, anchor)}
    </>
  );
}
