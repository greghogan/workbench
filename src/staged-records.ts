import { spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import { detail, kinds, projectsFromData, relativeRecordPath, type Kind } from "./core.js";
import { validateProjectCollections, type CollectionPin } from "./collection-schema.js";

interface TreeEntry {
  mode: string;
  oid: string;
}

export function recordGit(root: string, args: string[]): Buffer {
  const result = spawnSync("git", ["-C", root, ...args], { maxBuffer: 64_000_000 });
  if (result.error || result.status !== 0)
    throw new Error(
      `cannot inspect staged records: ${result.error ? result.error.message : result.stderr.toString().trim() || `exit status ${String(result.status)}`}`,
    );
  return result.stdout;
}

/** Immutable Git contents and the record ownership declared by that tree. */
export class RecordTree {
  readonly entries = new Map<string, TreeEntry>();
  readonly scopes: string[];
  readonly collections: string[];

  constructor(
    readonly root: string,
    readonly tree: string,
  ) {
    for (const entry of recordGit(root, ["ls-tree", "-r", "-z", "--full-tree", tree]).toString().split("\0")) {
      if (!entry) continue;
      const tab = entry.indexOf("\t");
      const [mode, , oid] = entry.slice(0, tab).split(" ");
      if (!mode || !oid || tab < 0) throw new Error("invalid Git tree entry");
      this.entries.set(entry.slice(tab + 1), { mode, oid });
    }
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
    return recordGit(this.root, ["cat-file", "blob", entry.oid]);
  }

  private text(path: string): string | undefined {
    return this.bytes(path)?.toString("utf8");
  }

  /** A supporting file belongs to its record; only an exact canonical path is a primary record. */
  classify(path: string): { charter: boolean; protected: boolean; policy: boolean; primary?: Kind | undefined } {
    for (const scope of this.scopes) {
      const prefix = `${scope === "." ? "" : `${scope}/`}workbench/`;
      if (!path.startsWith(prefix)) continue;
      const name = path.slice(prefix.length);
      if (name === "CHARTER.md") return { charter: true, protected: true, policy: true };
      for (const kind of kinds) {
        if (name !== detail(kind).directory && !name.startsWith(`${detail(kind).directory}/`)) continue;
        const match = new RegExp(`/${kind}-([0-9A-Z]+)\\.${detail(kind).extension}$`).exec(`/${name}`);
        const primary =
          match?.[1] && relativeRecordPath(kind, match[1]).replaceAll("\\", "/") === name ? kind : undefined;
        return { charter: false, protected: ["ADR", "EXP", "ENV"].includes(kind), policy: kind === "ADR", primary };
      }
    }
    for (const id of this.collections) {
      if (path === `workbench/collections/${id}/CHARTER.md`) return { charter: true, protected: true, policy: false };
      if (path.startsWith(`workbench/collections/${id}/decisions/`))
        return { charter: false, protected: true, policy: true };
    }
    return { charter: false, protected: false, policy: false };
  }

  policyEntries(): [string, TreeEntry][] {
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
  return new RecordTree(root, recordGit(root, ["write-tree"]).toString().trim());
}

/** Before and after declarations both protect records during scope or collection removal. */
export function proposedRecordTrees(root: string): RecordTree[] {
  const staged = stagedRecordTree(root);
  const head = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD^{tree}"], { encoding: "utf8" });
  if (!head.error && head.status === 1) return [staged];
  if (head.error || head.status !== 0)
    throw new Error(`cannot inspect committed records: ${String(head.stderr || head.error)}`);
  return [staged, new RecordTree(root, head.stdout.trim())];
}
