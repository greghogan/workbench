import { InvalidInput } from "./input-errors.js";
import { readLanguageRoots } from "./core.js";
import { relativePath } from "./paths.js";
import {
  ciInputs,
  comparisonGit as git,
  comparisonData,
  ComparisonUnavailable,
  type Inputs,
  type Dependency,
  type ComparisonFailure,
} from "./ci-inputs.js";
import { terminalTable } from "./terminal-table.js";
import type { ciMatrix } from "./ci.js";

export interface CISelectionOptions {
  affected?: boolean;
  base?: string;
  head?: string;
  full?: boolean;
  mergeBase?: boolean;
  explainFiles?: boolean;
}
export interface CISelection {
  version: 1;
  mode: "full" | "affected" | "fallback";
  base: string | null;
  head: string;
  changedCount: number | null;
  changed?: string[];
  selected: { path: string; reasons: string[]; matches?: { reason: string; files: string[] }[] }[];
  excluded: { path: string; reason: string }[];
  reason: string;
  failure?: ComparisonFailure;
}
const contains = (parent: string, path: string) => parent === "." || path === parent || path.startsWith(`${parent}/`);
const revision = (root: string, ref: string) =>
  git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();

/** Compile both revisions once: removed declarations remain valid propagation edges. */
function dependencyGraph(snapshots: Inputs[]) {
  const dependencies = new Map<string, Dependency>();
  const outgoing = new Map<string, Map<string, { target: string; dependency: Dependency }>>();
  for (const input of snapshots)
    for (const dependency of input.dependencies) {
      const key = JSON.stringify([dependency.path, dependency.source]);
      const merged = dependencies.get(key) ?? { ...dependency, roots: [] };
      merged.roots = [...new Set([...merged.roots, ...dependency.roots])];
      dependencies.set(key, merged);
      for (const owner of input.roots) {
        if (owner === "." || !(contains(owner, dependency.path) || contains(dependency.path, owner))) continue;
        const edges = outgoing.get(owner) ?? new Map<string, { target: string; dependency: Dependency }>();
        for (const target of dependency.roots)
          if (target !== owner) edges.set(JSON.stringify([target, key]), { target, dependency });
        outgoing.set(owner, edges);
      }
    }
  return { dependencies: [...dependencies.values()], outgoing };
}

interface MatchGroup {
  count: number;
  files?: string[];
}
type FileReason =
  | { kind: "configuration" | "unclassified" | "root"; match: MatchGroup }
  | { kind: "dependency"; path: string; source: string; match: MatchGroup };
type SelectionReason =
  FileReason | { kind: "new" } | { kind: "propagated"; owner: string; path: string; source: string };

/** Identity never depends on display text or the number of matched files. */
function reasonKey(reason: SelectionReason): string {
  switch (reason.kind) {
    case "dependency":
      return JSON.stringify([reason.kind, reason.path, reason.source]);
    case "propagated":
      return JSON.stringify([reason.kind, reason.owner, reason.path, reason.source]);
    case "configuration":
    case "unclassified":
    case "root":
    case "new":
      return reason.kind;
  }
}

function reasonText(reason: SelectionReason): string {
  if (reason.kind === "new") return "new CI root";
  if (reason.kind === "propagated")
    return `${reason.owner}: affected root dependency (${reason.source}: ${reason.path})`;
  const label =
    reason.kind === "dependency"
      ? `${reason.source}: ${reason.path}`
      : {
          configuration: "shared configuration",
          unclassified: "shared or unclassified input",
          root: "root input",
        }[reason.kind];
  return `${label} (${String(reason.match.count)} changed ${reason.match.count === 1 ? "file" : "files"})`;
}

/** NUL-delimited name/status output preserves spaces and includes both sides of renames/copies. */
export function changedPaths(output: string): string[] {
  const fields = output.split("\0");
  if (fields.pop() !== "") throw new InvalidInput("unterminated Git change list");
  const paths = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status || !/^(?:[ADMTUXB]|[RC]\d+)$/.test(status)) throw new InvalidInput("unsupported Git change status");
    for (let count = 0; count < (/^[RC]/.test(status) ? 2 : 1); count++) {
      const path = fields[index++];
      if (!path) throw new InvalidInput("missing Git change path");
      relativePath(path, "Git change path");
      paths.add(path);
    }
  }
  return [...paths].sort();
}

export function selectChangedRoots(current: Inputs, previous: Inputs, paths: string[], explainFiles = false) {
  const reasons = new Map(current.roots.map((path) => [path, new Map<string, SelectionReason>()]));
  const changes = [...new Set(paths)].sort();
  const snapshots = [previous, current];
  const { dependencies, outgoing } = dependencyGraph(snapshots);
  const group = (): MatchGroup => ({ count: 0, ...(explainFiles ? { files: [] } : {}) });
  const record = (match: MatchGroup, path: string) => {
    match.count++;
    match.files?.push(path);
  };
  const matchedDependencies = new Set<string>();
  const dependencyMatches = dependencies.map((dependency) => {
    const match = group();
    for (const path of changes)
      if (contains(dependency.path, path)) {
        record(match, path);
        matchedDependencies.add(path);
      }
    return { ...dependency, match };
  });
  const byRoot = new Map<string, typeof dependencyMatches>();
  for (const dependency of dependencyMatches)
    for (const root of dependency.roots) {
      const matches = byRoot.get(root) ?? [];
      matches.push(dependency);
      byRoot.set(root, matches);
    }
  const owners = [...new Set(snapshots.flatMap((input) => input.roots))].filter((owner) => owner !== ".");
  const rootInputs = new Map<string, MatchGroup>();
  const configuration = group();
  const unclassified = group();
  for (const path of changes) {
    if (["workbench/config.toml", "workbench/automation.toml", "workbench/projects.toml"].includes(path)) {
      record(configuration, path);
      continue;
    }
    // Explicit dependencies take precedence over documentation-only classification.
    if (
      snapshots.some((input) => input.documentation.some((prefix) => contains(prefix, path))) ||
      /(?:^|\/)(?:AGENTS|CHARTER)\.md$/.test(path)
    )
      continue;
    const matches = owners.filter((owner) => contains(owner, path));
    const longest = Math.max(...matches.map((owner) => owner.length));
    for (const owner of matches.filter((owner) => owner.length === longest)) {
      const match = rootInputs.get(owner) ?? group();
      record(match, path);
      rootInputs.set(owner, match);
    }
    if (matches.length || matchedDependencies.has(path)) continue;
    if (snapshots.every((input) => input.ignored?.some((prefix) => contains(prefix, path)))) continue;
    if (path.endsWith(".md")) continue;
    record(unclassified, path);
  }
  const add = (root: string, reason: SelectionReason) => reasons.get(root)?.set(reasonKey(reason), reason);
  for (const root of current.roots) {
    const addFiles = (reason: FileReason) => {
      if (reason.match.count) add(root, reason);
    };
    addFiles({ kind: "configuration", match: configuration });
    addFiles({ kind: "unclassified", match: unclassified });
    const owned = rootInputs.get(root);
    if (owned) addFiles({ kind: "root", match: owned });
    for (const dependency of byRoot.get(root) ?? [])
      addFiles({ kind: "dependency", path: dependency.path, source: dependency.source, match: dependency.match });
  }
  for (const path of current.roots) if (!previous.roots.includes(path)) add(path, { kind: "new" });
  // A consumer of another root's files also depends on that root's shared inputs.
  // Admit each root once; cycles terminate and traversal needs no repeated full scans.
  const queue = [...reasons].filter(([, values]) => values.size).map(([path]) => path);
  const admitted = new Set(queue);
  for (const owner of queue) {
    for (const { target, dependency } of outgoing.get(owner)?.values() ?? []) {
      if (!reasons.has(target)) continue;
      add(target, { kind: "propagated", owner, path: dependency.path, source: dependency.source });
      if (!admitted.has(target)) {
        admitted.add(target);
        queue.push(target);
      }
    }
  }
  return {
    selected: [...reasons]
      .filter(([, values]) => values.size)
      .map(([path, values]) => ({
        path,
        reasons: [...values.values()].map(reasonText).sort(),
        ...(explainFiles
          ? {
              matches: [...values.values()]
                .flatMap((reason) =>
                  "match" in reason && reason.match.files
                    ? [{ reason: reasonText(reason), files: reason.match.files }]
                    : [],
                )
                .sort((a, b) => a.reason.localeCompare(b.reason)),
            }
          : {}),
      })),
    excluded: [...reasons]
      .filter(([, values]) => !values.size)
      .map(([path]) => ({ path, reason: "no changed inputs or dependencies" })),
  };
}

/** Conservative comparison shared by hosted planning and optional local rehearsal. */
export function ciSelection(root: string, options: CISelectionOptions = {}): CISelection {
  if (options.full && (options.affected || options.base || options.head || options.mergeBase))
    throw new Error("--full cannot be combined with affected comparison options");
  if (options.head && !options.base) throw new Error("--head requires --base");
  if (options.mergeBase && !options.base) throw new Error("--merge-base requires --base");
  const roots = [...new Set(readLanguageRoots(root).map((entry) => entry.path))];
  const result: CISelection = {
    version: 1,
    mode: "full",
    base: null,
    head: options.head ?? "working tree",
    changedCount: null,
    selected: [],
    excluded: [],
    reason: "complete configured matrix",
  };
  const full = (reason: string) => {
    result.reason = reason;
    result.selected = roots.map((path) => ({ path, reasons: [reason] }));
    return result;
  };
  if (!options.affected && !options.base) return full(options.full ? "explicit complete matrix" : result.reason);
  if (!options.base) {
    result.mode = "fallback";
    result.failure = { kind: "history", operation: "resolve comparison base", message: "no base supplied" };
    return full("comparison base unavailable; complete matrix");
  }
  try {
    const head = options.head ? revision(root, options.head) : undefined;
    const base = revision(root, options.base);
    result.head = head ?? "working tree";
    const comparedBase = options.mergeBase
      ? git(root, ["merge-base", base, head ?? revision(root, "HEAD")]).trim()
      : base;
    result.base = comparedBase;
    const paths = comparisonData("changes", "decode Git changed paths", () =>
      changedPaths(
        git(root, ["diff", "--name-status", "-z", "--find-renames", comparedBase, ...(head ? [head] : []), "--"]),
      ),
    );
    if (!head)
      for (const path of git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) {
        comparisonData("changes", "validate untracked change path", () => {
          relativePath(path, "untracked change path");
        });
        paths.push(path);
      }
    const changes = [...new Set(paths)].sort();
    result.changedCount = changes.length;
    if (options.explainFiles) result.changed = changes;
    const current = ciInputs(root, head);
    if (JSON.stringify([...current.roots].sort()) !== JSON.stringify([...roots].sort()))
      throw new ComparisonUnavailable(
        "checkout",
        "compare registered roots",
        new Error("comparison head roots differ from checkout"),
      );
    const previous = ciInputs(root, result.base);
    // Selection is pure policy. Unexpected errors here must never turn into expensive full runs.
    Object.assign(result, selectChangedRoots(current, previous, changes, options.explainFiles));
    result.mode = "affected";
    result.reason = "changed inputs and dependencies in both revisions";
    return result;
  } catch (error) {
    if (!(error instanceof ComparisonUnavailable)) throw error;
    result.mode = "fallback";
    result.failure = error.failure;
    return full(`comparison unavailable (${error.message}); complete matrix`);
  }
}

export function selectedCIMatrix(matrix: ReturnType<typeof ciMatrix>, selection: CISelection) {
  const selected = new Set(selection.selected.map((entry) => entry.path));
  return {
    ...matrix,
    native: { include: matrix.native.include.filter((entry) => selected.has(entry.path)) },
    compatibility: { include: matrix.compatibility.include.filter((entry) => selected.has(entry.path)) },
    environments: { include: matrix.environments.include.filter((entry) => selected.has(entry.path)) },
    devcontainer: { ...matrix.devcontainer, paths: matrix.devcontainer.paths.filter((path) => selected.has(path)) },
  };
}

export function printCISelection(selection: CISelection): void {
  console.log(`CI selection: ${selection.mode}; ${selection.reason}`);
  console.log(`Comparison: ${selection.base ?? "none"} -> ${selection.head}`);
  console.log(
    terminalTable(
      ["ROOT", "SELECTED", "REASON"],
      [
        ...selection.selected.map((entry) => [entry.path, "yes", entry.reasons.join("; ")]),
        ...selection.excluded.map((entry) => [entry.path, "no", entry.reason]),
      ],
    ),
  );
}
