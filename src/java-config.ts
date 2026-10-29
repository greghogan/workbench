import { SaxesParser } from "saxes";
import { join } from "node:path";
import { readText } from "./files.js";

/** Temurin pins retain the security update, optional patch, and upstream build number. */
export function exactJavaVersion(value: unknown, source: string): string {
  if (typeof value !== "string" || !/^\d+(?:\.\d+\.\d+(?:\.\d+)?)?\+\d+$/.test(value))
    throw new Error(`${source}: expected an exact Java release and build, such as 25.0.4.1+1`);
  return value;
}

/** Planning reads literal root properties; inherited or interpolated targets require a local adapter. */
export function javaSupport(directory: string): { release: number; minimum: string } {
  const path = join(directory, "pom.xml");
  const parser = new SaxesParser({ xmlns: true });
  const stack: string[] = [];
  const properties = new Map<string, string[]>();
  let propertyCount = 0;
  let text = "";
  parser.on("opentag", (tag) => {
    stack.push(tag.local);
    if (stack.join("/") === "project/properties" && ++propertyCount > 1)
      throw new Error(`${path}: declare one root properties element`);
    if (stack.length === 3) text = "";
    if (stack.length > 3 && stack.slice(0, 2).join("/") === "project/properties")
      throw new Error(`${path}: declare literal root properties`);
  });
  const collect = (value: string) => {
    if (stack.length === 3 && stack.slice(0, 2).join("/") === "project/properties") text += value;
  };
  parser.on("text", collect);
  parser.on("cdata", collect);
  parser.on("closetag", () => {
    if (stack.length === 3 && stack.slice(0, 2).join("/") === "project/properties") {
      const name = stack[2];
      if (name) properties.set(name, [...(properties.get(name) ?? []), text.trim()]);
    }
    stack.pop();
  });
  parser.on("doctype", () => {
    throw new Error(`${path}: document types are not supported`);
  });
  parser.write(readText(path)).close();
  const property = (name: string) => {
    const values = properties.get(name);
    if (values?.length !== 1 || !values[0]) throw new Error(`${path}: declare one literal ${name} property`);
    return values[0];
  };
  const target = property("maven.compiler.release");
  if (!/^[1-9][0-9]*$/.test(target)) throw new Error(`${path}: Java release must be a literal integer at least 17`);
  const release = Number(target);
  const minimum = exactJavaVersion(property("java.minimum"), path);
  if (!Number.isSafeInteger(release) || release < 17 || Number(minimum.split(/[.+]/)[0]) !== release)
    throw new Error(`${path}: Java release must be at least 17 and agree with java.minimum`);
  return { release, minimum };
}
