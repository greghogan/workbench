import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readText } from "./core.js";
import { ownedPath, relativePath } from "./paths.js";
import { splitFrontmatter } from "./record-document.js";

const generated = new Set([
  ".git",
  ".mypy_cache",
  ".pnpm-store",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
  ".bundle",
  ".collections",
  ".local-collections",
  "target",
]);
const portable = (path: string) => path.split(sep).join("/");
const contains = (directory: string, path: string) =>
  directory === "." || path === directory || path.startsWith(`${directory}/`);

/** Paths are leading code spans in bullets or the first column of a table. */
function entries(contents: string): { value: string; link: boolean; line: number }[] {
  const result: { value: string; link: boolean; line: number }[] = [];
  let fence: string | undefined;
  let bullet = false;
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker.startsWith(fence)) fence = undefined;
      continue;
    }
    if (fence) continue;
    const start = /^\s*[-+*]\s+(.+)$/.exec(line)?.[1];
    const cell = /^\s*\|\s*([^|]+)\|/.exec(line)?.[1];
    let value = start ?? cell ?? (bullet && /^\s+\S/.test(line) ? line.trim() : "");
    bullet = start !== undefined || (bullet && /^\s+\S/.test(line));
    for (;;) {
      const code = /^`([^`]+)`/.exec(value);
      const link = /^\[[^\]]+\]\(([^)]+)\)/.exec(value);
      const match = code ?? link;
      if (!match?.[1]) break;
      result.push({ value: match[1], link: !code, line: index + 1 });
      const separator = /^(?:,\s*(?:and\s+)?|\s+and\s+)/.exec(value.slice(match[0].length));
      if (!separator) break;
      value = value.slice(match[0].length + separator[0].length).trimStart();
    }
  }
  return result;
}

/** Curated maps remain prose; checks validate their declared filesystem relationships. */
export function sourceMapErrors(root: string, map: string, sources: string[], exclusions: string[] = []): string[] {
  const errors: string[] = [];
  const mapped = new Map<string, { origin: string; directory: boolean }>();
  const visited = new Set<string>();
  const active = new Set<string>();
  const pathFor = (name: string, origin: string): string | undefined => {
    try {
      return ownedPath(root, name);
    } catch (error) {
      errors.push(`${origin}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  for (const name of [...sources, ...exclusions]) {
    try {
      relativePath(name, "source-map configuration", true);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length) return errors;
  const visit = (name: string) => {
    const path = pathFor(name, map);
    if (!path) return;
    if (active.has(name)) {
      errors.push(`${path}: source-map link cycle`);
      return;
    }
    if (visited.has(name)) return;
    visited.add(name);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      errors.push(`${path}: configured source map is missing or is not a file`);
      return;
    }
    active.add(name);
    const contents = readText(path);
    for (const entry of entries(splitFrontmatter(contents)?.body ?? contents)) {
      const origin = `${path}:${String(entry.line)}`;
      let source = entry.value;
      if (entry.link) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(source)) continue;
        const target = resolve(dirname(path), source.split("#")[0]?.replaceAll("%20", " ") ?? "");
        source = portable(relative(root, target));
        if (isAbsolute(source) || source === ".." || source.startsWith("../")) {
          errors.push(`${origin}: source-map link escapes the project: '${entry.value}'`);
          continue;
        }
        if (source.endsWith(".md")) {
          visit(source);
          continue;
        }
      }
      const target = pathFor(source, origin);
      if (!target) continue;
      if (!existsSync(target)) {
        errors.push(`${path}: source map references missing path '${source}'`);
        continue;
      }
      const metadata = lstatSync(target);
      if (!metadata.isFile() && !metadata.isDirectory()) {
        errors.push(`${origin}: unsupported source-map path '${source}'`);
        continue;
      }
      const previous = mapped.get(source);
      if (previous) errors.push(`${origin}: duplicate source-map entry '${source}' (first at ${previous.origin})`);
      else mapped.set(source, { origin, directory: metadata.isDirectory() });
    }
    active.delete(name);
  };
  visit(map);
  const examined = new Set<string>();
  const check = (name: string) => {
    if (exclusions.some((excluded) => contains(excluded, name)) || generated.has(basename(name))) return;
    if (examined.has(name)) return;
    examined.add(name);
    const path = pathFor(name, map);
    if (!path) return;
    if (!existsSync(path)) {
      errors.push(`${path}: configured source path is missing`);
      return;
    }
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      errors.push(`${path}: configured source path is a symlink`);
      return;
    }
    if (metadata.isDirectory()) {
      for (const child of readdirSync(path).sort()) check(name === "." ? child : `${name}/${child}`);
    } else if (!metadata.isFile()) errors.push(`${path}: unsupported source path`);
    else if (![...mapped].some(([entry, item]) => entry === name || (item.directory && contains(entry, name))))
      errors.push(`${join(root, map)}: source map does not cover '${name}'`);
  };
  for (const source of sources) check(source);
  return errors;
}
