import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { parse } from "smol-toml";
export function readText(path: string): string {
  return readFileSync(path, "utf8");
}
export function readToml(path: string): unknown {
  return parse(readText(path));
}
export function safeRelative(base: string, path: string): string {
  const value = relative(base, path);
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error(`${path}: outside ${base}`);
  return value;
}
