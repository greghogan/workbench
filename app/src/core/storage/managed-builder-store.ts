import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dockerQuery } from "../artifacts/docker-query.js";
import { imageDigest } from "../artifacts/image-contract.js";
import {
  managedStoreCleanupActivity,
  managedStoreCleanupLabel,
  managedStoreDirectory,
  type StoreManager,
} from "../execution/environments/managed/managed-contract.mjs";
import { ownedPath } from "../runtime/paths.js";
import { userDirectory } from "./storage.js";
import { inspectCacheMetadataLock, CacheBusy, CacheLockState } from "./cache-lock.js";
import { measureCacheSize, savedSize } from "./cache-size.js";
import type { BuilderCacheEntry } from "./builder-cache.js";
import { readBoundedFile } from "../runtime/file-reads.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { inspectProcessLock } from "./process-lock.js";

const storeMarker = ".workbench-store.json";
const targets = { nix: { store: "/nix" }, guix: { store: "/gnu", state: "/var/guix" } };
const bootstrapPaths = { nix: ["/opt/workbench-bootstrap", "/opt/nix-runtime"], guix: ["/opt/workbench-guix"] };
const trustPaths = { nix: "/etc/nix/nix.conf", guix: "/etc/guix/acl" };

export function managedStoreVolumes(builder: StoreManager, key: string) {
  return Object.entries(targets[builder]).map(([role, destination]) => ({
    role,
    name: `workbench-managed-${builder}-${key}-${role}`,
    destination,
  }));
}

function makeOwnedDirectory(path: string, role: string): void {
  mkdirSync(path, { mode: 0o700, recursive: true });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o022)
    throw new Error(`${path}: ${role} must be a real, user-owned directory with private write access`);
}

export function mountFields(...fields: string[]): string {
  return fields.map((field) => `"${field.replaceAll('"', '""')}"`).join(",");
}

export function managedStoreGeneration(builder: StoreManager, key: string): string {
  if (!/^[a-f0-9]{24}$/.test(key)) throw new Error("Invalid managed store generation");
  const cache = userDirectory("cache");
  return ownedPath(cache, `managed-stores/${builder}/${key}`);
}

export function managedStoreMaintenanceImage(directory: string): string {
  const image = readBoundedFile(ownedPath(directory, ".workbench-maintenance-image"), 128, "managed store bootstrap")
    .toString()
    .trim();
  if (!imageDigest.test(image)) throw new Error(`${directory}: invalid managed store bootstrap`);
  return image;
}

/** A Unix socket may front a different engine. Prove it can see this process's cache before creating any mounts. */
async function inspectBootstrap(root: string, builder: keyof typeof targets, image: string) {
  const directory = mkdtempSync(join(root, ".probe-"));
  const token = randomUUID();
  const trustPath = trustPaths[builder];
  try {
    writeFileSync(join(directory, "token"), token + "\n", { mode: 0o644 });
    const output = await dockerQuery([
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--mount",
      mountFields("type=bind", `src=${directory}`, "dst=/workbench-store-probe", "readonly"),
      "--entrypoint",
      "/bin/sh",
      image,
      "-ec",
      `cat /workbench-store-probe/token; if [ -r ${trustPath} ]; then sha256sum < ${trustPath}; else printf 'default\n'; fi; readlink -f ${bootstrapPaths[builder].join(" ")}`,
    ]);
    const [observed, trust, ...closure] = output.split("\n");
    const prefix = builder === "nix" ? "/nix/store/" : "/gnu/store/";
    if (
      observed !== token ||
      !trust ||
      (trust !== "default" && !/^[a-f0-9]{64}\s+-$/.test(trust)) ||
      closure.length !== bootstrapPaths[builder].length ||
      closure.some((path) => !path.startsWith(prefix) || !/^[a-z0-9]{32}-[^/]+$/.test(path.slice(prefix.length)))
    )
      throw new Error("Cannot verify the local cache mount and store bootstrap");
    return { closure, trust };
  } catch (cause) {
    throw new Error("The Docker engine must be able to bind the configured Workbench cache from its host", { cause });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

/** The parent holds the manager's preparation lock through container shutdown and image import. */
export async function prepareManagedBuilderStore(
  builder: string,
  image: string,
  { expectedKey, cleanup = false }: { expectedKey?: string; cleanup?: boolean } = {},
) {
  if ((builder !== "nix" && builder !== "guix") || !imageDigest.test(image))
    throw new Error("Managed store preparation requires a manager and an immutable bootstrap image");
  const cache = userDirectory("cache");
  const activity = managedStoreCleanupActivity(cache, builder);
  if (!cleanup && lstatSync(activity, { throwIfNoEntry: false })) {
    if (
      !inspectProcessLock(activity).abandoned ||
      (await dockerQuery(["ps", "--all", "--quiet", "--filter", `label=${managedStoreCleanupLabel}=${builder}`]))
    )
      throw new CacheBusy(`Managed ${builder} cleanup is active or needs recovery: ${activity}`);
  }
  makeOwnedDirectory(cache, "Workbench cache");
  const base = realpathSync(cache);
  ownedPath(base, `managed-stores/${builder}`);
  const root = managedStoreDirectory(base, builder);
  makeOwnedDirectory(root, "managed stores");
  const engine = await dockerQuery(["info", "--format", "{{.ID}}"]);
  if (!engine) throw new Error("Cannot identify the Docker engine for the managed store");
  const compatibility = await inspectBootstrap(root, builder, image);
  const key = createHash("sha256")
    .update(JSON.stringify([root, engine, process.arch, compatibility]))
    .digest("hex")
    .slice(0, 24);
  if (expectedKey !== undefined && key !== expectedKey)
    throw new Error("Managed store bootstrap or Docker engine changed");
  const directory = ownedPath(root, key);
  if (expectedKey !== undefined && !lstatSync(directory, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`${directory}: managed store generation is unavailable`);
  makeOwnedDirectory(directory, "managed store generation");
  const marker = ownedPath(directory, storeMarker);
  const record = JSON.stringify({ version: 1, builder, engine, key, ...compatibility }) + "\n";
  if (lstatSync(marker, { throwIfNoEntry: false })) {
    const info = lstatSync(marker);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.size > 4096 ||
      readFileSync(marker, "utf8") !== record
    )
      throw new Error(`${directory}: managed store ownership or bootstrap changed`);
  } else {
    if (expectedKey !== undefined || readdirSync(directory).length)
      throw new Error(`${directory}: managed store ownership is unknown`);
    writeFileSync(marker, record, { flag: "wx", mode: 0o600 });
  }
  const volumes = managedStoreVolumes(builder, key);
  for (const { name, role } of volumes) {
    const device = ownedPath(directory, role);
    // The daemon can set package-manager ownership when Docker initializes this empty mount.
    if (expectedKey === undefined) mkdirSync(device, { mode: 0o755, recursive: true });
    if (!lstatSync(device).isDirectory()) throw new Error(`${device}: expected a directory`);
    await dockerQuery([
      "volume",
      "create",
      "--driver",
      "local",
      "--opt",
      "type=none",
      "--opt",
      "o=bind",
      "--opt",
      `device=${device}`,
      name,
    ]);
    const actual: unknown = JSON.parse(await dockerQuery(["volume", "inspect", "--format", "{{json .Options}}", name]));
    if (
      !actual ||
      typeof actual !== "object" ||
      !("type" in actual) ||
      actual.type !== "none" ||
      !("o" in actual) ||
      actual.o !== "bind" ||
      !("device" in actual) ||
      actual.device !== device
    )
      throw new Error(`${name}: Docker volume does not match its owned backing directory`);
  }
  if (expectedKey === undefined) {
    await dockerQuery(["image", "tag", image, `workbench-managed-store:${builder}-${key}`]);
    writeAtomic(ownedPath(directory, ".workbench-maintenance-image"), image + "\n", 0o600);
  }
  return { key, directory, volumes: volumes.map(({ name, destination }) => ({ name, destination })) };
}

/** Host data remains visible even if Docker has already removed every volume registration. */
export async function inspectManagedBuilderStores(signal?: AbortSignal, measure = true): Promise<BuilderCacheEntry[]> {
  const entries: BuilderCacheEntry[] = [];
  const cache = userDirectory("cache");
  for (const builder of ["nix", "guix"]) {
    signal?.throwIfAborted();
    const directory = ownedPath(cache, `managed-stores/${builder}`);
    if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
    const lock = inspectCacheMetadataLock(directory);
    const previous = savedSize(directory);
    const size =
      measure && lock.state === CacheLockState.Unlocked ? await measureCacheSize(previous, false, signal) : previous;
    entries.push({
      key: `managed-${builder}`,
      builder,
      label: `Managed ${builder === "nix" ? "Nix" : "Guix"} store`,
      directory,
      volumes: [],
      bytes: size.bytes,
      blockedBy:
        lock.state === CacheLockState.Unlocked
          ? "shared store requires profile-aware pruning"
          : "managed store is busy or needs recovery",
    });
  }
  return entries;
}
