import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { parse, stringify } from "smol-toml";
import { git, gitEnvironment } from "./update-git.js";
import { collectionName, validateCollectionSource, type CollectionPin } from "./collection-schema.js";
import { inspectCollectionContents, type VerifiedCollection } from "./collections.js";
import { normalizedNumber, relativeRecordPath } from "./core.js";
import { ownedPath, relativePath } from "./paths.js";
import { withCacheLockSync } from "./cache-lock.js";
import { collectionFileLimit, collectionByteLimit, collectionCharterPath } from "./collection-files.js";
import { formatByteCount } from "./byte-size.js";

export const collectionCommit = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
export interface GitCollectionOptions {
  commit: string;
  id?: string;
  collection?: string;
  sha256?: string;
  visibility?: "public" | "private";
}
export const collectionSubmoduleName = (id: string) => `workbench-collection-${id}`;
export const collectionSubmodulePath = (id: string) => `.workbench/collections/${id}`;
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const gitPath = (root: string, name: string) =>
  git(root, ["rev-parse", "--path-format=absolute", "--git-path", name]).trim();
export function collectionRepository(root: string, id: string): string {
  if (!collectionName.test(id)) throw new Error("invalid collection namespace");
  return gitPath(root, `modules/${collectionSubmoduleName(id)}`);
}

function repositoryGit(repository: string, args: string[], maximum = 1024 * 1024): Buffer {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      // Deferred maintenance would outlive the collection lock and race immediate integrity checks.
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "--literal-pathspecs",
      `--git-dir=${repository}`,
      ...args,
    ],
    {
      env: gitEnvironment(),
      maxBuffer: maximum,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(`collection git ${args[0] ?? ""}: ${String(result.error ?? result.stderr)}`);
  return result.stdout;
}

function ensureRepository(repository: string, commit: string): void {
  if (existsSync(repository)) {
    if (!lstatSync(repository).isDirectory() || lstatSync(repository).isSymbolicLink())
      throw new Error("collection object store must be a real directory");
    repositoryGit(repository, ["rev-parse", "--git-dir"]);
    return;
  }
  mkdirSync(repository, { recursive: true, mode: 0o700 });
  repositoryGit(repository, [
    "init",
    "--bare",
    "--quiet",
    `--object-format=${commit.length === 64 ? "sha256" : "sha1"}`,
  ]);
}

function hasCommit(repository: string, commit: string): boolean {
  const result = spawnSync("git", [`--git-dir=${repository}`, "cat-file", "-e", `${commit}^{commit}`], {
    env: gitEnvironment(),
  });
  return !result.error && result.status === 0;
}

/** Fetch into object storage only. Never invoke checkout or recursively initialize a source dependency. */
function fetchCommit(repository: string, source: string, commit: string): void {
  validateCollectionSource(source);
  if (!collectionCommit.test(commit)) throw new Error("supply a full immutable collection Git commit");
  ensureRepository(repository, commit);
  if (!hasCommit(repository, commit))
    repositoryGit(
      repository,
      [
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "protocol.ssh.allow=always",
        "-c",
        "protocol.file.allow=always",
        "-c",
        "fetch.fsckObjects=true",
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--depth=1",
        "--",
        source,
        commit,
      ],
      4 * 1024 * 1024,
    );
  repositoryGit(repository, ["fsck", "--strict", "--no-reflogs", "--no-dangling", commit], 4 * 1024 * 1024);
  const header = repositoryGit(repository, ["cat-file", "commit", commit]).toString("utf8").split("\n\n", 1)[0] ?? "";
  if (/^gpgsig(?:-sha256)? /m.test(header)) repositoryGit(repository, ["verify-commit", commit]);
}

function readBlob(repository: string, commit: string, path: string): Buffer {
  relativePath(path, "collection Git path");
  const object = `${commit}:${path}`;
  const size = Number(repositoryGit(repository, ["cat-file", "-s", object]).toString("utf8").trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > collectionFileLimit)
    throw new Error(`${path}: collection blob exceeds ${formatByteCount(collectionFileLimit)} bytes`);
  return repositoryGit(repository, ["cat-file", "blob", object], collectionFileLimit + 1);
}

/** Verify exported files, or derive a collection from the provider's root ADR scope at the exact commit. */
export function inspectGitCollection(
  repository: string,
  commit: string,
  collection = ".",
  visibility: "public" | "private" = "private",
): VerifiedCollection {
  if (!collectionCommit.test(commit)) throw new Error("supply a full immutable collection Git commit");
  relativePath(collection, "collection root", true);
  if (!existsSync(repository) || !hasCommit(repository, commit))
    throw new Error("collection originals are not available locally; run workbench collection fetch ID");
  const prefix = collection === "." ? "" : `${collection}/`;
  const entries = repositoryGit(
    repository,
    ["ls-tree", "-r", "-z", "--full-tree", commit, "--", `${prefix}workbench`],
    4 * 1024 * 1024,
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
      if (!match?.[1] || !match[4]) throw new Error("invalid collection Git tree entry");
      return { mode: match[1], path: match[4].slice(prefix.length) };
    });
  const names = new Map(entries.map((entry) => [entry.path, entry.mode]));
  const read = (name: string) => {
    if (!["100644", "100755"].includes(names.get(name) ?? ""))
      throw new Error(`${name}: collection inputs must be regular Git blobs`);
    return readBlob(repository, commit, `${prefix}${name}`);
  };
  if (names.has("workbench/collection.toml")) return inspectCollectionContents(repository, read);
  const registry = parse(read("workbench/projects.toml").toString("utf8")) as {
    project?: { id?: string; path?: string }[];
  };
  const owner = registry.project?.find((project) => project.path === ".")?.id;
  if (!owner || !collectionName.test(owner))
    throw new Error("source needs a collection export or an owning root project namespace");
  const files = new Map<string, Buffer>();
  const numbers: string[] = [];
  let total = 0;
  for (const name of names.keys()) {
    if (
      ![collectionCharterPath, "workbench/decision-map.md"].includes(name) &&
      !name.startsWith("workbench/decisions/")
    )
      continue;
    const record = /^workbench\/decisions\/(?:[0-9A-Z]{2}\/)*ADR-([0-9A-Z]+)\.md$/.exec(name);
    const supporting = /^workbench\/decisions\/(?:[0-9A-Z]{2}\/)*ADR-[0-9A-Z]+\//.test(name);
    if (!record && !supporting && ![collectionCharterPath, "workbench/decision-map.md"].includes(name))
      throw new Error(`${name}: unexpected collection source file`);
    if (record?.[1]) {
      const number = normalizedNumber(record[1]);
      if (`workbench/${relativeRecordPath("ADR", number).split(sep).join("/")}` !== name)
        throw new Error(`${name}: noncanonical record path`);
      numbers.push(number);
    }
    const bytes = read(name);
    total += bytes.length;
    if (files.size >= 4096 || total > collectionByteLimit) throw new Error("collection exceeds acquisition bounds");
    files.set(name, bytes);
  }
  numbers.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const inventory = Object.fromEntries(
    [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, bytes]) => [name, digest(bytes)]),
  );
  const content = digest(JSON.stringify(Object.entries(inventory)));
  const manifest = {
    schema_version: 1,
    id: owner,
    revision: commit,
    visibility,
    content_sha256: content,
    decisions: numbers,
    files: inventory,
  };
  files.set("workbench/collection.toml", Buffer.from(stringify(manifest)));
  const verified = inspectCollectionContents(repository, (name) => {
    const bytes = files.get(name);
    if (!bytes) throw new Error(`${name}: collection file is missing`);
    return bytes;
  });
  // Bind raw source bytes and stable identity, independently of the current TOML writer's formatting.
  return {
    ...verified,
    pin: { ...verified.pin, sha256: digest(JSON.stringify([owner, commit, visibility, Object.entries(inventory)])) },
  };
}

export function acquireGitCollection(
  root: string,
  source: string,
  options: GitCollectionOptions,
): VerifiedCollection & { pin: CollectionPin } {
  if (!collectionCommit.test(options.commit)) throw new Error("supply a full immutable collection Git commit");
  const format = git(root, ["rev-parse", "--show-object-format"]).trim();
  if (format !== (options.commit.length === 64 ? "sha256" : "sha1"))
    throw new Error(
      "collection gitlinks require the source and consuming repository to use the same Git object format",
    );
  const temporary = options.id ? undefined : mkdtempSync(join(tmpdir(), "workbench-collection-fetch-"));
  const repository = options.id ? collectionRepository(root, options.id) : join(temporary ?? "", "repository");
  try {
    return withCacheLockSync(repository, () => {
      fetchCommit(repository, source, options.commit);
      const verified = inspectGitCollection(repository, options.commit, options.collection, options.visibility);
      if (options.id && verified.pin.id !== options.id)
        throw new Error("candidate collection namespace does not match");
      if (options.sha256 && verified.pin.sha256 !== options.sha256)
        throw new Error("candidate collection SHA-256 does not match");
      const destination = collectionRepository(root, verified.pin.id);
      const retain = () => {
        if (destination !== repository) fetchCommit(destination, repository, options.commit);
        repositoryGit(destination, ["update-ref", `refs/workbench/${options.commit}`, options.commit]);
      };
      if (destination === repository) retain();
      else withCacheLockSync(destination, retain);
      return {
        ...verified,
        directory: destination,
        pin: { ...verified.pin, source, commit: options.commit, collection: options.collection ?? "." },
      };
    });
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

export function collectionOriginals(root: string, pin: CollectionPin): VerifiedCollection {
  if (!pin.commit) throw new Error(`${pin.id}: project collections require a Git commit`);
  const original = inspectGitCollection(collectionRepository(root, pin.id), pin.commit, pin.collection, pin.visibility);
  if (
    ["id", "revision", "sha256", "visibility"].some(
      (key) => original.pin[key as keyof CollectionPin] !== pin[key as keyof CollectionPin],
    )
  )
    throw new Error(`${pin.id}: original collection does not match its recorded identity`);
  return original;
}

export function fetchCollectionOriginals(root: string, pin: CollectionPin): void {
  if (!pin.source || !pin.commit) throw new Error("project collection requires a source and full Git commit");
  acquireGitCollection(root, pin.source, {
    commit: pin.commit,
    id: pin.id,
    collection: pin.collection ?? ".",
    sha256: pin.sha256,
    visibility: pin.visibility,
  });
}

/** Preserve unrelated submodules and comments; only owned declarations are generated from project configuration. */
export function collectionGitmodules(root: string, pin: CollectionPin): string {
  if (!pin.source) throw new Error("project collection source is missing");
  const path = ownedPath(root, ".gitmodules");
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const name = collectionSubmoduleName(pin.id);
  if (existsSync(path)) {
    const existing = git(root, ["config", "--file", path, "--list", "--null"]).split("\0").filter(Boolean);
    const configured =
      (
        parse(readFileSync(join(root, "workbench/config.toml"), "utf8")).collections as
          { sources?: CollectionPin[] } | undefined
      )?.sources ?? [];
    if (
      !configured.some((entry) => entry.id === pin.id) &&
      existing.some((entry) => entry.startsWith(`submodule.${name}.`))
    )
      throw new Error(`${name}: preserving an existing submodule declaration; reconcile its ownership explicitly`);
    if (
      existing.some(
        (entry) => entry.endsWith(`\n${collectionSubmodulePath(pin.id)}`) && !entry.startsWith(`submodule.${name}.`),
      )
    )
      throw new Error(`${pin.id}: another submodule owns the reserved collection path`);
  }
  const temporary = mkdtempSync(join(tmpdir(), "workbench-gitmodules-"));
  try {
    const output = join(temporary, "gitmodules");
    writeFileSync(output, original);
    for (const [field, value] of [
      ["path", collectionSubmodulePath(pin.id)],
      ["url", pin.source],
      ["update", "none"],
    ] as const)
      git(root, ["config", "--file", output, "--replace-all", `submodule.${name}.${field}`, value]);
    return readFileSync(output, "utf8");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function validateCollectionSubmodules(root: string, pins: CollectionPin[], indexRoot?: string): void {
  for (const pin of pins) {
    validateCollectionWorkingTree(root, pin.id);
    const values = parseGitmodules(root, pin.id);
    if (values.path !== collectionSubmodulePath(pin.id) || values.url !== pin.source || values.update !== "none")
      throw new Error(`${pin.id}: .gitmodules does not match collection configuration`);
    if (indexRoot) {
      const entry = git(indexRoot, ["ls-files", "--stage", "--", collectionSubmodulePath(pin.id)]).trim();
      if (entry !== `160000 ${pin.commit ?? ""} 0\t${collectionSubmodulePath(pin.id)}`)
        throw new Error(
          `${pin.id}: staged gitlink does not match the configured commit; run workbench collection stage ${pin.id}`,
        );
    }
  }
}

export function validateCollectionWorkingTree(root: string, id: string): void {
  if (!collectionName.test(id)) throw new Error("invalid collection namespace");
  const path = ownedPath(root, collectionSubmodulePath(id));
  if (existsSync(path) && (!lstatSync(path).isDirectory() || readdirSync(path).length))
    throw new Error(`${path}: preserve existing work and deinitialize the collection submodule explicitly`);
}

function parseGitmodules(root: string, id: string): Record<string, string> {
  const path = ownedPath(root, ".gitmodules");
  if (!existsSync(path)) throw new Error("project collection declarations require .gitmodules");
  const output = git(root, [
    "config",
    "--file",
    path,
    "--null",
    "--get-regexp",
    `^submodule\\.${collectionSubmoduleName(id)}\\.`,
  ]);
  const values: Record<string, string> = {};
  for (const entry of output.split("\0").filter(Boolean)) {
    const newline = entry.indexOf("\n");
    const name = entry.slice(0, newline).split(".").at(-1) ?? "";
    if (Object.hasOwn(values, name)) throw new Error(`${id}: duplicate .gitmodules field`);
    values[name] = entry.slice(newline + 1);
  }
  return values;
}

/** The sole explicit index mutation: adoption/reconciliation themselves never stage files. */
export function stageCollectionSubmodules(root: string, pins: CollectionPin[]): void {
  validateCollectionSubmodules(root, pins);
  for (const pin of pins) {
    collectionOriginals(root, pin);
    const path = collectionSubmodulePath(pin.id);
    const existing = git(root, ["ls-files", "--stage", "-z", "--", path]).split("\0").filter(Boolean);
    if (existing.some((entry) => !/^160000 [0-9a-f]+ 0\t/.test(entry) || entry.split("\t")[1] !== path))
      throw new Error(`${path}: preserve existing index entries and resolve their ownership explicitly`);
  }
  // Empty directories represent deinitialized submodules to Git; absent paths look like deletions.
  for (const pin of pins) mkdirSync(ownedPath(root, collectionSubmodulePath(pin.id)), { recursive: true });
  git(
    root,
    ["update-index", "--add", "-z", "--index-info"],
    pins.map((pin) => `160000 ${pin.commit ?? ""}\t${collectionSubmodulePath(pin.id)}\0`).join(""),
  );
}
