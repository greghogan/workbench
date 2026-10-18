import { join } from "node:path";
import { readText } from "./core.js";

/** Temurin pins retain the security update, optional patch, and upstream build number. */
export function exactJavaVersion(value: unknown, source: string): string {
  if (typeof value !== "string" || !/^\d+(?:\.\d+\.\d+(?:\.\d+)?)?\+\d+$/.test(value))
    throw new Error(`${source}: expected an exact Java release and build, such as 25.0.4.1+1`);
  return value;
}

/** Planning reads literal root properties; inherited or interpolated targets require a local adapter. */
export function javaSupport(directory: string): { release: number; minimum: string } {
  const path = join(directory, "pom.xml");
  const xml = readText(path).replace(/<!--[\s\S]*?-->/g, "");
  const stack: string[] = [];
  let start: number | undefined;
  let properties: string | undefined;
  for (const tag of xml.matchAll(/<\/?([\w.:-]+)\b[^>]*>/g)) {
    const name = tag[1];
    if (!name) throw new Error(`${path}: missing XML element name`);
    if (tag[0].startsWith("</")) {
      if (name === "properties" && stack.join("/") === "project/properties" && start !== undefined) {
        if (properties !== undefined) throw new Error(`${path}: declare one root properties element`);
        properties = xml.slice(start, tag.index);
      }
      if (stack.pop() !== name) throw new Error(`${path}: mismatched XML elements`);
    } else if (!tag[0].endsWith("/>")) {
      stack.push(name);
      if (stack.join("/") === "project/properties") start = tag.index + tag[0].length;
    }
  }
  if (stack.length) throw new Error(`${path}: unclosed XML elements`);
  const property = (name: string) => {
    const matches = [
      ...(properties ?? "").matchAll(
        new RegExp(`<${name.replaceAll(".", "\\.")}>\\s*([^<]+?)\\s*</${name.replaceAll(".", "\\.")}>`, "g"),
      ),
    ];
    if (matches.length !== 1 || !matches[0]?.[1]) throw new Error(`${path}: declare one literal ${name} property`);
    return matches[0][1];
  };
  const target = property("maven.compiler.release");
  if (!/^[1-9][0-9]*$/.test(target)) throw new Error(`${path}: Java release must be a literal integer at least 17`);
  const release = Number(target);
  const minimum = exactJavaVersion(property("java.minimum"), path);
  if (!Number.isSafeInteger(release) || release < 17 || Number(minimum.split(/[.+]/)[0]) !== release)
    throw new Error(`${path}: Java release must be at least 17 and agree with java.minimum`);
  return { release, minimum };
}
