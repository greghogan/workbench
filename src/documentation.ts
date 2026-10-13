import { required } from "./invariants.js";
import { existsSync, lstatSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readConfig, readProjects, readText, rootOf } from "./core.js";
import { splitFrontmatter } from "./record-document.js";
import { decisionScopes } from "./decisions.js";
import { collectionLink } from "./collection-links.js";
import { sourceMapErrors } from "./source-maps.js";

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

export function documentationErrors(root: string, markdownFiles: string[]): string[] {
  const errors = linkErrors(root, markdownFiles);
  const config = readConfig(root) as {
    documentation?: { project?: string; source_map?: string; source_paths?: string[]; source_excludes?: string[] }[];
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
    errors.push(
      ...sourceMapErrors(rootOf(root, project), section.source_map, section.source_paths, section.source_excludes),
    );
  }
  return errors;
}
