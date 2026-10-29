import { GitSnapshot, type GitEntry } from "./git-snapshot.js";
import { parse } from "smol-toml";
import { detail, kinds, relativeRecordPath, type Kind } from "./record-identity.js";
import { projectsFromData } from "./project-configuration.js";
import { validateProjectCollections, type CollectionPin } from "./collection-schema.js";

const protectedKinds: readonly Kind[] = ["ADR", "EXP", "ENV"];

export { gitBytes as recordGit } from "./git-snapshot.js";
/** Immutable blobs and record ownership from a Git tree or a captured list of staged entries. */
export class RecordTree {
  readonly entries = new Map<string, GitEntry>();
  readonly scopes: string[];
  readonly collections: string[];

  constructor(
    readonly root: string,
    readonly tree?: string,
    private readonly snapshot = new GitSnapshot(root),
  ) {
    if (tree !== undefined && tree !== snapshot.head) throw new Error("record tree must belong to its Git snapshot");
    for (const [path, entry] of tree === undefined ? snapshot.staged : snapshot.committed)
      this.entries.set(path, entry);
    const registry = this.text("workbench/projects.toml");
    this.scopes =
      registry !== undefined ? projectsFromData(parse(registry), "workbench/projects.toml").map((p) => p.path) : [];
    for (const scope of this.scopes) {
      const parts = scope === "." ? [] : scope.split("/");
      for (let count = 1; count <= parts.length; count++) {
        const path = parts.slice(0, count).join("/");
        if (this.entries.has(path)) throw new Error(`${path}: expected a project directory`);
      }
    }
    const config = this.text("workbench/config.toml");
    const sources = config ? (parse(config).collections as { sources?: unknown } | undefined)?.sources : undefined;
    if (sources !== undefined) validateProjectCollections(sources, "workbench/config.toml: collections.sources");
    this.collections = ((sources ?? []) as CollectionPin[]).map((pin) => pin.id);
  }

  bytes(path: string): Buffer | undefined {
    const entry = this.entries.get(path);
    if (!entry) return undefined;
    if (!["100644", "100755"].includes(entry.mode) || path.includes("\\"))
      throw new Error(`${path}: expected a regular policy file`);
    return this.snapshot.blob(entry.oid);
  }

  private text(path: string): string | undefined {
    return this.bytes(path)?.toString("utf8");
  }

  /** A supporting file belongs to its record; only an exact canonical path is a primary record. */
  classify(path: string): { charter: boolean; protected: boolean; policy: boolean; primary?: Kind | undefined } {
    return classifyRecordPath(path, this.scopes, this.collections);
  }

  policyEntries(): [string, GitEntry][] {
    return [...this.entries].filter(
      ([path]) =>
        ["workbench/config.toml", "workbench/projects.toml"].includes(path) ||
        this.classify(path).policy ||
        this.collections.some(
          (id) => path === `workbench/collections/${id}` || path.startsWith(`workbench/collections/${id}/`),
        ),
    );
  }
}

export function stagedRecordTree(root: string): RecordTree {
  return new RecordTree(root);
}

/** Before and after declarations both protect records during scope or collection removal. */
export function proposedRecordTrees(root: string, snapshot = new GitSnapshot(root)): RecordTree[] {
  const staged = new RecordTree(root, undefined, snapshot);
  return snapshot.head ? [staged, new RecordTree(root, snapshot.head, snapshot)] : [staged];
}

/** Ownership rules shared by committed, staged, and working records. */
export function classifyRecordPath(
  path: string,
  scopes: string[],
  collections: string[],
): ReturnType<RecordTree["classify"]> {
  for (const scope of scopes) {
    const prefix = `${scope === "." ? "" : `${scope}/`}workbench/`;
    if (!path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length);
    if (name === "CHARTER.md") return { charter: true, protected: true, policy: true };
    for (const kind of kinds) {
      if (name !== detail(kind).directory && !name.startsWith(`${detail(kind).directory}/`)) continue;
      const primary = canonicalRecordKind(name);
      return { charter: false, protected: protectedKinds.includes(kind), policy: kind === "ADR", primary };
    }
  }
  for (const id of collections) {
    if (path === `workbench/collections/${id}/CHARTER.md`) return { charter: true, protected: true, policy: false };
    if (path.startsWith(`workbench/collections/${id}/decisions/`))
      return { charter: false, protected: true, policy: true };
  }
  return { charter: false, protected: false, policy: false };
}

/** Canonical identity is shared by tree classification and supporting-file ownership. */
function canonicalRecordKind(path: string): Kind | undefined {
  return kinds.find((kind) => {
    const number = new RegExp(`/${kind}-([0-9A-Z]+)\\.${detail(kind).extension}$`).exec(`/${path}`)?.[1];
    return number !== undefined && relativeRecordPath(kind, number).replaceAll("\\", "/") === path;
  });
}
export function recordOwnerPath(path: string, scopes: string[], collections: string[]): string | undefined {
  const prefixes = [
    ...scopes.map((scope) => `${scope === "." ? "" : `${scope}/`}workbench/`),
    ...collections.map((id) => `workbench/collections/${id}/`),
    // A removed scope still owns its deleted records and supporting files.
    ...[...path.matchAll(/(?:^|\/)workbench\//g)].map((match) => path.slice(0, match.index + match[0].length)),
  ].sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (!path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length);
    if (name === "CHARTER.md" || canonicalRecordKind(name)) return path;
    for (let boundary = name.lastIndexOf("/"); boundary > 0; boundary = name.lastIndexOf("/", boundary - 1)) {
      for (const extension of new Set(kinds.map((kind) => detail(kind).extension))) {
        const candidate = name.slice(0, boundary) + "." + extension;
        if (canonicalRecordKind(candidate)) return prefix + candidate;
      }
    }
  }
  return undefined;
}

/** Literal roots bound working review discovery to the same scopes protected by classification. */
export function protectedRecordPaths(scopes: string[], collections: string[]): string[] {
  return [
    ...new Set([
      ...scopes.flatMap((scope) => {
        const prefix = `${scope === "." ? "" : `${scope}/`}workbench/`;
        return [prefix + "CHARTER.md", ...protectedKinds.map((kind) => prefix + detail(kind).directory)];
      }),
      ...collections.flatMap((id) => [
        `workbench/collections/${id}/CHARTER.md`,
        `workbench/collections/${id}/decisions`,
      ]),
    ]),
  ];
}
