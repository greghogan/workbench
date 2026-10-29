import { isDeepStrictEqual } from "node:util";
import { parse, stringify, type TomlTable, type TomlValue } from "smol-toml";
import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";
import { required } from "./invariants.js";

type Path = (string | number)[];
interface Edit {
  start: number;
  end: number;
  text: string;
}
const identity = (path: Path): string => JSON.stringify(path);
const beneath = (whole: Path, parent: Path): boolean => parent.every((part, index) => whole[index] === part);
const syntax = (text: string): AST.TOMLProgram => parseTOML(text, { tomlVersion: "1.1.0" });
const newline = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");
const tableValue = (value: TomlValue | undefined): value is TomlTable =>
  value !== undefined && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
const keyText = (path: Path): string =>
  path
    .map((part) => {
      if (typeof part !== "string") throw new Error("Cannot insert a TOML array item outside its parent table");
      return /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part);
    })
    .join(".");

/** Serialize only newly inserted values; existing spelling remains owned by the document. */
function valueText(value: TomlValue): string {
  if (Array.isArray(value)) return `[${value.map(valueText).join(", ")}]`;
  if (tableValue(value))
    return `{${Object.entries(value)
      .map(([key, entry]) => `${keyText([key])} = ${valueText(entry)}`)
      .join(", ")}}`;
  const serialized = stringify({ value });
  const entry = syntax(serialized).body[0].body[0];
  if (entry?.type !== "TOMLKeyValue") throw new Error("Cannot serialize TOML value");
  return serialized.slice(...entry.value.range);
}

/** Newly created sections use readable table syntax; existing sections keep their layout. */
function sectionText(path: Path, value: TomlTable | TomlTable[], eol: string): string {
  const rows = Array.isArray(value) ? value : [value];
  return rows
    .map((row) => {
      const header = keyText(path);
      let result = (Array.isArray(value) ? `[[${header}]]` : `[${header}]`) + eol;
      const nested: [string, TomlTable | TomlTable[]][] = [];
      for (const [key, item] of Object.entries(row)) {
        if (tableValue(item) || (Array.isArray(item) && item.length && item.every(tableValue)))
          nested.push([key, item]);
        else result += `${keyText([key])} = ${valueText(item)}${eol}`;
      }
      for (const [key, item] of nested) result += eol + sectionText([...path, key], item, eol);
      return result;
    })
    .join(eol);
}

function indexDocument(text: string) {
  const ast = syntax(text);
  const values = new Map<string, AST.TOMLContentNode>();
  const entries = new Map<string, { path: Path; node: AST.TOMLKeyValue }>();
  const tables = new Map<string, AST.TOMLTable>();
  function visitValue(node: AST.TOMLContentNode, path: Path): void {
    values.set(identity(path), node);
    if (node.type === "TOMLArray")
      node.elements.forEach((entry, index) => {
        visitValue(entry, [...path, index]);
      });
    if (node.type === "TOMLInlineTable")
      node.body.forEach((entry) => {
        visitEntry(entry, path);
      });
  }
  function visitEntry(node: AST.TOMLKeyValue, base: Path): void {
    const path = [...base, ...getStaticTOMLValue(node.key)];
    entries.set(identity(path), { path, node });
    visitValue(node.value, path);
  }
  for (const node of ast.body[0].body) {
    if (node.type === "TOMLTable") {
      tables.set(identity(node.resolvedKey), node);
      for (const entry of node.body) visitEntry(entry, node.resolvedKey);
    } else visitEntry(node, []);
  }
  return { ast, values, entries, tables };
}

function apply(text: string, edits: Edit[]): string {
  let end = text.length;
  let result = text;
  // Reverse equal-position insertions so their caller-declared order is retained.
  for (const edit of edits
    .map((edit, order) => ({ ...edit, order }))
    .sort((a, b) => b.start - a.start || b.end - a.end || b.order - a.order)) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > end) throw new Error("Overlapping TOML edits");
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    end = edit.start;
  }
  return result;
}

function afterLine(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end === -1 ? text.length : end + 1;
}

function insertLine(text: string, offset: number, line: string): string {
  const eol = newline(text);
  return apply(text, [
    { start: offset, end: offset, text: (offset && text[offset - 1] !== "\n" ? eol : "") + line + eol },
  ]);
}

function replaceValue(text: string, ast: AST.TOMLProgram, node: AST.TOMLContentNode, value: TomlValue): string {
  const edits: Edit[] = [{ start: node.range[0], end: node.range[1], text: valueText(value) }];
  const comments = ast.comments.filter(
    (comment) => comment.range[0] >= node.range[0] && comment.range[1] <= node.range[1],
  );
  if (comments.length) {
    // A change of container type can remove comment locations. Retain those comments
    // as separate lines immediately before the enclosing declaration.
    let declaration: AST.TOMLNode = node;
    while (!["TOMLTable", "TOMLTopLevelTable"].includes(declaration.parent.type)) declaration = declaration.parent;
    const offset = text.lastIndexOf("\n", declaration.range[0] - 1) + 1;
    edits.push({
      start: offset,
      end: offset,
      text: comments.map((comment) => text.slice(...comment.range) + newline(text)).join(""),
    });
  }
  return apply(text, edits);
}

function setValue(text: string, path: Path, value: TomlValue): string {
  const { ast, values, entries, tables } = indexDocument(text);
  const existing = values.get(identity(path));
  if (existing) return replaceValue(text, ast, existing, value);
  for (let size = path.length - 1; size >= 0; size--) {
    const base = path.slice(0, size);
    const container = values.get(identity(base));
    if (container?.type === "TOMLInlineTable") {
      const end = container.range[1] - 1;
      const last = container.body.at(-1);
      const edits: Edit[] = [];
      if (
        last &&
        !ast.tokens.some((token) => token.value === "," && token.range[0] >= last.range[1] && token.range[1] < end)
      )
        edits.push({ start: last.range[1], end: last.range[1], text: "," });
      edits.push({ start: end, end, text: ` ${keyText(path.slice(size))} = ${valueText(value)}` });
      return apply(text, edits);
    }
    const table = tables.get(identity(base));
    if (table)
      return insertLine(text, afterLine(text, table.range[1]), `${keyText(path.slice(size))} = ${valueText(value)}`);
  }
  if (tableValue(value) || (Array.isArray(value) && value.length && value.every(tableValue))) {
    const eol = newline(text);
    return text + (text && !text.endsWith("\n") ? eol : "") + sectionText(path, value, eol);
  }
  // Dotted declarations also work when a parent is implicit, without redefining it.
  const firstTable = ast.body[0].body.find((node) => node.type === "TOMLTable");
  const last = [...entries.values()].filter(({ node }) => node.parent.type === "TOMLTopLevelTable").at(-1)?.node;
  const offset = last
    ? afterLine(text, last.range[1])
    : firstTable
      ? text.lastIndexOf("\n", firstTable.range[0] - 1) + 1
      : text.length;
  return insertLine(text, offset, `${keyText(path)} = ${valueText(value)}`);
}

function removeValue(text: string, path: Path): string {
  const { ast, entries, values, tables } = indexDocument(text);
  const entry = entries.get(identity(path))?.node;
  const value = values.get(identity(path));
  if (!entry && !value && ![...tables.values()].some((table) => beneath(table.resolvedKey, path))) {
    const descendants = [...entries.values()].filter((item) => beneath(item.path, path));
    if (descendants.some(({ node }) => node.parent.type === "TOMLInlineTable")) {
      for (const item of descendants.sort((a, b) => a.path.length - b.path.length)) text = removeValue(text, item.path);
      return text;
    }
  }
  const ranges: AST.Range[] = [];
  let siblings: AST.TOMLNode[] = [];
  let selected: AST.TOMLNode | undefined;
  if (entry) {
    ranges.push(entry.range);
    if (entry.parent.type === "TOMLInlineTable") {
      siblings = entry.parent.body;
      selected = entry;
    }
  } else if (value?.parent.type === "TOMLArray") {
    ranges.push(value.range);
    siblings = value.parent.elements;
    selected = value;
  } else {
    for (const table of tables.values()) if (beneath(table.resolvedKey, path)) ranges.push(table.range);
    for (const item of entries.values()) if (beneath(item.path, path)) ranges.push(item.node.range);
  }
  // Tokens contain syntax, not comments or whitespace. Deleting only tokens keeps
  // comments even inside a deleted array, inline table, or whole section.
  const tokens = ast.tokens.filter((token) =>
    ranges.some(([start, end]) => token.range[0] >= start && token.range[1] <= end),
  );
  if (selected) {
    const index = siblings.indexOf(selected);
    const following = ast.tokens.find(
      (token) =>
        token.value === "," &&
        token.range[0] >= selected.range[1] &&
        token.range[1] <= (siblings[index + 1]?.range[0] ?? selected.parent?.range[1] ?? selected.range[1]),
    );
    const preceding =
      index > 0
        ? [...ast.tokens]
            .reverse()
            .find(
              (token) =>
                token.value === "," &&
                token.range[0] >= (siblings[index - 1]?.range[1] ?? 0) &&
                token.range[1] <= selected.range[0],
            )
        : undefined;
    const comma = following ?? preceding;
    if (comma) tokens.push(comma);
  }
  return apply(
    text,
    tokens.map((token) => ({ start: token.range[0], end: token.range[1], text: "" })),
  );
}

function appendArray(text: string, path: Path, value: TomlValue): string {
  const { ast, values } = indexDocument(text);
  const array = values.get(identity(path));
  if (array?.type !== "TOMLArray") throw new Error("Cannot append to a missing TOML array");
  const last = array.elements.at(-1);
  const edits: Edit[] = [];
  const end = array.range[1] - 1;
  if (
    last &&
    !ast.tokens.some((token) => token.value === "," && token.range[0] >= last.range[1] && token.range[1] < end)
  )
    edits.push({ start: last.range[1], end: last.range[1], text: "," });
  edits.push({ start: end, end, text: ` ${valueText(value)}` });
  return apply(text, edits);
}

function appendTable(text: string, path: Path, value: TomlTable): string {
  const eol = newline(text);
  const block =
    `[[${keyText(path.filter((part) => typeof part === "string"))}]]${eol}` +
    Object.entries(value)
      .map(([key, item]) => `${keyText([key])} = ${valueText(item)}${eol}`)
      .join("");
  const parentIndex = path.map((part) => typeof part === "number").lastIndexOf(true);
  const parent = parentIndex >= 0 ? path.slice(0, parentIndex + 1) : [];
  const last = [...indexDocument(text).tables.values()].filter((table) => beneath(table.resolvedKey, parent)).at(-1);
  const offset = parent.length && last ? afterLine(text, last.range[1]) : text.length;
  return apply(text, [{ start: offset, end: offset, text: (offset && text[offset - 1] !== "\n" ? eol : "") + block }]);
}

function at(document: TomlTable, path: Path): TomlValue | undefined {
  let value: TomlValue | undefined = document;
  for (const key of path)
    value =
      Array.isArray(value) && typeof key === "number"
        ? value[key]
        : tableValue(value) && typeof key === "string"
          ? value[key]
          : undefined;
  return value;
}

function identifiedRows(value: TomlValue[]): value is (TomlTable & { id: string })[] {
  return (
    value.every((row) => tableValue(row) && typeof row.id === "string") &&
    new Set(value.map((row) => (tableValue(row) ? row.id : undefined))).size === value.length
  );
}

/** Adjacent full-line comments describe the following row; a blank line separates a free-standing comment. */
function leadingComments(text: string, position: number): number {
  let start = text.lastIndexOf("\n", position - 1) + 1;
  if (text.slice(start, position).trim()) return position;
  while (start > 0) {
    const previous = text.lastIndexOf("\n", start - 2) + 1;
    if (!text.slice(previous, start).trimStart().startsWith("#")) break;
    start = previous;
  }
  return start;
}

function reorderTables(text: string, path: Path, ids: string[]): string {
  const { tables, values } = indexDocument(text);
  const current = at(parse(text), path);
  if (!Array.isArray(current) || !identifiedRows(current))
    throw new Error("TOML table reconciliation requires distinct identities");
  if (current.every((row, index) => row.id === ids[index])) return text;
  const array = values.get(identity(path));
  if (array?.type === "TOMLArray")
    return apply(
      text,
      array.elements.map((node, index) => {
        const incoming = required(
          array.elements[current.findIndex((row) => row.id === ids[index])],
          "Missing TOML array identity",
        );
        return {
          start: leadingComments(text, node.range[0]),
          end: node.range[1],
          text: text.slice(leadingComments(text, incoming.range[0]), incoming.range[1]),
        };
      }),
    );
  const blocks = current.map((row, index) => {
    const fragments = [...tables.values()]
      .filter((table) => beneath(table.resolvedKey, [...path, index]))
      .map((table) => ({ start: leadingComments(text, table.range[0]), end: afterLine(text, table.range[1]) }));
    return { id: row.id, fragments, text: fragments.map(({ start, end }) => text.slice(start, end)).join("") };
  });
  return apply(
    text,
    blocks.flatMap((block, index) => {
      const replacement = required(
        blocks.find((candidate) => candidate.id === ids[index]),
        "Missing TOML table identity",
      ).text;
      return block.fragments.map((fragment, position) => ({
        ...fragment,
        text: position ? "" : replacement + (replacement.endsWith("\n") ? "" : newline(text)),
      }));
    }),
  );
}

function equalValue(a: TomlValue | undefined, b: TomlValue | undefined): boolean {
  if (a instanceof Date && b instanceof Date) return a.toISOString() === b.toISOString();
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => equalValue(value, b[index]));
  if (tableValue(a) && tableValue(b))
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => Object.hasOwn(b, key) && equalValue(a[key], b[key]))
    );
  return Object.is(a, b);
}

function patch(text: string, path: Path, desired: TomlValue): string {
  const current = at(parse(text), path);
  if (equalValue(current, desired)) return text;
  if (Array.isArray(current) && Array.isArray(desired)) {
    const arrayTables = indexDocument(text).tables.has(identity([...path, 0]));
    if (arrayTables && !desired.every(tableValue)) return setValue(removeValue(text, path), path, desired);
    if (identifiedRows(current) && identifiedRows(desired) && current.length) {
      for (const old of current.filter((row) => !desired.some((next) => next.id === row.id))) {
        const rows = at(parse(text), path);
        if (!Array.isArray(rows) || !identifiedRows(rows)) throw new Error("Missing TOML table identity");
        text = removeValue(text, [...path, rows.findIndex((row) => row.id === old.id)]);
      }
      for (const next of desired) {
        const rows = at(parse(text), path);
        const index = Array.isArray(rows) && identifiedRows(rows) ? rows.findIndex((row) => row.id === next.id) : -1;
        text =
          index === -1
            ? arrayTables
              ? appendTable(text, path, next)
              : appendArray(text, path, next)
            : patch(text, [...path, index], next);
      }
      return desired.length
        ? reorderTables(
            text,
            path,
            desired.map((row) => row.id),
          )
        : arrayTables
          ? setValue(text, path, [])
          : text;
    }
    for (let index = 0; index < Math.min(current.length, desired.length); index++)
      text = patch(text, [...path, index], required(desired[index], "Missing TOML array value"));
    for (let index = current.length - 1; index >= desired.length; index--) text = removeValue(text, [...path, index]);
    for (let index = current.length; index < desired.length; index++) {
      const value = required(desired[index], "Missing TOML array value");
      if (arrayTables && tableValue(value)) text = appendTable(text, path, value);
      else text = appendArray(text, path, value);
    }
    return arrayTables && !desired.length ? setValue(text, path, []) : text;
  }
  if (tableValue(current) && tableValue(desired)) {
    for (const key of Object.keys(current)) if (!Object.hasOwn(desired, key)) text = removeValue(text, [...path, key]);
    for (const [key, value] of Object.entries(desired)) text = patch(text, [...path, key], value);
    // Deleting the final dotted child can remove an implicit parent entirely.
    return Object.keys(desired).length || tableValue(at(parse(text), path)) ? text : setValue(text, path, {});
  }
  if (current !== undefined && !indexDocument(text).values.has(identity(path))) text = removeValue(text, path);
  return setValue(text, path, desired);
}

/** Preserve existing TOML trivia while applying a validated document update. */
export function editToml(source: string, document: object): string {
  // Normalize through the existing semantic serializer, including omitted undefined values.
  const desired = parse(stringify(document));
  const result = patch(source, [], desired);
  if (!equalValue(parse(result), desired)) throw new Error("TOML edit changed data outside the requested update");
  const comments = (text: string) =>
    syntax(text)
      .comments.map((comment) => text.slice(...comment.range))
      .sort();
  if (!isDeepStrictEqual(comments(source), comments(result)))
    throw new Error("TOML edit did not preserve every comment");
  return result;
}
