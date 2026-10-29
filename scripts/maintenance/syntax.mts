import { parseDocument, isScalar, isMap, isSeq } from "yaml";
import { SaxesParser } from "saxes";
import { required } from "../values.mjs";

export interface TokenEdit {
  start: number;
  end: number;
  value: string;
}
export function editTokens(source: string, edits: TokenEdit[]): string {
  const unique = new Map<string, TokenEdit>();
  for (const edit of edits) {
    const key = `${String(edit.start)}:${String(edit.end)}`;
    if (unique.has(key) && unique.get(key)?.value !== edit.value) throw new Error("Conflicting version edits");
    unique.set(key, edit);
  }
  let boundary = source.length;
  for (const edit of [...unique.values()].sort((a, b) => b.start - a.start)) {
    if (edit.start < 0 || edit.end > boundary || edit.end < edit.start) throw new Error("Overlapping version edits");
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
    boundary = edit.start;
  }
  return source;
}
export function editJsonFields(source: string, changes: { path: string[]; value: string }[]): string {
  JSON.parse(source); // JSON syntax remains stricter than the YAML parser used for source ranges.
  const document = parseDocument(source);
  if (document.errors.length) throw new Error("Invalid or ambiguous JSON manifest", { cause: document.errors[0] });
  return editTokens(
    source,
    changes.map(({ path, value }) => {
      const node = document.getIn(path, true);
      if (!isScalar(node) || typeof node.value !== "string" || !node.range)
        throw new Error(`Missing string field: ${path.join(".")}`);
      return { start: node.range[0], end: node.range[1], value: JSON.stringify(value) };
    }),
  );
}
interface XmlNode {
  name: string;
  start: number;
  end: number;
  parent?: XmlNode;
  children: XmlNode[];
}
export function mavenVersions(
  source: string,
): { name: string; current: string; property?: string; start: number; end: number }[] {
  const parser = new SaxesParser();
  const stack: XmlNode[] = [],
    nodes: XmlNode[] = [];
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    const node: XmlNode = {
      name: required(tag.name.split(":").at(-1), "Missing XML name"),
      start: parser.position,
      end: parser.position,
      children: [],
      ...(parent ? { parent } : {}),
    };
    parent?.children.push(node);
    nodes.push(node);
    stack.push(node);
  });
  parser.on("closetag", () => {
    const node = required(stack.pop(), "Unbalanced XML");
    node.end = source.lastIndexOf("</", parser.position - 1);
  });
  parser.write(source).close();
  const text = (node: XmlNode | undefined) => (node ? source.slice(node.start, node.end).trim() : undefined);
  const properties = nodes.filter((node) => node.parent?.name === "properties");
  const token = (name: string, node: XmlNode, property?: string) => {
    const raw = source.slice(node.start, node.end),
      current = raw.trim();
    if (!current || /[<>&]/.test(current)) throw new Error(`Unsupported version token: ${name}`);
    const start = node.start + raw.indexOf(current);
    return { name, current, start, end: start + current.length, ...(property ? { property } : {}) };
  };
  const result = [];
  const formatter = properties.find((node) => node.name === "google-java-format.version");
  if (formatter) result.push(token("com.google.googlejavaformat:google-java-format", formatter, formatter.name));
  for (const node of nodes.filter((node) => node.name === "dependency" || node.name === "plugin")) {
    const child = (name: string) => node.children.find((entry) => entry.name === name);
    const group = text(child("groupId")),
      artifact = text(child("artifactId")),
      version = child("version");
    if (!group || !artifact || !version) continue;
    const property = /^\$\{([^}]+)\}$/.exec(text(version) ?? "")?.[1];
    const target = property ? properties.find((entry) => entry.name === property) : version;
    if (target) result.push(token(`${group}:${artifact}`, target, property));
  }
  return result;
}
export function dockerBases(source: string) {
  return [
    ...source.matchAll(/^[ \t]*FROM[ \t]+(?:--platform=\S+[ \t]+)?([^\s@]+)@(sha256:[a-f0-9]{64})(?=[ \t\r\n]|$)/gm),
  ].map((match) => ({
    name: required(match[1], "Missing image name"),
    digest: required(match[2], "Missing image digest"),
    start: match.index + match[0].lastIndexOf(`${required(match[1], "Missing image name")}@`),
    end: match.index + match[0].length,
  }));
}

export function actionPins(source: string, strict = false) {
  const document = parseDocument(source);
  if (document.errors.length) throw new Error("Invalid action workflow", { cause: document.errors[0] });
  const pins: {
    name: string;
    component: string;
    revision: string;
    version: string;
    start: number;
    end: number;
    versionStart: number;
    versionEnd: number;
  }[] = [];
  const visit = (node: unknown, path: string[] = []) => {
    if (isSeq(node)) for (const [index, item] of node.items.entries()) visit(item, [...path, String(index)]);
    if (isMap(node))
      for (const pair of node.items) {
        if (
          (path.at(-2) === "steps" || (path.length === 2 && path[0] === "jobs")) &&
          isScalar(pair.key) &&
          pair.key.value === "uses" &&
          isScalar(pair.value) &&
          typeof pair.value.value === "string" &&
          pair.value.range
        ) {
          const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)((?:\/[A-Za-z0-9_.-]+)*)@([a-f0-9]{40})$/.exec(
            pair.value.value,
          );
          if (
            strict &&
            !match &&
            !pair.value.value.startsWith("./") &&
            !/^docker:\/\/.+@sha256:[a-f0-9]{64}$/.test(pair.value.value)
          )
            throw new Error("External workflow components require immutable commit or image identities");
          const [start, end] = pair.value.range;
          const lineEnd = source.indexOf("\n", end);
          const comment = source.slice(end, lineEnd < 0 ? undefined : lineEnd);
          const version = /^[ \t]*#[ \t]*v?(\d+(?:\.\d+)+)/.exec(comment);
          if (strict && match && !version?.[1])
            throw new Error("Pinned workflow actions require version comments for maintenance discovery");
          if (match?.[1] && match[3] && version?.[1]) {
            const versionStart = end + version[0].lastIndexOf(version[1]);
            pins.push({
              name: match[1],
              component: `${match[1]}${match[2] ?? ""}`,
              revision: match[3],
              version: version[1],
              start,
              end,
              versionStart,
              versionEnd: versionStart + version[1].length,
            });
          }
        }
        visit(pair.value, [...path, isScalar(pair.key) ? String(pair.key.value) : ""]);
      }
  };
  visit(document.contents);
  return pins;
}

export function goModules(source: string) {
  return [...source.matchAll(/^[ \t]*(?:require[ \t]+)?(?!\/\/)([^\s]+\.[^\s]+)[ \t]+(v[^\s]+)(?=[ \t\r\n]|$)/gm)].map(
    (match) => {
      const name = required(match[1], "Missing Go module"),
        current = required(match[2], "Missing Go version");
      const start = match.index + match[0].lastIndexOf(current);
      return { name, current, start, end: start + current.length };
    },
  );
}

/** Locate the single literal pin in the owned channel format, retaining line and nested block comments. */
export function guixCommit(source: string) {
  const clean = source.split("");
  let quoted = false,
    escaped = false,
    line = false,
    blocks = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (line) {
      if (char === "\n") line = false;
      else clean[index] = " ";
      continue;
    }
    if (blocks) {
      if (source.startsWith("#|", index)) {
        blocks++;
        clean[index] = " ";
        clean[++index] = " ";
      } else if (source.startsWith("|#", index)) {
        blocks--;
        clean[index] = " ";
        clean[++index] = " ";
      } else if (char !== "\n" && char !== "\r") clean[index] = " ";
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ";") {
      line = true;
      clean[index] = " ";
    } else if (source.startsWith("#|", index)) {
      blocks++;
      clean[index] = " ";
      clean[++index] = " ";
    } else if (source.startsWith("#;", index)) throw new Error("Guix datum comments require explicit pin review");
  }
  if (quoted || blocks) throw new Error("Unterminated Guix string or comment");
  const pins = [...clean.join("").matchAll(/\(commit\s+"([a-f0-9]{40})"\)/g)];
  if (pins.length !== 1)
    throw new Error(
      "Guix requires one unambiguous literal commit pin; review multiple or computed channels explicitly",
    );
  const pin = required(pins[0], "Missing Guix pin"),
    current = required(pin[1], "Missing Guix revision");
  const start = pin.index + pin[0].indexOf(current);
  return { current, start, end: start + current.length };
}
