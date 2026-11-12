import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import MarkdownIt, { type Token, type MarkdownIt as MarkdownParser } from "markdown-it";
import { diffArrays, diffWordsWithSpace } from "diff";
import { alignBlocks } from "./block-alignment.js";
import { ComparisonWork, type ComparisonBudget } from "./comparison-budget.js";
export type { ComparisonBudget } from "./comparison-budget.js";

export type Change = "same" | "removed" | "added";
export interface TextPart {
  change: Change;
  text: string;
}
export interface ComparedBlock {
  unified: Token[];
  previous: Token[];
  current: Token[];
  changed: boolean;
}
interface Node {
  token: Token;
  close?: Token;
  children: Node[];
  key: string;
  structure: string;
}
interface Mark {
  open: Token;
  close: Token;
  key: string;
}
interface Run {
  token: Token;
  marks: Mark[];
  key: string;
}
const clone = (token: Token): Token =>
  Object.assign(new MarkdownIt.Token(token.type, token.tag, token.nesting), token, {
    attrs: token.attrs?.map(([key, value]) => [key, value]) ?? null,
  });
const signature = (token: Token): string =>
  JSON.stringify([
    token.type,
    token.tag,
    token.attrs,
    token.info,
    token.type === "paragraph_open" || token.type === "paragraph_close" ? false : token.hidden,
  ]);
const textToken = (text: string): Token => Object.assign(new MarkdownIt.Token("text", "", 0), { content: text });
const textContent = (token: Token): string => (token.type === "softbreak" ? " " : token.content);
const annotation = (change: Exclude<Change, "same">, children: Token[]): Token[] => {
  if (!children.length) return [];
  const tag = change === "removed" ? "del" : "ins";
  const open = new MarkdownIt.Token("review_open", tag, 1);
  if (children.every((token) => token.type === "text" && !token.content.trim())) {
    open.attrSet("class", "diff-whitespace");
    open.attrSet("title", "Whitespace change");
  }
  return [open, ...children, new MarkdownIt.Token("review_close", tag, -1)];
};
function runs(nodes: Node[], marks: Mark[] = [], result: Run[] = []): Run[] {
  for (const node of nodes) {
    if (node.close) {
      runs(node.children, [...marks, { open: node.token, close: node.close, key: node.structure }], result);
    } else {
      const token = node.token.type === "softbreak" ? textToken(textContent(node.token)) : clone(node.token);
      const key = JSON.stringify([signature(token), marks.map((mark) => mark.key)]);
      const last = result.at(-1);
      if (token.type === "text" && last?.token.type === "text" && last.key === key) last.token.content += token.content;
      else result.push({ token, marks, key });
    }
  }
  return result;
}
/** Markdown-it owns parsing, including nested lists and tables. Our tree preserves its token nesting. */
function tree(tokens: Token[]): Node[] {
  const roots: Node[] = [],
    stack: Node[] = [];
  for (const token of tokens) {
    if (token.nesting === -1) {
      const opened = stack.pop();
      if (opened) opened.close = token;
      continue;
    }
    const node: Node = {
      token,
      children: token.type === "inline" ? tree(token.children ?? []) : [],
      key: "",
      structure: signature(token),
    };
    (stack.at(-1)?.children ?? roots).push(node);
    if (token.nesting === 1) stack.push(node);
  }
  const key = (node: Node): string => {
    const content =
      node.token.type === "inline"
        ? runs(node.children).map((run) => [run.key, run.token.content])
        : node.children.length
          ? node.children.map(key)
          : node.token.content;
    node.key = createHash("sha256")
      .update(JSON.stringify([node.structure, content]))
      .digest("hex");
    return node.key;
  };
  for (const node of roots) key(node);
  return roots;
}
function tokens(node: Node): Token[] {
  const token = clone(node.token);
  if (token.type === "inline") {
    token.children = node.children.flatMap(tokens);
    return [token];
  }
  return [token, ...node.children.flatMap(tokens), ...(node.close ? [clone(node.close)] : [])];
}
const mermaid = (node: Node | undefined): boolean =>
  node?.token.type === "fence" && node.token.info.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
function mark(
  node: Node,
  change: Exclude<Change, "same">,
  diagram: (before: Node | undefined, after: Node | undefined) => Token[],
): Token[] {
  if (mermaid(node)) return diagram(change === "removed" ? node : undefined, change === "added" ? node : undefined);
  const token = clone(node.token);
  if (token.type === "inline") {
    token.children = annotation(change, runsTokens(runs(node.children)));
    return [token];
  }
  if (token.type === "fence" || token.type === "code_block") {
    token.type = "review_code";
    token.children = annotation(change, [textToken(token.content)]);
    return [token];
  }
  token.attrJoin("class", "diff-block-" + change);
  return [
    token,
    ...node.children.flatMap((child) => mark(child, change, diagram)),
    ...(node.close ? [clone(node.close)] : []),
  ];
}
function runsTokens(items: Run[]): Token[] {
  const result: Token[] = [];
  let active: Mark[] = [];
  for (const item of items) {
    let common = 0;
    while (common < active.length && common < item.marks.length && active[common]?.key === item.marks[common]?.key)
      common++;
    result.push(
      ...active
        .slice(common)
        .reverse()
        .map((mark) => clone(mark.close)),
    );
    result.push(...item.marks.slice(common).map((mark) => clone(mark.open)));
    result.push(clone(item.token));
    active = item.marks;
  }
  result.push(...[...active].reverse().map((mark) => clone(mark.close)));
  return result;
}
/** Group nearby word edits, retaining complete unchanged sentences between separate replacements. */
function grouped<T>(
  parts: { added?: boolean; removed?: boolean; value: T[] }[],
  text: (value: T) => string,
  work: ComparisonWork,
): { change: Change; value: T[] }[] {
  const first = parts.findIndex((part) => (part.added ?? false) || (part.removed ?? false));
  if (first < 0) return [{ change: "same", value: parts.flatMap((part) => part.value) }];
  let last = parts.length - 1;
  while (!parts[last]?.added && !parts[last]?.removed) last--;
  const preserved = new Set<number>();
  if (work.available() && parts.slice(first + 1, last).some((part) => !part.added && !part.removed)) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
    const strings = parts.map((part) => part.value.map(text).join(""));
    const unchangedSentences = (skip: "added" | "removed") => {
      const source = strings.filter((_value, index) => !parts[index]?.[skip]).join("");
      const sentences = segmenter.segment(source)[Symbol.iterator]();
      let sentence = sentences.next(),
        offset = 0;
      const found = new Set<number>();
      for (const [index, part] of parts.entries()) {
        if (!work.available()) return new Set<number>();
        if (part[skip]) continue;
        const end = offset + (strings[index]?.length ?? 0);
        while (!sentence.done) {
          if (!work.available()) return new Set<number>();
          const value = sentence.value;
          const start = value.index + value.segment.length - value.segment.trimStart().length;
          const finish = value.index + value.segment.trimEnd().length;
          if (finish > end) break;
          if (!part.added && !part.removed && start >= offset && finish > start) found.add(index);
          sentence = sentences.next();
        }
        offset = end;
      }
      return found;
    };
    const oldSentences = unchangedSentences("added"),
      nextSentences = unchangedSentences("removed");
    for (const index of oldSentences) if (nextSentences.has(index)) preserved.add(index);
  }
  const result: { change: Change; value: T[] }[] = [];
  let removed: T[] = [],
    added: T[] = [];
  const push = (change: Change, value: T[]) => {
    if (value.length) result.push({ change, value });
  };
  const flush = () => {
    push("removed", removed);
    push("added", added);
    removed = [];
    added = [];
  };
  for (const [index, part] of parts.entries()) {
    if (index < first || index > last || preserved.has(index)) {
      flush();
      push("same", part.value);
    } else {
      if (!part.added) removed.push(...part.value);
      if (!part.removed) added.push(...part.value);
    }
  }
  flush();
  return result;
}
export function textChanges(before: string, after: string, work = new ComparisonWork()): TextPart[] {
  if (before === after) return [{ change: "same", text: before }];
  const changes = work.available()
    ? diffWordsWithSpace(before, after, { timeout: work.remaining(), maxEditLength: work.maxEdits })
    : undefined;
  const parts = grouped(
    (
      changes ?? [
        { removed: true, value: before },
        { added: true, value: after },
      ]
    ).map((part) => ({ ...part, value: [part.value] })),
    (value) => value,
    work,
  );
  return parts.map(({ change, value }) => ({ change, text: value.join("") }));
}

/** Compare complete Markdown bodies. Fine matching is bounded; fallback preserves every block on both sides. */
export function compareDocuments(
  before: string,
  after: string,
  pageTitle?: string,
  options: { budget?: ComparisonBudget; parser?: MarkdownParser; work?: ComparisonWork } = {},
) {
  const work = options.work ?? new ComparisonWork(options.budget),
    parser = options.parser ?? new MarkdownIt({ html: false });
  const leftEnvironment: Record<string, unknown> = {},
    rightEnvironment: Record<string, unknown> = {};
  const left = parser.parse(before, leftEnvironment),
    right = parser.parse(after, rightEnvironment);
  const sharedTitle = left[1]?.content === right[1]?.content && right[1]?.content === pageTitle;
  for (const document of [left, right]) {
    if (sharedTitle && document[0]?.type === "heading_open" && document[0].tag === "h1") document.splice(0, 3);
    for (const token of document)
      if ((token.type === "heading_open" || token.type === "heading_close") && token.tag === "h1") token.tag = "h2";
  }
  const flags = { coarse: false };
  let diagramSequence = 0;
  const diagram = (old: Node | undefined, next: Node | undefined) => {
    const id = String(++diagramSequence),
      parts = textChanges(old?.token.content ?? "", next?.token.content ?? "", work);
    const side = (side: "unified" | "previous" | "current"): Token[] => {
      const token = new MarkdownIt.Token("review_diagram", "", 0);
      token.info = "mermaid";
      token.attrSet("comparison", id);
      token.attrSet("side", side);
      if (old) token.attrSet("before", old.token.content);
      if (next) token.attrSet("after", next.token.content);
      token.children = parts.flatMap((part) =>
        (side === "previous" && part.change === "added") || (side === "current" && part.change === "removed")
          ? []
          : part.change === "same"
            ? [textToken(part.text)]
            : annotation(part.change, [textToken(part.text)]),
      );
      return [token];
    };
    return { unified: side("unified"), previous: side("previous"), current: side("current"), changed: true };
  };
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  const profiles = new WeakMap<
    Node,
    { words: Map<string, number>; bigrams: Map<string, number>; count: number } | undefined
  >();
  const plainText = (node: Node): string =>
    node.children.length
      ? node.children.map(plainText).join(node.token.type === "inline" ? "" : " ")
      : textContent(node.token);
  const profile = (node: Node) => {
    if (profiles.has(node)) return profiles.get(node);
    const words = new Map<string, number>();
    const bigrams = new Map<string, number>();
    let count = 0;
    let previous: string | undefined;
    for (const part of segmenter.segment(plainText(node))) {
      if (!work.available() || count >= work.maxWords) {
        flags.coarse = true;
        profiles.set(node, undefined);
        return undefined;
      }
      if (!part.isWordLike) continue;
      const word = part.segment.toLowerCase();
      words.set(word, (words.get(word) ?? 0) + 1);
      if (previous !== undefined) {
        const pair = previous + "\0" + word;
        bigrams.set(pair, (bigrams.get(pair) ?? 0) + 1);
      }
      previous = word;
      count++;
    }
    const value = { words, bigrams, count };
    profiles.set(node, value);
    return value;
  };
  const similarity = (old: Node, next: Node): number | undefined => {
    if (old.structure !== next.structure) return undefined;
    if (old.key === next.key) return 1;
    const a = profile(old),
      b = profile(next);
    if (!a || !b || !a.count || !b.count) return undefined;
    let shared = 0;
    const [small, large] = a.words.size <= b.words.size ? [a.words, b.words] : [b.words, a.words];
    for (const [word, count] of small) shared += Math.min(count, large.get(word) ?? 0);
    const wordScore = (2 * shared) / (a.count + b.count);
    if (a.count < 2 || b.count < 2) return wordScore;
    let ordered = 0;
    for (const [pair, count] of a.bigrams) ordered += Math.min(count, b.bigrams.get(pair) ?? 0);
    return 0.8 * wordScore + 0.2 * ((2 * ordered) / (a.count + b.count - 2));
  };
  const words = (nodes: Node[]): Run[] | undefined => {
    const result: Run[] = [];
    for (const run of runs(nodes)) {
      if (!work.available()) return undefined;
      if (run.token.type !== "text") result.push(run);
      else
        for (const { segment } of segmenter.segment(run.token.content)) {
          if (result.length >= work.maxWords || !work.available()) return undefined;
          result.push({ ...run, token: textToken(segment), key: run.key });
        }
    }
    return result;
  };
  const inline = (old: Node, next: Node): ComparedBlock | undefined => {
    const a = words(old.children),
      b = words(next.children);
    if (!a || !b) return undefined;
    const changes = diffArrays(a, b, {
      comparator: (a, b) => a.key === b.key && a.token.content === b.token.content,
      timeout: Math.max(1, work.remaining()),
      maxEditLength: work.maxEdits,
    });
    if (!changes) return undefined;
    const parts = grouped(changes, (run) => run.token.content, work);
    const content = (items: Token[], source = next.token) => {
      const token = clone(source);
      token.children = items.map(clone);
      return [token];
    };
    const render = (side: "unified" | "previous" | "current") =>
      content(
        parts.flatMap((part, index) => {
          if ((side === "previous" && part.change === "added") || (side === "current" && part.change === "removed"))
            return [];
          const items = runsTokens(part.value);
          if (part.change === "same") return items;
          const separator =
            side === "unified" && part.change === "added" && parts[index - 1]?.change === "removed"
              ? [Object.assign(new MarkdownIt.Token("review_separator", "", 0), { content: " " })]
              : [];
          return [...separator, ...annotation(part.change, items)];
        }),
        side === "previous" ? old.token : next.token,
      );
    return {
      unified: render("unified"),
      previous: render("previous"),
      current: render("current"),
      changed: parts.some((part) => part.change !== "same"),
    };
  };
  const tableLayout = (node: Node): unknown => [
    node.structure,
    node.token.type === "inline" ? [] : node.children.map(tableLayout),
  ];
  const pair = (old: Node | undefined, next: Node | undefined): ComparedBlock => {
    if (old && old.key === next?.key)
      return { unified: tokens(next), previous: tokens(old), current: tokens(next), changed: false };
    if ((mermaid(old) || mermaid(next)) && (!old || mermaid(old)) && (!next || mermaid(next)))
      return diagram(old, next);
    const incompatibleTable =
      old?.token.tag === "table" &&
      next?.token.tag === "table" &&
      JSON.stringify(tableLayout(old)) !== JSON.stringify(tableLayout(next));
    if (old && next && !incompatibleTable && old.structure === next.structure) {
      if (old.token.type === "inline") {
        const compared = inline(old, next);
        if (compared) return compared;
        flags.coarse = true;
      } else if (old.close && next.close) {
        const children = compare(old.children, next.children);
        const wrap = (side: "unified" | "previous" | "current") => {
          const source = side === "previous" ? old : next;
          return [clone(source.token), ...children.flatMap((row) => row[side]), clone(source.close ?? source.token)];
        };
        return {
          unified: wrap("unified"),
          previous: wrap("previous"),
          current: wrap("current"),
          changed: children.some((row) => row.changed),
        };
      }
    }
    const previous = old ? mark(old, "removed", (before, after) => diagram(before, after).previous) : [],
      current = next ? mark(next, "added", (before, after) => diagram(before, after).current) : [];
    return { unified: [...previous, ...current], previous, current, changed: true };
  };
  const compare = (old: Node[], next: Node[]): ComparedBlock[] => {
    if (old.length === next.length && old.every((node, index) => node.key === next[index]?.key))
      return old.map((node, index) => pair(node, next[index]));
    const changes = work.available()
      ? diffArrays(old, next, {
          comparator: (a, b) => a.key === b.key,
          timeout: Math.max(1, work.remaining()),
          maxEditLength: work.maxEdits,
        })
      : undefined;
    if (!changes) flags.coarse = true;
    const groups = changes ?? [
      { removed: true, added: false, value: old },
      { added: true, removed: false, value: next },
    ];
    const result: ComparedBlock[] = [];
    let previousIndex = 0;
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      if (!group) continue;
      if (!group.added && !group.removed) {
        for (const node of group.value) result.push(pair(old[previousIndex++], node));
        continue;
      }
      const removed = group.removed ? group.value : [],
        added = group.added ? group.value : groups[index + 1]?.added ? (groups[++index]?.value ?? []) : [];
      previousIndex += removed.length;
      const aligned =
        removed.length === 1 && added.length === 1 && work.available()
          ? [[removed[0], added[0]] as const]
          : alignBlocks(removed, added, similarity, {
              available: () => work.available(),
              maxCells: work.maxAlignmentCells,
            });
      if (aligned) for (const [previous, current] of aligned) result.push(pair(previous, current));
      else {
        flags.coarse = true;
        for (const node of removed) result.push(pair(node, undefined));
        for (const node of added) result.push(pair(undefined, node));
      }
    }
    return result;
  };
  const rows = compare(tree(left), tree(right));
  return {
    rows,
    coarse: flags.coarse && rows.some((row) => row.changed),
    changed: rows.some((row) => row.changed),
    referencesChanged: !isDeepStrictEqual(leftEnvironment.references ?? {}, rightEnvironment.references ?? {}),
  };
}

/** Only fixed annotation tags are introduced; document text still goes through Markdown-it's escaping. */
export function reviewAnnotations(parser: MarkdownParser): void {
  parser.renderer.rules.review_open = (tokens, index, options, _env, renderer) =>
    renderer.renderToken(tokens, index, options);
  parser.renderer.rules.review_close = (tokens, index, options, _env, renderer) =>
    renderer.renderToken(tokens, index, options);
  parser.renderer.rules.review_separator = () => '<span class="diff-separator" aria-hidden="true"> </span>';
  parser.renderer.rules.review_code = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    if (!token) return "";
    const language = token.info.trim().split(/\s+/)[0] ?? "";
    return (
      "<pre><code" +
      (language ? ' class="language-' + parser.utils.escapeHtml(language) + '"' : "") +
      ">" +
      renderer.renderInline(token.children ?? [], options, environment) +
      "</code></pre>\n"
    );
  };
  if (!Object.hasOwn(parser.renderer.rules, "review_diagram"))
    parser.renderer.rules.review_diagram = (tokens, index, options, environment, renderer) => {
      const token = tokens[index],
        side = token?.attrGet("side");
      if (
        !token ||
        (side === "previous" && token.attrGet("before") === null) ||
        (side === "current" && token.attrGet("after") === null)
      )
        return "";
      return parser.renderer.rules.review_code?.(tokens, index, options, environment, renderer) ?? "";
    };
}
