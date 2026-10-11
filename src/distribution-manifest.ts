import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readlinkSync,
  realpathSync,
  readSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { relativePath, ownedPath } from "./paths.js";
import { InvalidInput } from "./input-errors.js";

export const distributionManifest = "workbench-distribution.json";
export const projectPinFile = "workbench/distribution.json";
export interface DistributionPin {
  schema_version: 1;
  revision: string;
  sha256: string;
}
export interface DistributionManifest {
  schema_version: 1;
  revision: string;
  files: Record<string, { sha256: string; executable: boolean } | { link: string }>;
}
export const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const hash = /^[0-9a-f]{64}$/;
const revision = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const referenceMaterial = (path: string): boolean => /^(?:src|tests|examples)(?:\/|$)/.test(path);

export function validateDistributionPin(value: unknown): asserts value is DistributionPin {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidInput("invalid Workbench pin");
  const pin = value as DistributionPin;
  if (
    Object.keys(pin).sort().join(",") !== "revision,schema_version,sha256" ||
    (value as { schema_version: unknown }).schema_version !== 1 ||
    !revision.test(pin.revision) ||
    !hash.test(pin.sha256)
  )
    throw new InvalidInput("Workbench pin requires schema_version = 1, an exact Git revision, and a SHA-256");
}

/** Bound reads and reject redirected regular files before hashing or copying them. */
export function distributionBytes(root: string, path: string, maximum = 64 * 1024 * 1024): Buffer {
  const input = ownedPath(root, path);
  const fd = openSync(
    input,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maximum)
      throw new InvalidInput(`${path}: invalid or oversized distribution file`);
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset !== info.size) throw new InvalidInput(`${path}: distribution changed during verification`);
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function safeLink(root: string, name: string, target: string): void {
  const inside = relative(root, resolve(root, dirname(name), target));
  if (
    !target ||
    target.includes("\0") ||
    isAbsolute(target) ||
    target.includes("\\") ||
    inside === ".." ||
    inside.startsWith(`..${sep}`)
  )
    throw new InvalidInput(`${name}: distribution link escapes its contents`);
  const actual = relative(realpathSync(root), realpathSync(join(root, name)));
  if (actual === ".." || actual.startsWith(`..${sep}`) || isAbsolute(actual))
    throw new InvalidInput(`${name}: distribution link resolves outside its contents`);
}

/** Bound directory enumeration too: an unsealed tree cannot exhaust memory before inventory verification. */
function names(path: string): string[] {
  const directory = opendirSync(path);
  const entries: string[] = [];
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (entries.length >= 16384) throw new InvalidInput("distribution directory exceeds 16384 entries");
      entries.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return entries.sort();
}

/** The seal is produced from prepared distribution files, never by executing their code. */
export function sealDistribution(root: string, selectedRevision: string): DistributionPin {
  if (!revision.test(selectedRevision)) throw new InvalidInput("seal requires an exact Git commit revision");
  const files: DistributionManifest["files"] = {};
  let total = 0;
  let nodes = 0;
  const visit = (directory: string) => {
    if (directory.split("/").length > 64) throw new InvalidInput("distribution directory nesting exceeds 64 levels");
    for (const entry of names(join(root, directory))) {
      if (++nodes > 32768) throw new InvalidInput("distribution tree exceeds 32768 entries");
      const name = directory ? `${directory}/${entry}` : entry;
      if (name === distributionManifest) continue;
      if (entry === ".git" || entry === "node_modules" || entry === ".local-collections" || entry === ".collections")
        throw new InvalidInput(`${name}: seal a prepared distribution without local or dependency state`);
      relativePath(name, "distribution inventory");
      const info = lstatSync(join(root, name));
      if (info.isSymbolicLink()) {
        const link = readlinkSync(join(root, name)).replaceAll("\\", "/");
        safeLink(root, name, link);
        files[name] = { link };
      } else if (info.isDirectory()) visit(name);
      else {
        const bytes = distributionBytes(root, name);
        total += bytes.length;
        if (total > 256 * 1024 * 1024) throw new InvalidInput("distribution exceeds 256 MiB");
        files[name] = { sha256: digest(bytes), executable: !!(info.mode & 0o111) };
      }
      if (Object.keys(files).length > 16384) throw new InvalidInput("distribution inventory exceeds 16384 entries");
    }
  };
  visit("");
  const bytes = JSON.stringify({ schema_version: 1, revision: selectedRevision, files }, null, 2) + "\n";
  writeFileSync(ownedPath(root, distributionManifest), bytes, { flag: "wx" });
  return inspectDistribution(root).pin;
}

export function inspectDistribution(
  root: string,
  expected?: DistributionPin,
): { pin: DistributionPin; manifest: DistributionManifest } {
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new InvalidInput("distribution must be a real directory");
  const bytes = distributionBytes(root, distributionManifest, 8 * 1024 * 1024);
  const manifest = JSON.parse(bytes.toString("utf8")) as DistributionManifest;
  const pin: DistributionPin = { schema_version: 1, revision: manifest.revision, sha256: digest(bytes) };
  validateDistributionPin(pin);
  if (expected && (expected.sha256 !== pin.sha256 || expected.revision !== pin.revision))
    throw new InvalidInput("installed Workbench identity does not match the project pin");
  if (
    Object.keys(manifest).sort().join(",") !== "files,revision,schema_version" ||
    (manifest as { schema_version: unknown }).schema_version !== 1 ||
    !(manifest as { files: unknown }).files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files) ||
    !Object.keys(manifest.files).length ||
    Object.keys(manifest.files).length > 16384
  )
    throw new InvalidInput("invalid Workbench distribution inventory");
  for (const required of ["bin/workbench.mjs", "bundle/main.cjs", "languages/index.toml", "workbench/projects.toml"])
    if (!Object.hasOwn(manifest.files, required)) throw new InvalidInput(`distribution is missing ${required}`);
  const directories = new Set<string>();
  for (const name of Object.keys(manifest.files)) {
    if (name.length > 4096) throw new InvalidInput("distribution path exceeds 4096 characters");
    relativePath(name, "distribution inventory");
    const parts = name.split("/");
    if (parts.length > 64) throw new InvalidInput("distribution directory nesting exceeds 64 levels");
    for (let index = 1; index < parts.length; index++) {
      directories.add(parts.slice(0, index).join("/"));
      if (directories.size > 32768) throw new InvalidInput("distribution tree exceeds 32768 directories");
    }
  }
  let nodes = 0;
  const verifyNames = (directory: string) => {
    if (directory.split("/").length > 64) throw new InvalidInput("distribution directory nesting exceeds 64 levels");
    for (const entry of names(join(root, directory))) {
      if (++nodes > 32768) throw new InvalidInput("distribution tree exceeds 32768 entries");
      const name = directory ? `${directory}/${entry}` : entry;
      if (name === distributionManifest) continue;
      const info = lstatSync(join(root, name));
      if (info.isDirectory() && !info.isSymbolicLink()) {
        if (!directories.has(name)) {
          if (names(join(root, name)).length) throw new InvalidInput(`${name}: unsealed distribution directory`);
        } else verifyNames(name);
      } else if (!Object.hasOwn(manifest.files, name)) throw new InvalidInput(`${name}: unsealed distribution file`);
    }
  };
  verifyNames("");
  let total = 0;
  for (const [name, item] of Object.entries(manifest.files)) {
    relativePath(name, "distribution inventory");
    if (name === distributionManifest || !(item as unknown) || typeof item !== "object")
      throw new InvalidInput("invalid inventory entry");
    if (referenceMaterial(name) && !existsSync(join(root, name.split("/")[0] ?? ""))) continue;
    if ("link" in item) {
      if (Object.keys(item).join(",") !== "link" || typeof item.link !== "string")
        throw new InvalidInput("invalid distribution link");
      safeLink(root, name, item.link);
      ownedPath(root, dirname(name));
      if (
        !lstatSync(join(root, name)).isSymbolicLink() ||
        readlinkSync(join(root, name)).replaceAll("\\", "/") !== item.link
      )
        throw new InvalidInput(`${name}: distribution link differs from its seal`);
    } else {
      if (
        Object.keys(item).sort().join(",") !== "executable,sha256" ||
        !hash.test(item.sha256) ||
        typeof item.executable !== "boolean"
      )
        throw new InvalidInput("invalid distribution file digest");
      if (process.platform !== "win32" && !!(lstatSync(ownedPath(root, name)).mode & 0o111) !== item.executable)
        throw new InvalidInput(`${name}: executable permission differs from its seal`);
      const contents = distributionBytes(root, name);
      total += contents.length;
      if (total > 256 * 1024 * 1024 || digest(contents) !== item.sha256)
        throw new InvalidInput(`${name}: distribution content differs from its seal`);
    }
  }
  return { pin, manifest };
}

export function readDistributionPin(root: string): DistributionPin | undefined {
  const path = ownedPath(root, projectPinFile);
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(distributionBytes(root, projectPinFile, 4096).toString("utf8"));
  validateDistributionPin(value);
  return value;
}

/** Cache identities remain available when optional reference sources are omitted. */
export function distributionInputHash(root: string, name: string): string {
  if (existsSync(join(root, name))) return digest(distributionBytes(root, name));
  const manifest = JSON.parse(distributionBytes(root, distributionManifest).toString("utf8")) as DistributionManifest;
  const entry = manifest.files[name];
  if (!entry || !("sha256" in entry)) throw new InvalidInput(`distribution input is missing: ${name}`);
  return entry.sha256;
}
