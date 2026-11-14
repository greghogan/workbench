import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import { gitBytes, readGitObjects, readGitTree } from "../git/git-snapshot.js";
import { repositoryStatePath } from "../git/repository-state.js";
import { validateBranch } from "../git/refs.js";
import { projectPaths } from "../projects/project-paths.js";
import { InvalidInput } from "../runtime/input-errors.js";
import { record } from "../runtime/values.mjs";
import { readArchiveTree } from "./archive-index.js";

import { pushUpdates, zeroRevision as zero, type PushUpdate } from "../git/push-updates.js";
function ancestor(root: string, previous: string, tip: string): boolean {
  const result = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", previous, tip], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && result.status !== 1))
    throw new InvalidInput("Fetch the archive history before checking publication");
  return result.status === 0;
}
function protectedRef(root: string, ref: string): boolean {
  if (!ref.startsWith("refs/heads/")) return false;
  validateBranch(root, ref.slice("refs/heads/".length));
  return existsSync(repositoryStatePath(root, "archives", "protected", ref));
}

function stateRevision(root: string, commit: string): string | undefined {
  const entry = readGitTree(root, commit).get(projectPaths.state);
  const bytes = entry ? readGitObjects(root, [entry.oid]).get(entry.oid) : undefined;
  if (!bytes) return undefined;
  const revision = record(parse(bytes.toString()).archive ?? {}, "Invalid archive state").revision;
  return typeof revision === "string" ? revision : undefined;
}
function publishedTip(root: string, ref: string, updates: PushUpdate[], remote: string): string | undefined {
  const proposed = updates.find((update) => update.remoteRef === ref);
  if (proposed) return zero(proposed.tip) ? undefined : proposed.tip;
  if (!remote || remote.startsWith("-")) throw new InvalidInput("Cannot verify the archive publication destination");
  return gitBytes(root, ["ls-remote", "--refs", remote, ref]).toString().trim().split(/\s/)[0];
}
/** Find restored bytes by content and pinned archive context, independent of rewritten implementation commit IDs. */
function restorationPublished(
  root: string,
  tip: string,
  archive: string,
  removed: ReadonlyMap<string, { mode: string; oid: string }>,
): boolean {
  const rows = gitBytes(root, ["log", "--format=%H %P", tip, "--", projectPaths.state]).toString().trim().split("\n");
  for (const row of rows) {
    const [commit, parent] = row.split(" ");
    if (!commit || !parent || stateRevision(root, commit) !== undefined || stateRevision(root, parent) !== archive)
      continue;
    const tree = readGitTree(root, commit);
    if ([...removed].every(([path, entry]) => tree.get(path)?.oid === entry.oid && tree.get(path)?.mode === entry.mode))
      return true;
  }
  return false;
}

/** Check every proposed ref together, before project gates or registry requests. */
export function checkArchivePublication(root: string, input: string, remote: string): string[] {
  const updates = pushUpdates(input);
  const archives: string[] = [],
    checked = new Set<string>();
  const destinations = new Map<string, string | undefined>();
  const destination = (ref: string): string | undefined => {
    if (!destinations.has(ref)) destinations.set(ref, publishedTip(root, ref, updates, remote));
    return destinations.get(ref);
  };
  for (const update of updates) {
    if (protectedRef(root, update.remoteRef) || protectedRef(root, update.localRef)) {
      if (zero(update.tip)) throw new InvalidInput(`Cannot delete protected archive ${update.remoteRef}`);
      if (update.localRef !== update.remoteRef && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(update.localRef))
        throw new InvalidInput("Publish archives under their configured branch name");
      if (!zero(update.previous) && !ancestor(root, update.previous, update.tip))
        throw new InvalidInput("Archive history cannot be rewritten");
      const trustedFile = repositoryStatePath(root, "archives", "protected", update.remoteRef);
      const trusted = readFileSync(trustedFile, "utf8").trim();
      const commits = gitBytes(root, [
        "rev-list",
        "--parents",
        update.tip,
        ...(zero(update.previous) ? [] : ["--not", update.previous]),
      ])
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const row of commits) {
        const [commit, parent] = row.split(" ");
        if (!commit) throw new InvalidInput("Invalid archive history");
        readArchiveTree(root, commit);
        const permit = repositoryStatePath(
          root,
          "archives",
          "permits",
          `${parent ?? "0".repeat(commit.length)}-${commit}`,
        );
        if (
          (!existsSync(permit) || readFileSync(permit, "utf8").trim() !== update.remoteRef) &&
          (!/^[a-f0-9]{40,64}$/.test(trusted) || !ancestor(root, commit, trusted))
        )
          throw new InvalidInput(
            `Unmanaged archive commit ${commit.slice(0, 12)}; publish verified Workbench transfers`,
          );
      }
      for (const row of commits) {
        const [commit, parent] = row.split(" ");
        if (!commit || !parent) continue;
        const witness = repositoryStatePath(root, "archives", "restorations", commit);
        if (!existsSync(witness)) continue;
        const ref = readFileSync(witness, "utf8").trim();
        if (!ref.startsWith("refs/heads/")) throw new InvalidInput("Invalid restoration publication target");
        validateBranch(root, ref.slice("refs/heads/".length));
        const previous = readArchiveTree(root, parent).files,
          current = readArchiveTree(root, commit).files;
        const removed = new Map([...previous].filter(([path]) => !current.has(path)));
        const tip = destination(ref);
        if (removed.size && (!tip || !restorationPublished(root, tip, parent, removed)))
          throw new InvalidInput(
            `Publish and verify restored records on ${ref} before publishing archive cleanup, or push both branches atomically`,
          );
      }
      archives.push(update.localRef);
      continue;
    }
    if (zero(update.tip)) continue;
    const type = gitBytes(root, ["cat-file", "-t", `${update.tip}^{}`])
      .toString()
      .trim();
    if (type !== "commit") continue;
    const commits = new Set([
      update.tip,
      ...gitBytes(root, [
        "log",
        "--format=%H",
        update.tip,
        ...(zero(update.previous) ? [] : ["--not", update.previous]),
        "--",
        projectPaths.state,
      ])
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean),
    ]);
    for (const commit of commits) {
      const tree = readGitTree(root, commit),
        stateEntry = tree.get(projectPaths.state);
      if (!stateEntry) continue;
      const stateBytes = readGitObjects(root, [stateEntry.oid]).get(stateEntry.oid);
      if (!stateBytes) throw new InvalidInput("Missing outgoing project state");
      const state = parse(stateBytes.toString()),
        revision = record(state.archive ?? {}, "Invalid archive state").revision;
      if (revision === undefined) continue;
      if (typeof revision !== "string") throw new InvalidInput("Invalid outgoing archive revision");
      readArchiveTree(root, revision);
      const configEntry = tree.get(projectPaths.config);
      const configBytes = configEntry ? readGitObjects(root, [configEntry.oid]).get(configEntry.oid) : undefined;
      if (!configBytes) throw new InvalidInput("Missing outgoing archive configuration");
      const config = parse(configBytes.toString()),
        branch = record(config.records ?? {}, "Invalid records configuration").archive_branch;
      if (typeof branch !== "string") throw new InvalidInput("Outgoing archive references require an archive branch");
      validateBranch(root, branch);
      const identity = `${branch}:${revision}`;
      if (checked.has(identity)) continue;
      const archiveRef = `refs/heads/${branch}`,
        available = destination(archiveRef);
      if (!available || zero(available) || !ancestor(root, revision, available))
        throw new InvalidInput(
          `Publish and verify ${archiveRef} before pushing commits that reference archive ${revision.slice(0, 12)}, or push both branches atomically`,
        );
      checked.add(identity);
    }
  }
  return archives;
}
