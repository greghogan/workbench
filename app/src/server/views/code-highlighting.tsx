import { common, createLowlight } from "lowlight";
import { extname, basename } from "node:path";
import type { ComponentChildren } from "preact";
import { createHash } from "node:crypto";
import { WeightedCache } from "../../core/storage/weighted-cache.js";

const syntax = createLowlight(common);
type SyntaxNode = ReturnType<typeof syntax.highlight>["children"][number];
const languages: ReadonlyMap<string, string> = new Map(
  Object.entries({
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    hh: "cpp",
    ts: "typescript",
    tsx: "typescript",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    rb: "ruby",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    ps1: "powershell",
    css: "css",
    md: "markdown",
    markdown: "markdown",
    html: "xml",
    htm: "xml",
    xml: "xml",
    json: "json",
    jsonc: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    ini: "ini",
    sql: "sql",
    cmake: "cmake",
  }),
);
export const codeHighlightLimit = 64 * 1024;
interface CodeToken {
  start: number;
  end: number;
  value: string;
  classes: string;
}
const highlights = new WeightedCache<readonly CodeToken[]>(16 * 1024 * 1024);

/** Whole-file lexing preserves multiline syntax; ranges preserve the literal diff's original text and offsets. */
export function codeTokens(source: string, path = ""): readonly CodeToken[] {
  const language = basename(path) === "CMakeLists.txt" ? "cmake" : languages.get(extname(path).slice(1).toLowerCase());
  const plain = [{ start: 0, end: source.length, value: source, classes: "" }];
  if (!language || !syntax.registered(language) || Buffer.byteLength(source) > codeHighlightLimit) return plain;
  const key = `${language}:${createHash("sha256").update(source).digest("hex")}`;
  const cached = highlights.get(key);
  if (cached) return cached;
  const tokens: CodeToken[] = [];
  let offset = 0;
  const visit = (node: SyntaxNode, inherited = "") => {
    if (node.type === "text") {
      const previous = tokens.at(-1);
      if (previous?.classes === inherited) {
        previous.value += node.value;
        previous.end += node.value.length;
      } else tokens.push({ start: offset, end: offset + node.value.length, value: node.value, classes: inherited });
      offset += node.value.length;
    } else if (node.type === "element") {
      const classes = [
        inherited,
        ...(Array.isArray(node.properties.className)
          ? node.properties.className.filter((value) => typeof value === "string")
          : []),
      ]
        .filter(Boolean)
        .join(" ");
      for (const child of node.children) visit(child, classes);
    }
  };
  for (const child of syntax.highlight(language, source).children) visit(child);
  // Highlighting is presentation only; a grammar must never change the file being inspected.
  const result = tokens.map((token) => token.value).join("") === source ? tokens : plain;
  highlights.set(
    key,
    result,
    key.length * 2 + result.reduce((size, token) => size + 72 + 2 * (token.value.length + token.classes.length), 0),
  );
  return result;
}

export function codeRange(tokens: readonly CodeToken[], start: number, length: number): ComponentChildren {
  const end = start + length;
  let first = 0,
    last = tokens.length;
  while (first < last) {
    const middle = (first + last) >>> 1;
    if ((tokens[middle]?.end ?? Infinity) <= start) first = middle + 1;
    else last = middle;
  }
  const result: ComponentChildren[] = [];
  for (let index = first; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token || token.start >= end) break;
    const value = token.value.slice(Math.max(0, start - token.start), Math.min(token.value.length, end - token.start));
    result.push(token.classes ? <span class={token.classes}>{value}</span> : value);
  }
  return result;
}
