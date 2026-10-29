import { diffArrays, diffWordsWithSpace } from "diff";
import MarkdownIt from "markdown-it";
import { splitFrontmatter } from "../record-document.js";

interface Block {
  kind: "paragraph" | "literal";
  context: string;
  text: string;
  section: string;
}
export interface DiffPart {
  change: "same" | "removed" | "added";
  text: string;
}
export interface ParagraphChange {
  kind: Block["kind"];
  section: string;
  before: string | null;
  after: string | null;
  parts: DiffPart[];
}
export interface ParagraphDifference {
  changes: ParagraphChange[];
  formattingOnly: boolean;
  coarse: boolean;
}

/** Keep unchanged outer context once, and present the edited passage as one replacement. */
function consolidateEdits(parts: DiffPart[]): DiffPart[] {
  const first = parts.findIndex((part) => part.change !== "same");
  if (first < 0) return parts;
  let last = parts.length - 1;
  while (parts[last]?.change === "same") last--;
  const passage = parts.slice(first, last + 1);
  const removed = passage
    .filter((part) => part.change !== "added")
    .map((part) => part.text)
    .join("");
  const added = passage
    .filter((part) => part.change !== "removed")
    .map((part) => part.text)
    .join("");
  return [
    ...parts.slice(0, first),
    ...(removed ? [{ change: "removed" as const, text: removed }] : []),
    ...(added ? [{ change: "added" as const, text: added }] : []),
    ...parts.slice(last + 1),
  ];
}

/** Markdown's own block maps and soft-break tokens determine where wrapping is insignificant. */
function blocks(contents: string): Block[] {
  const result: Block[] = [];
  const normalized = contents.replace(/\r\n?/g, "\n");
  const document = splitFrontmatter(normalized);
  const body = document?.body ?? normalized;
  const frontmatter = document ? normalized.slice(0, normalized.length - body.length) : "";
  if (frontmatter)
    result.push({ kind: "literal", context: "metadata", section: "Metadata", text: frontmatter.trimEnd() });
  const lines = body.split("\n");
  const tokens = new MarkdownIt({ html: false }).parse(body, {});
  const parents: string[] = [];
  let end = 0,
    section = "";
  const literal = (from: number, through: number) => {
    const text = lines
      .slice(from, through)
      .join("\n")
      .replace(/^\n+|\n+$/g, "");
    if (text) result.push({ kind: "literal", context: "source", section, text });
  };
  for (const [index, token] of tokens.entries()) {
    if (token.nesting === -1) {
      parents.pop();
      continue;
    }
    const map = token.map;
    if (
      map &&
      map[0] >= end &&
      ["paragraph_open", "heading_open", "fence", "code_block", "html_block", "hr", "table_open"].includes(token.type)
    ) {
      literal(end, map[0]);
      const raw = lines.slice(map[0], map[1]).join("\n");
      const inline = tokens[index + 1];
      const prose =
        ["paragraph_open", "heading_open"].includes(token.type) &&
        inline?.type === "inline" &&
        !inline.children?.some((child) => child.type === "hardbreak");
      let text = raw;
      if (prose) {
        const first = inline.content.split("\n")[0] ?? "",
          line = lines[map[0]] ?? "";
        const offset = first ? line.indexOf(first) : -1;
        const prefix = offset >= 0 ? line.slice(0, offset) : "";
        text = prefix + inline.content.replace(/[ \t]*\n[ \t]*/g, " ");
      }
      if (token.type === "heading_open")
        section = token.tag === "h1" ? "" : (inline?.content.replace(/\s*\n\s*/g, " ") ?? "");
      result.push({
        kind: prose ? "paragraph" : "literal",
        context: parents.join("/") + "/" + token.tag,
        section,
        text,
      });
      end = map[1];
    }
    if (token.nesting === 1) parents.push(`${token.tag}:${String(token.attrGet("start") ?? "")}`);
  }
  literal(end, lines.length);
  return result;
}

/** jsdiff owns matching and word differencing; our adapter supplies Markdown blocks and presentation data. */
export interface DifferenceBudget {
  now: () => number;
  milliseconds: number;
  blockMilliseconds: number;
  maxEdits: number;
}
export function paragraphDifference(
  before: string,
  after: string,
  budget: DifferenceBudget = { now: () => performance.now(), milliseconds: 60, blockMilliseconds: 40, maxEdits: 2048 },
): ParagraphDifference {
  const old = blocks(before),
    next = blocks(after),
    deadline = budget.now() + budget.milliseconds;
  const difference = diffArrays(old, next, {
    comparator: (left, right) => left.kind === right.kind && left.context === right.context && left.text === right.text,
    timeout: budget.blockMilliseconds,
    maxEditLength: budget.maxEdits,
  });
  const result: ParagraphDifference = { changes: [], formattingOnly: false, coarse: difference === undefined };
  const changes = difference ?? [
    { removed: true, added: false, value: old },
    { added: true, removed: false, value: next },
  ];
  const append = (previous: Block | undefined, current: Block | undefined) => {
    if (!previous && !current) return;
    if (previous && current && (previous.kind !== current.kind || previous.context !== current.context)) {
      append(previous, undefined);
      append(undefined, current);
      return;
    }
    const wordChanges =
      previous && current && budget.now() < deadline
        ? diffWordsWithSpace(previous.text, current.text, {
            timeout: Math.max(1, deadline - budget.now()),
            maxEditLength: budget.maxEdits,
          })
        : undefined;
    if (previous && current && !wordChanges) result.coarse = true;
    const parts: DiffPart[] = wordChanges
      ? wordChanges.map((part) => ({
          change: part.added ? "added" : part.removed ? "removed" : "same",
          text: part.value,
        }))
      : [
          ...(previous ? [{ change: "removed" as const, text: previous.text }] : []),
          ...(current ? [{ change: "added" as const, text: current.text }] : []),
        ];
    result.changes.push({
      kind: current?.kind ?? previous?.kind ?? "literal",
      section: current?.section ?? previous?.section ?? "",
      before: previous?.text ?? null,
      after: current?.text ?? null,
      parts: consolidateEdits(parts),
    });
  };
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    if (!change || (!change.added && !change.removed)) continue;
    const removed = change.removed ? change.value : [];
    const added = change.added ? change.value : changes[index + 1]?.added ? (changes[++index]?.value ?? []) : [];
    for (let row = 0; row < Math.max(removed.length, added.length); row++) append(removed[row], added[row]);
  }
  result.formattingOnly = !result.changes.length && before !== after;
  return result;
}
