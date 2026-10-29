import { required } from "./invariants.js";
import { existsSync, lstatSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { readConfig, readProjects } from "./project-configuration.js";
import { readText } from "./files.js";
import { rootOf } from "./project-context.js";
import { splitFrontmatter } from "./record-document.js";
import { decisionScopes } from "./decisions.js";
import { inspectCollection } from "./collections.js";
import { sourceMapErrors } from "./source-maps.js";
import { markdownLinks } from "./markdown-links.js";
import { ownedPath } from "./paths.js";

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
  // Staged snapshots retain local policy outside the project; allow only its verified files.
  const exported = new Set(
    decisionScopes(root)
      .filter((scope) => scope.local)
      .flatMap((scope) =>
        [...inspectCollection(scope.directory, scope.source).files.keys()].map((path) =>
          resolve(scope.directory, path),
        ),
      ),
  );
  const cache = new Map<string, Set<string>>();
  for (const source of markdownFiles) {
    const contents = readText(source);
    for (const target of markdownLinks(contents)) {
      if (!target || target.includes("://") || /^(mailto|data):/.test(target)) continue;
      const [pathText, fragment] = target.split("#", 2);
      const label = relative(root, source);
      let candidate: string, anchor: string | undefined;
      try {
        candidate = pathText ? resolve(dirname(source), decodeURIComponent(pathText.split("?")[0] ?? "")) : source;
        anchor = fragment === undefined ? undefined : decodeURIComponent(fragment).toLowerCase();
      } catch {
        errors.push(`${label}: invalid link encoding '${target}'`);
        continue;
      }
      if (!within(root, candidate) && !exported.has(candidate)) {
        errors.push(`${label}: link escapes the project: '${target}'`);
        continue;
      }
      if (within(root, candidate)) {
        try {
          ownedPath(root, relative(root, candidate).split(sep).join("/"));
        } catch (error) {
          errors.push(`${label}: invalid link target '${target}': ${String(error)}`);
          continue;
        }
      }
      if (!existsSync(candidate) || !lstatSync(candidate).isFile()) {
        errors.push(`${label}: missing link target '${target}'`);
        continue;
      }
      if (fragment && extname(candidate).toLowerCase() === ".md") {
        if (!cache.has(candidate)) cache.set(candidate, anchors(readText(candidate)));
        if (!required(cache.get(candidate), "expected cache.get(candidate)").has(anchor ?? "")) {
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
