import { authoritativeFiles, collectionWorkingFiles, mergeCollectionFiles } from "./collection-files.js";
export { collectionWorkingFiles } from "./collection-files.js";
import {
  acquireGitCollection,
  collectionOriginals,
  collectionGitmodules,
  fetchCollectionOriginals,
  validateCollectionSubmodules,
  validateCollectionWorkingTree,
  type GitCollectionOptions,
} from "./collection-git.js";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { editToml } from "./toml-edit.js";
import { readConfig, readProjects, readText, rootOf, writeAtomic } from "./core.js";
import { resolveCollections, type VerifiedCollection } from "./collections.js";
import type { CollectionPin } from "./collection-schema.js";
import { decisionScopes } from "./decisions.js";
import { renderCollectionMap } from "./collection-maps.js";
import { ownedPath } from "./paths.js";
import { git } from "./update-git.js";
import { withCacheLockSync } from "./cache-lock.js";

const hash = (value: Buffer | undefined) =>
  value === undefined ? null : createHash("sha256").update(value).digest("hex");
const equal = (a: Buffer | undefined, b: Buffer | undefined) => hash(a) === hash(b);
const originals = (collection: VerifiedCollection) => authoritativeFiles(collection.files);
const fingerprint = (files: Map<string, Buffer>) =>
  hash(
    Buffer.from(
      JSON.stringify(
        [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, bytes]) => [name, hash(bytes)]),
      ),
    ),
  );

/** Publish each file completely; the transaction journal coordinates the multi-file replacement. */
function publishBytes(path: string, bytes: Buffer | undefined): void {
  if (bytes === undefined) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const pending = join(dirname(path), `.collection-${randomUUID()}.tmp`);
  try {
    writeFileSync(pending, bytes, { flag: "wx" });
    renameSync(pending, path);
  } finally {
    rmSync(pending, { force: true });
  }
}

export function collectionChanges(root: string, id: string) {
  const current = resolveCollections(root, false).find((entry) => entry.pin.id === id);
  if (!current) throw new Error(`project collection not found: ${id}`);
  const original = originals(collectionOriginals(root, current.pin));
  const working = authoritativeFiles(collectionWorkingFiles(current.directory));
  return [...new Set([...original.keys(), ...working.keys()])].sort().flatMap((path) =>
    equal(original.get(path), working.get(path))
      ? []
      : [
          {
            path: path.slice("workbench/".length),
            change: !original.has(path) ? "added" : !working.has(path) ? "removed" : "modified",
          },
        ],
  );
}

/** Prepare all files before applying; conflicts preserve an editable proposal and leave the checkout untouched. */
export function reconcileCollection(
  root: string,
  source: string,
  options: GitCollectionOptions,
  id?: string,
  resolved?: string,
): CollectionPin {
  const candidate = acquireGitCollection(root, source, { ...options, ...(id ? { id } : {}) });
  if (id && candidate.pin.id !== id) throw new Error("candidate collection identity or SHA-256 does not match");
  const collectionId = candidate.pin.id;
  const recovery = git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "workbench/collection-recovery",
  ]).trim();
  if (existsSync(recovery))
    throw new Error(`preserving an interrupted reconciliation; inspect ${recovery} before retrying`);
  const configPath = ownedPath(root, "workbench/config.toml");
  const lock = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "workbench/collections"]).trim();
  mkdirSync(dirname(lock), { recursive: true });
  return withCacheLockSync(lock, () => {
    if (existsSync(recovery))
      throw new Error(`preserving an interrupted reconciliation; inspect ${recovery} before retrying`);
    const previousConfig = readText(configPath);
    const configured = readConfig(root).collections?.sources ?? [];
    const current = resolveCollections(root, false).find((entry) => entry.pin.id === collectionId);
    if (id && !current) throw new Error(`project collection not found: ${id}`);
    validateCollectionSubmodules(root, configured);
    validateCollectionWorkingTree(root, collectionId);
    if (current) fetchCollectionOriginals(root, current.pin);
    if (!id && current) throw new Error(`collection '${collectionId}' already exists; use collection update`);
    const active = ownedPath(root, `workbench/collections/${collectionId}`);
    const gitmodules = ownedPath(root, ".gitmodules");
    const beforeModules = existsSync(gitmodules) ? readFileSync(gitmodules) : undefined;
    if (!current && existsSync(active)) throw new Error("preserving an existing collection destination");
    const base = current ? originals(collectionOriginals(root, current.pin)) : new Map<string, Buffer>();
    const working = current ? collectionWorkingFiles(active) : new Map<string, Buffer>();
    const local = authoritativeFiles(working);
    const projectFingerprint = fingerprint(local);
    if (resolved) {
      const report = JSON.parse(readText(join(resolve(resolved), "../conflicts.json"))) as {
        before?: CollectionPin;
        after?: CollectionPin;
        project_sha256?: string;
      };
      if (
        report.after?.sha256 !== candidate.pin.sha256 ||
        report.before?.sha256 !== current?.pin.sha256 ||
        report.after.commit !== candidate.pin.commit ||
        report.before?.commit !== current?.pin.commit
      )
        throw new Error("resolution proposal does not match the retained and incoming revisions");
      if (report.project_sha256 !== projectFingerprint)
        throw new Error(
          "project files changed since the conflict proposal was prepared; start a new reconciliation and preserve the existing proposal",
        );
    }
    const incoming = originals(candidate);
    const temporary = mkdtempSync(join(tmpdir(), "workbench-reconcile-"));
    let retained = false;
    try {
      const { proposed, conflicts } = mergeCollectionFiles(base, local, incoming, temporary);
      const proposal = join(temporary, "resolved");
      for (const [name, bytes] of proposed) {
        const path = ownedPath(proposal, name.slice("workbench/".length));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
      }
      if (conflicts.length && !resolved) {
        retained = true;
        writeFileSync(
          join(temporary, "conflicts.json"),
          JSON.stringify(
            {
              id: collectionId,
              before: current?.pin,
              after: candidate.pin,
              project_sha256: projectFingerprint,
              conflicts,
            },
            null,
            2,
          ) + "\n",
        );
        throw new Error(
          `collection conflicts: ${conflicts.join(", ")}. Checkout unchanged. Resolve files in ${proposal}, then repeat with --resolved ${proposal}`,
        );
      }
      const selected = resolved ? authoritativeFiles(collectionWorkingFiles(resolve(resolved))) : proposed;
      if ([...selected.values()].some((bytes) => /^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(bytes.toString("utf8"))))
        throw new Error("resolved collection still contains merge markers");
      const pin = {
        ...candidate.pin,
        scopes: current?.pin.scopes ?? ["."],
        source,
      };
      const document = parse(previousConfig) as Record<string, unknown>;
      document.collections = {
        sources: configured.some((entry) => entry.id === collectionId)
          ? configured.map((entry) => (entry.id === collectionId ? pin : entry))
          : [...configured, pin],
      };
      const nextConfig = editToml(previousConfig, document);
      const nextModules = Buffer.from(collectionGitmodules(root, pin));
      // Inspect the candidate policy graph against copies of project-owned records before any publication.
      const preparation = join(temporary, "project");
      cpSync(join(root, "workbench"), join(preparation, "workbench"), {
        recursive: true,
        filter: (path) => ![".local-collections", ".collections"].includes(path.split(/[\\/]/).at(-1) ?? ""),
      });
      for (const project of readProjects(root).filter((entry) => entry.path !== ".")) {
        if (existsSync(join(rootOf(root, project), "workbench")))
          cpSync(join(rootOf(root, project), "workbench"), join(rootOf(preparation, project), "workbench"), {
            recursive: true,
          });
      }
      const preparedActive = join(preparation, "workbench/collections", collectionId);
      rmSync(preparedActive, { recursive: true, force: true });
      for (const [name, bytes] of selected) {
        const path = ownedPath(preparedActive, name.slice("workbench/".length));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
      }
      writeAtomic(join(preparation, "workbench/config.toml"), nextConfig);
      writeFileSync(join(preparation, ".gitmodules"), nextModules);
      const scope = decisionScopes(preparation, false).find((entry) => entry.project.id === collectionId);
      if (!scope) throw new Error("reconciled collection scope is missing");
      const map = Buffer.from(renderCollectionMap(scope.decisions, readConfig(root).markdown?.wrap_width ?? 120));
      selected.set("workbench/decision-map.md", map);
      writeFileSync(join(preparedActive, "decision-map.md"), map);
      const changes = new Map<string, Buffer | undefined>();
      for (const name of new Set([...working.keys(), ...selected.keys()]))
        changes.set(`workbench/collections/${collectionId}/${name.slice("workbench/".length)}`, selected.get(name));
      changes.set(".gitmodules", nextModules);
      changes.set("workbench/config.toml", Buffer.from(nextConfig));
      const before = new Map(
        [...changes.keys()].map((name) => {
          const bytes =
            name === "workbench/config.toml"
              ? Buffer.from(previousConfig)
              : name === ".gitmodules"
                ? beforeModules
                : working.get(`workbench/${name.slice(`workbench/collections/${collectionId}/`.length)}`);
          return [name, bytes] as const;
        }),
      );
      if (
        readText(configPath) !== previousConfig ||
        !equal(existsSync(gitmodules) ? readFileSync(gitmodules) : undefined, beforeModules) ||
        (current ? fingerprint(collectionWorkingFiles(active)) !== fingerprint(working) : existsSync(active))
      )
        throw new Error("project changed during reconciliation; checkout unchanged");
      mkdirSync(recovery, { mode: 0o700 });
      const intent = [...changes].map(([name, bytes], index) => {
        const backup = before.get(name);
        if (backup !== undefined)
          writeFileSync(join(recovery, `${String(index)}.bin`), backup, { flag: "wx", mode: 0o600 });
        return {
          name,
          before: hash(backup),
          after: hash(bytes),
          backup: backup === undefined ? null : `${String(index)}.bin`,
        };
      });
      writeFileSync(
        join(recovery, "intent.json"),
        JSON.stringify({ id: collectionId, before: current?.pin, after: pin, files: intent }, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      const attempted: string[] = [];
      try {
        for (const [name, bytes] of changes) {
          const path = ownedPath(root, name);
          if (!equal(existsSync(path) ? readFileSync(path) : undefined, before.get(name)))
            throw new Error(`${name}: concurrent modification`);
          attempted.push(name);
          publishBytes(path, bytes);
        }
      } catch (error) {
        try {
          for (const name of attempted.reverse()) {
            const path = ownedPath(root, name),
              bytes = before.get(name);
            const present = existsSync(path) ? readFileSync(path) : undefined;
            if (equal(present, bytes)) continue;
            if (!equal(present, changes.get(name)))
              throw new Error(`${name}: recovery preserves a concurrent edit`, { cause: error });
            publishBytes(path, bytes);
          }
          rmSync(recovery, { recursive: true });
        } catch (rollback) {
          retained = true;
          throw new AggregateError(
            [error, rollback],
            `reconciliation recovery requires review at ${recovery}; proposal retained at ${temporary}`,
            { cause: rollback },
          );
        }
        throw error;
      }
      rmSync(recovery, { recursive: true });
      return pin;
    } finally {
      if (!retained) rmSync(temporary, { recursive: true, force: true });
    }
  });
}
