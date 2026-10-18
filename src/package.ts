import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import tar from "tar-stream";
import type { Header } from "tar-stream";
import { required } from "./invariants.js";
import { packageOutput } from "./package-output.js";
export { packageOutput } from "./package-output.js";
export { verifyWorkbenchPackage } from "./package-verify.js";
import { distributionSourceFile } from "./distribution-identity.js";

interface PackageMetadata {
  files: string[];
  repository?: string | { url?: string };
  devDependencies?: unknown;
  scripts?: unknown;
  [key: string]: unknown;
}
interface CommittedSource {
  repository: string;
  revision: string;
  files: Map<string, { mode: string; type: string; object: string }>;
}
interface PackageEntry {
  header: Partial<Header> & Pick<Header, "name" | "mode" | "type">;
  name: string;
  bytes?: Buffer;
}
const sourceIdentity = distributionSourceFile;
const generated = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".bundle",
  ".pnpm-store",
  "target",
  "build",
  "dist",
  "coverage",
  ".direnv",
  ".envrc.local",
  ".venv",
  "__pycache__",
  "local.toml",
  ".collections",
  ".local-collections",
]);

function git(root: string, args: string[]) {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  for (const key of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ])
    Reflect.deleteProperty(env, key);
  return spawnSync("git", ["--no-optional-locks", "-C", root, ...args], {
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function cleanRevision(root: string): string | undefined {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root)) return undefined;
  const revision = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (revision.status !== 0 || status.status !== 0 || status.stdout.length) return undefined;
  const value = revision.stdout.trim();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ? value : undefined;
}

function committedSource(root: string, metadata: PackageMetadata): CommittedSource | undefined {
  const revision = cleanRevision(root);
  if (!revision) return undefined;
  const declared = typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url;
  if (typeof declared !== "string") return undefined;
  let repository: URL;
  try {
    repository = new URL(declared.replace(/^git\+/, ""));
  } catch {
    throw new Error("Release repository must be an HTTPS or SSH Git URL without embedded credentials");
  }
  if (
    !["https:", "ssh:"].includes(repository.protocol) ||
    !repository.hostname ||
    repository.password ||
    (repository.protocol === "https:" && repository.username) ||
    repository.search ||
    repository.hash ||
    /[\s\\\p{Cc}]/u.test(declared)
  )
    throw new Error("Release repository must be an HTTPS or SSH Git URL without embedded credentials");
  const tree = git(root, ["ls-tree", "-rz", "--full-tree", revision]);
  if (tree.status !== 0) throw new Error("Cannot inspect committed Workbench source");
  const files: CommittedSource["files"] = new Map();
  for (const entry of tree.stdout.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    if (tab < 0 || !mode || !type || !object) throw new Error("Invalid committed source tree entry");
    files.set(entry.slice(tab + 1), { mode, type, object });
  }
  return { repository: repository.href, revision, files };
}

function verifyCommittedFile(source: CommittedSource, name: string, bytes: Buffer, mode: number, link: boolean): void {
  const tracked = source.files.get(name);
  if (tracked?.type !== "blob") throw new Error(`${name}: package input is not a committed file`);
  const algorithm = source.revision.length === 64 ? "sha256" : "sha1";
  const object = createHash(algorithm)
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest("hex");
  if (
    object !== tracked.object ||
    (link ? tracked.mode !== "120000" : !["100644", "100755"].includes(tracked.mode)) ||
    (!link && process.platform !== "win32" && Boolean(mode & 0o111) !== (tracked.mode === "100755"))
  )
    throw new Error(`${name}: package input differs from its committed bytes or executable mode`);
}

function packageEntries(directory: string): PackageEntry[] {
  const entries: PackageEntry[] = [];
  let total = 0;
  const visit = (name: string): void => {
    const path = join(directory, name);
    const metadata = lstatSync(path);
    const header = {
      name: name ? `workbench/${name.replaceAll(sep, "/")}` : "workbench/",
      uid: 0,
      gid: 0,
      uname: "",
      gname: "",
      mtime: new Date(0),
      mode: name ? metadata.mode & 0o777 : 0o755,
    };
    if (metadata.isDirectory()) {
      entries.push({ header: { ...header, type: "directory" }, name });
      for (const child of readdirSync(path).sort()) visit(name ? join(name, child) : child);
    } else if (metadata.isSymbolicLink()) {
      const linkname = readlinkSync(path);
      const lexical = relative(directory, resolve(dirname(path), linkname));
      if (
        isAbsolute(linkname) ||
        linkname.includes("\\") ||
        isAbsolute(lexical) ||
        lexical === ".." ||
        lexical.startsWith(`..${sep}`)
      )
        throw new Error(`${name}: package link escapes its contents or is not portable`);
      const target = relative(directory, realpathSync(path));
      if (
        isAbsolute(linkname) ||
        linkname.includes("\\") ||
        isAbsolute(target) ||
        target === ".." ||
        target.startsWith(`..${sep}`)
      )
        throw new Error(`${name}: package link escapes its contents or is not portable`);
      entries.push({ header: { ...header, type: "symlink", linkname }, name, bytes: Buffer.from(linkname) });
    } else if (metadata.isFile()) {
      const bytes = readFileSync(path);
      total += bytes.length;
      if (total > 256 * 1024 * 1024) throw new Error("Workbench package exceeds 256 MiB");
      entries.push({ header: { ...header, type: "file", size: bytes.length }, name, bytes });
    } else throw new Error(`${name}: package input must be a file, directory or contained symbolic link`);
  };
  visit("");
  return entries;
}

async function archive(entries: PackageEntry[], source: CommittedSource | undefined): Promise<Buffer> {
  // Git owns executable flags even when a Windows checkout cannot represent them.
  // Read/write bits and directory modes are normalized independently of host umask.
  const headerFor = (entry: PackageEntry): PackageEntry["header"] => ({
    ...entry.header,
    mode:
      entry.header.type === "directory"
        ? 0o755
        : entry.header.type === "symlink"
          ? 0o777
          : (
                source
                  ? source.files.get(entry.name.replaceAll(sep, "/"))?.mode === "100755"
                  : Boolean(entry.header.mode & 0o111)
              )
            ? 0o755
            : 0o644,
  });
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(bytes: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(bytes));
      callback();
    },
  });
  const compression = pipeline(pack, createGzip({ level: 9 }), output);
  const populate = (async () => {
    try {
      for (const entry of entries)
        await new Promise<void>((resolve, reject) => {
          const done = (error?: Error | null) => {
            if (error) reject(error);
            else resolve();
          };
          if (entry.header.type === "file")
            pack.entry(headerFor(entry), required(entry.bytes, "missing file bytes"), done);
          else pack.entry(headerFor(entry), done);
        });
      pack.finalize();
    } catch (error) {
      pack.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  })();
  await Promise.all([compression, populate]);
  const bytes = Buffer.concat(chunks);
  bytes[9] = 255; // Identical gzip headers across build hosts.
  return bytes;
}

/** Build the platform-neutral Node package and a deterministic archive without publishing it. */
export async function prepareWorkbenchPackage(root: string = process.cwd()) {
  // The executable distribution carries runtime assets; project policy is adopted separately.

  const parent = resolve(root, process.env.WORKBENCH_RELEASE_OUTPUT ?? process.env.WORKBENCH_DIST_DIR ?? "dist");
  const destination = join(parent, "workbench");
  const metadataBytes = readFileSync(join(root, "package.json"));
  const parsed = JSON.parse(metadataBytes.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid package metadata");
  const metadata = parsed as PackageMetadata;
  if (
    !Array.isArray(metadata.files) ||
    metadata.files.some(
      (path) =>
        typeof path !== "string" || !path || path === "." || isAbsolute(path) || path.split(/[\\/]/).includes(".."),
    )
  )
    throw new Error("Package files must name relative paths inside the source checkout");
  const source = committedSource(root, metadata);
  let entries: PackageEntry[] = [];
  packageOutput(root, destination, (output: string) => {
    for (const input of metadata.files)
      cpSync(join(root, input), join(output, input), {
        recursive: true,
        verbatimSymlinks: true,
        filter: (path) =>
          !generated.has(basename(path)) && !/\.(?:sw[a-z]|pyc|profraw|profdata|tsbuildinfo|egg-info)$/.test(path),
      });
    if (existsSync(join(output, sourceIdentity)))
      throw new Error(`${sourceIdentity} is reserved for verified source identity`);
    if (source) {
      verifyCommittedFile(source, "package.json", metadataBytes, lstatSync(join(root, "package.json")).mode, false);
      for (const entry of packageEntries(output))
        if (entry.bytes && entry.name !== ".workbench-package.json")
          verifyCommittedFile(
            source,
            entry.name.replaceAll(sep, "/"),
            entry.bytes,
            entry.header.mode,
            entry.header.type === "symlink",
          );
      if (cleanRevision(root) !== source.revision)
        throw new Error("Workbench source changed during packaging; retry with stable inputs");
      writeFileSync(
        join(output, sourceIdentity),
        JSON.stringify({ schema_version: 1, repository: source.repository, revision: source.revision }, null, 2) + "\n",
      );
    }
    const runtime = { ...metadata };
    Reflect.deleteProperty(runtime, "devDependencies");
    Reflect.deleteProperty(runtime, "scripts");
    writeFileSync(join(output, "package.json"), JSON.stringify(runtime, null, 2) + "\n");
    entries = packageEntries(output);
  });
  const bytes = await archive(entries, source);
  const artifacts = join(dirname(destination), "workbench-artifacts");
  packageOutput(root, artifacts, (output: string) => {
    writeFileSync(join(output, "workbench.tar.gz"), bytes);
    writeFileSync(
      join(output, "SHA256SUMS"),
      `${createHash("sha256").update(bytes).digest("hex")}  workbench.tar.gz\n`,
    );
  });
  console.log(`Prepared Node.js package at ${destination} and ${join(artifacts, "workbench.tar.gz")}.`);
  console.log(
    source
      ? `Verified source: ${source.repository}#${source.revision}`
      : "Development package: no verified immutable source identity.",
  );

  return {
    directory: destination,
    archive: join(artifacts, "workbench.tar.gz"),
    source: source ? { repository: source.repository, revision: source.revision } : undefined,
  };
}
