import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import MarkdownIt, { type Token, type MarkdownIt as MarkdownParser } from "markdown-it";
import { diffArrays, diffWordsWithSpace } from "diff";

export type Change = "same" | "removed" | "added";
export interface TextPart {
  change: Change;
  text: string;
}
export interface ComparisonBudget {
  now: () => number;
  milliseconds: number;
  maxEdits: number;
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
  JSON.stringify([token.type, token.tag, token.attrs, token.info, token.hidden]);
const textToken = (text: string): Token => Object.assign(new MarkdownIt.Token("text", "", 0), { content: text });
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
      runs(node.children, [...marks, { open: node.token, close: node.close, key: signature(node.token) }], result);
    } else {
      const token = node.token.type === "softbreak" ? textToken(" ") : clone(node.token);
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
    const node: Node = { token, children: token.type === "inline" ? tree(token.children ?? []) : [], key: "" };
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
      .update(JSON.stringify([signature(node.token), content]))
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
function mark(node: Node, change: Exclude<Change, "same">): Token[] {
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
  return [token, ...node.children.flatMap((child) => mark(child, change)), ...(node.close ? [clone(node.close)] : [])];
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
/** One edited passage per paragraph, keeping its unchanged outer context only once. */
function grouped<T>(parts: { added?: boolean; removed?: boolean; value: T[] }[]): {
  prefix: T[];
  removed: T[];
  added: T[];
  suffix: T[];
} {
  const first = parts.findIndex((part) => (part.added ?? false) || (part.removed ?? false));
  if (first < 0) return { prefix: parts.flatMap((part) => part.value), removed: [], added: [], suffix: [] };
  let last = parts.length - 1;
  while (!parts[last]?.added && !parts[last]?.removed) last--;
  const middle = parts.slice(first, last + 1);
  return {
    prefix: parts.slice(0, first).flatMap((part) => part.value),
    removed: middle.filter((part) => !part.added).flatMap((part) => part.value),
    added: middle.filter((part) => !part.removed).flatMap((part) => part.value),
    suffix: parts.slice(last + 1).flatMap((part) => part.value),
  };
}
export function textChanges(before: string, after: string): TextPart[] {
  const changes = diffWordsWithSpace(before, after, { timeout: 40, maxEditLength: 2048 });
  const parts = grouped(
    (
      changes ?? [
        { removed: true, value: before },
        { added: true, value: after },
      ]
    ).map((part) => ({ ...part, value: [part.value] })),
  );
  return (
    [
      ["same", parts.prefix],
      ["removed", parts.removed],
      ["added", parts.added],
      ["same", parts.suffix],
    ] as const
  ).flatMap(([change, values]) => (values.length ? [{ change, text: values.join("") }] : []));
}

/** Compare complete Markdown bodies. Fine matching is bounded; fallback preserves every block on both sides. */
export function compareDocuments(
  before: string,
  after: string,
  pageTitle?: string,
  budget: ComparisonBudget = { now: () => performance.now(), milliseconds: 60, maxEdits: 2048 },
) {
  const parser = new MarkdownIt({ html: false }),
    deadline = budget.now() + budget.milliseconds;
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
  const words = (nodes: Node[]): Run[] | undefined => {
    const result: Run[] = [];
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    for (const run of runs(nodes)) {
      if (budget.now() >= deadline) return undefined;
      if (run.token.type !== "text") result.push(run);
      else
        for (const { segment } of segmenter.segment(run.token.content)) {
          if (result.length >= 20000 || budget.now() >= deadline) return undefined;
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
      timeout: Math.max(1, deadline - budget.now()),
      maxEditLength: budget.maxEdits,
    });
    if (!changes) return undefined;
    const parts = grouped(changes);
    const content = (items: Token[], source = next.token) => {
      const token = clone(source);
      token.children = items.map(clone);
      return [token];
    };
    const prefix = runsTokens(parts.prefix),
      suffix = runsTokens(parts.suffix);
    return {
      unified: content([
        ...prefix,
        ...annotation("removed", runsTokens(parts.removed)),
        ...(parts.removed.length && parts.added.length
          ? [Object.assign(new MarkdownIt.Token("review_separator", "", 0), { content: " " })]
          : []),
        ...annotation("added", runsTokens(parts.added)),
        ...suffix,
      ]),
      previous: content([...prefix, ...annotation("removed", runsTokens(parts.removed)), ...suffix], old.token),
      current: content([...prefix, ...annotation("added", runsTokens(parts.added)), ...suffix]),
      changed: parts.removed.length + parts.added.length > 0,
    };
  };
  const tableLayout = (node: Node): unknown => [
    signature(node.token),
    node.token.type === "inline" ? [] : node.children.map(tableLayout),
  ];
  const pair = (old: Node | undefined, next: Node | undefined): ComparedBlock => {
    if (old && old.key === next?.key)
      return { unified: tokens(next), previous: tokens(old), current: tokens(next), changed: false };
    const incompatibleTable =
      old?.token.tag === "table" &&
      next?.token.tag === "table" &&
      JSON.stringify(tableLayout(old)) !== JSON.stringify(tableLayout(next));
    if (old && next && !incompatibleTable && signature(old.token) === signature(next.token)) {
      if (old.token.type === "inline") {
        const compared = inline(old, next);
        if (compared) return compared;
        flags.coarse = true;
      } else if (old.close && next.close) {
        const children = compare(old.children, next.children);
        const wrap = (side: "unified" | "previous" | "current") => [
          clone(next.token),
          ...children.flatMap((row) => row[side]),
          clone(next.close ?? next.token),
        ];
        return {
          unified: wrap("unified"),
          previous: wrap("previous"),
          current: wrap("current"),
          changed: children.some((row) => row.changed),
        };
      }
    }
    const previous = old ? mark(old, "removed") : [],
      current = next ? mark(next, "added") : [];
    return { unified: [...previous, ...current], previous, current, changed: true };
  };
  const compare = (old: Node[], next: Node[]): ComparedBlock[] => {
    const changes =
      budget.now() < deadline
        ? diffArrays(old, next, {
            comparator: (a, b) => a.key === b.key,
            timeout: Math.max(1, deadline - budget.now()),
            maxEditLength: budget.maxEdits,
          })
        : undefined;
    if (!changes) flags.coarse = true;
    const groups = changes ?? [
      { removed: true, added: false, value: old },
      { added: true, removed: false, value: next },
    ];
    const result: ComparedBlock[] = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      if (!group) continue;
      if (!group.added && !group.removed) {
        result.push(...group.value.map((node) => pair(node, node)));
        continue;
      }
      const removed = group.removed ? group.value : [],
        added = group.added ? group.value : groups[index + 1]?.added ? (groups[++index]?.value ?? []) : [];
      for (let row = 0; row < Math.max(removed.length, added.length); row++)
        result.push(pair(removed[row], added[row]));
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
}
