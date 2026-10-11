import { required } from "./invariants.js";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readConfig, readProjects, readText, rootOf } from "./core.js";
import { splitFrontmatter } from "./record-document.js";
import { decisionScopes } from "./decisions.js";
import { collectionLink } from "./collection-links.js";

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

function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function anchors(contents: string): Set<string> {
  const found = new Set<string>();
  const counts = new Map<string, number>();
  let fence: string | undefined;
  for (const line of (splitFrontmatter(contents)?.body ?? contents).split(/\r?\n/)) {
    const marker = line.trimStart().startsWith("```") ? "`" : line.trimStart().startsWith("~~~") ? "~" : undefined;
    if (marker) {
      fence = fence === marker ? undefined : (fence ?? marker);
      continue;
    }
    if (fence) continue;
    const heading = /^#+\s+(.+)$/.exec(line)?.[1];
    if (!heading) continue;
    const base = heading
      .trim()
      .replace(/#+$/, "")
      .trim()
      .toLowerCase()
      .replace(/`/g, "")
      .replace(/[^\p{L}\p{N}_\s-]/gu, "")
      .replace(/\s+/g, "-")
      .replace(/^-|-$/g, "");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    found.add(count ? `${base}-${String(count)}` : base);
  }
  return found;
}

function linkErrors(root: string, markdownFiles: string[]): string[] {
  const errors: string[] = [];
  const exported = new Set(
    decisionScopes(root)
      .filter((scope) => !!scope.source)
      .flatMap((scope) => {
        const identity = required(scope.source, "collection source identity");
        const paths = [
          join(scope.directory, "workbench/decision-map.md"),
          ...scope.decisions.map((decision) => decision.path),
        ];
        return paths.flatMap((path) => [
          resolve(path),
          resolve(
            collectionLink(root, identity.id, identity.revision),
            scope.project.path,
            relative(scope.directory, path),
          ),
        ]);
      }),
  );
  const cache = new Map<string, Set<string>>();
  for (const source of markdownFiles) {
    const contents = readText(source);
    for (const match of contents.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]?.trim().replace(/^<|>$/g, "");
      if (!target || target.includes("://") || /^(mailto|data):/.test(target)) continue;
      const [pathText, fragment] = target.split("#", 2);
      const candidate = pathText ? resolve(dirname(source), pathText.replaceAll("%20", " ")) : source;
      const label = relative(root, source);
      if (!within(root, candidate) && !exported.has(candidate)) {
        errors.push(`${label}: link escapes the project: '${target}'`);
        continue;
      }
      if (!existsSync(candidate) || !lstatSync(candidate).isFile()) {
        errors.push(`${label}: missing link target '${target}'`);
        continue;
      }
      if (fragment && extname(candidate).toLowerCase() === ".md") {
        if (!cache.has(candidate)) cache.set(candidate, anchors(readText(candidate)));
        if (
          !required(cache.get(candidate), "expected cache.get(candidate)").has(
            fragment.replaceAll("%20", " ").toLowerCase(),
          )
        ) {
          errors.push(`${label}: missing Markdown anchor '${target}'`);
        }
      }
    }
  }
  return errors;
}

function safePath(value: string): boolean {
  return !!value && !isAbsolute(value) && !value.split(/[\\/]/).some((part) => part === "..");
}

function sourceFiles(path: string, errors: string[]): string[] {
  if (!existsSync(path)) {
    errors.push(`${path}: configured source path is missing`);
    return [];
  }
  const kind = lstatSync(path);
  if (kind.isSymbolicLink()) {
    errors.push(`${path}: configured source path is a symlink`);
    return [];
  }
  if (kind.isFile()) return [path];
  if (!kind.isDirectory()) {
    errors.push(`${path}: unsupported source path`);
    return [];
  }
  if (generated.has(basename(path))) return [];
  return readdirSync(path)
    .filter((entry) => !generated.has(entry))
    .flatMap((entry) => sourceFiles(join(path, entry), errors));
}

function sourceMapErrors(root: string, map: string, sources: string[]): string[] {
  const path = join(root, map);
  if (!existsSync(path)) return [`${path}: configured source map is missing`];
  const entries: string[] = [];
  let inEntry = false;
  for (const line of readText(path).split(/\r?\n/)) {
    if (line.trimStart().startsWith("- ")) inEntry = true;
    else if (!/^\s+\S/.test(line)) inEntry = false;
    if (!inEntry) continue;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      if (match[1] && safePath(match[1])) entries.push(match[1]);
    }
  }
  const errors: string[] = [];
  for (const entry of entries) {
    if (!existsSync(join(root, entry))) errors.push(`${path}: source map references missing path '${entry}'`);
  }
  for (const source of sources) {
    for (const file of sourceFiles(join(root, source), errors)) {
      const fileRelative = relative(root, file).split(sep).join("/");
      if (
        !entries.some(
          (entry) =>
            fileRelative === entry ||
            (existsSync(join(root, entry)) &&
              lstatSync(join(root, entry)).isDirectory() &&
              fileRelative.startsWith(`${entry}/`)),
        )
      ) {
        errors.push(`${path}: source map does not cover '${fileRelative}'`);
      }
    }
  }
  return errors;
}

export function documentationErrors(root: string, markdownFiles: string[]): string[] {
  const errors = linkErrors(root, markdownFiles);
  const config = readConfig(root) as {
    documentation?: { project?: string; source_map?: string; source_paths?: string[] }[];
  };
  const projects = readProjects(root);
  const seen = new Set<string>();
  for (const section of config.documentation ?? []) {
    const id = section.project ?? projects[0]?.id;
    const project = projects.find((candidate) => candidate.id === id);
    if (!project) {
      errors.push(`documentation names unknown project '${String(id)}'`);
      continue;
    }
    if (seen.has(project.id)) {
      errors.push(`project '${project.id}' has more than one documentation entry`);
      continue;
    }
    seen.add(project.id);
    if (
      !section.source_map ||
      !safePath(section.source_map) ||
      !Array.isArray(section.source_paths) ||
      !section.source_paths.length ||
      section.source_paths.some((source) => !safePath(source))
    ) {
      errors.push("documentation source map or source paths are invalid");
      continue;
    }
    errors.push(...sourceMapErrors(rootOf(root, project), section.source_map, section.source_paths));
  }
  return errors;
}
