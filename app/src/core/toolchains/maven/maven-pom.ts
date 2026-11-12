import { SaxesParser } from "saxes";

export interface PomElement {
  name: string;
  qualifiedName: string;
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  selfClosing: boolean;
  namespaces: Record<string, string>;
  declared: Set<string>;
  text: string;
  children: PomElement[];
}
export function pomChild(node: PomElement, name: string): PomElement | undefined {
  const matches = node.children.filter((entry) => entry.name === name);
  if (matches.length > 1) throw new Error(`Duplicate Maven ${name} element`);
  return matches[0];
}
export const pomXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Syntax ranges come from the XML parser; authoritative POMs are never rewritten. */
export function pomDocument(text: string): PomElement {
  const stack: PomElement[] = [];
  let root: PomElement | undefined;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => {
    throw new Error("Maven POMs do not accept document types");
  });
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1),
      namespaces = { ...parent?.namespaces },
      declared = new Set<string>();
    for (const attribute of Object.values(tag.attributes))
      if (attribute.name === "xmlns" || attribute.prefix === "xmlns") {
        const prefix = attribute.name === "xmlns" ? "" : attribute.local;
        namespaces[prefix] = attribute.value;
        declared.add(prefix);
      }
    const node: PomElement = {
      name: tag.local,
      qualifiedName: tag.name,
      start: text.lastIndexOf("<", parser.position - 1),
      openEnd: parser.position,
      closeStart: parser.position,
      end: parser.position,
      selfClosing: tag.isSelfClosing,
      namespaces,
      declared,
      text: "",
      children: [],
    };
    if (parent) parent.children.push(node);
    else root = node;
    stack.push(node);
  });
  const append = (value: string) => {
    const node = stack.at(-1);
    if (node) node.text += value;
  };
  parser.on("text", append);
  parser.on("cdata", append);
  parser.on("closetag", () => {
    const node = stack.pop();
    if (node) {
      node.closeStart = node.selfClosing ? node.start : text.lastIndexOf("<", parser.position - 1);
      node.end = parser.position;
    }
  });
  parser.write(text).close();
  if (root?.name !== "project") throw new Error("Maven requires a project POM");
  return root;
}

/** Only Maven model elements constrain acquisition; plugin configuration and arbitrary properties are opaque. */
export function assertStandalonePom(root: PomElement): void {
  const inspect = (node: PomElement, path: string) => {
    if (node.name === "configuration" || node.name === "properties") return;
    if (
      path === "project/parent" ||
      /^project\/(?:profiles\/profile\/)?modules$/.test(path) ||
      /^project\/(?:profiles\/profile\/)?build\/(?:extensions|(?:pluginManagement\/)?plugins\/plugin\/extensions)$/.test(
        path,
      ) ||
      path.endsWith("/dependencies/dependency/systemPath")
    )
      throw new Error(`Maven requires standalone POMs without ${node.name}: ${path}`);
    for (const entry of node.children) inspect(entry, `${path}/${entry.name}`);
  };
  inspect(root, "project");
}

export function pomContents(text: string, node: PomElement, contents: string): string {
  if (node.selfClosing) return text.slice(node.start, node.openEnd - 2) + ">" + contents + `</${node.qualifiedName}>`;
  return text.slice(node.start, node.openEnd) + contents + text.slice(node.closeStart, node.end);
}
