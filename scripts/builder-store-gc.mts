import { isMainScript } from "./script-entry.mjs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  managedStorePin,
  partialManagedStorePin,
  storePrefix,
  type StoreManager,
} from "../app/src/core/execution/environments/managed/managed-contract.mjs";

const inputIdentity = /^[a-f0-9]{64}$/;
const markerText = '{"version":1}\n';

function storeTargets(store: string, targets: readonly string[]): string[] {
  const base = realpathSync(store);
  return [
    ...new Set(
      targets.map((target) => {
        const local = relative(base, realpathSync(target));
        if (!local || isAbsolute(local) || local === ".." || local.startsWith(".." + sep))
          throw new Error(`Builder GC target is outside its store: ${target}`);
        const item = local.split(sep)[0];
        if (!item || !/^[a-z0-9]{32}-[^/]+$/.test(item)) throw new Error(`Invalid builder store target: ${target}`);
        return join(store, item);
      }),
    ),
  ];
}

function rootMarker(directory: string): string {
  if (lstatSync(directory, { throwIfNoEntry: false }) && realpathSync(directory) !== directory)
    throw new Error("Builder GC root namespace must be a real directory");
  return join(directory, ".workbench-roots.json");
}

function validateRootMarker(marker: string): void {
  if (!lstatSync(marker, { throwIfNoEntry: false })?.isFile() || readFileSync(marker, "utf8") !== markerText)
    throw new Error("Invalid builder GC ownership marker");
}

function generationRoots(directory: string) {
  if (!lstatSync(directory).isDirectory()) throw new Error("Builder GC generation must be a real directory");
  const entries = readdirSync(directory);
  if (
    entries.some(
      (name) => (!/^\d+$/.test(name) && name !== "archive") || !lstatSync(join(directory, name)).isSymbolicLink(),
    )
  )
    throw new Error("Builder GC generation contains unexpected files");
  return entries
    .filter((name) => name !== "archive")
    .sort((a, b) => Number(a) - Number(b))
    .map((name) => {
      const target = readlinkSync(join(directory, name));
      return { name, target };
    });
}

/** GC roots belong to this private store; publishing a new set never removes the previous working set first. */
export function retainStoreRoots(options: {
  store: string;
  directory: string;
  inputs: string;
  targets: readonly string[];
  archive?: string;
}): { roots: string[]; archive?: string } {
  if (!inputIdentity.test(options.inputs)) throw new Error("Invalid builder store retention identity");
  const targets = storeTargets(options.store, options.targets);
  const archive = options.archive === undefined ? undefined : storeTargets(options.store, [options.archive])[0];
  if (!targets.length) throw new Error("Builder GC requires retained runtime and profile roots");
  if (archive && targets.includes(archive)) throw new Error("Image archive must have a separate staging root");
  const marker = rootMarker(options.directory);
  mkdirSync(options.directory, { recursive: true });
  if (lstatSync(marker, { throwIfNoEntry: false })) {
    validateRootMarker(marker);
  } else {
    if (readdirSync(options.directory).length) throw new Error("Builder GC root namespace is not owned by Workbench");
    // codeql[js/file-system-race] Exclusive creation (wx) rejects a concurrent marker; it cannot overwrite an existing file.
    writeFileSync(marker, markerText, { flag: "wx", mode: 0o600 });
  }
  const destination = join(options.directory, options.inputs);
  const stage = join(options.directory, partialManagedStorePin(options.inputs));
  const stageExists = lstatSync(stage, { throwIfNoEntry: false });
  if (!lstatSync(destination, { throwIfNoEntry: false })) {
    const previous = stageExists ? generationRoots(stage) : [];
    if (previous.some(({ name, target }) => String(Number(name)) !== name || targets[Number(name)] !== target))
      throw new Error("Incomplete builder GC targets changed for the same image inputs");
    const archiveLink = join(stage, "archive");
    const previousArchive = lstatSync(archiveLink, { throwIfNoEntry: false });
    if (previousArchive && readlinkSync(archiveLink) !== archive)
      throw new Error("Incomplete builder GC archive changed for the same image inputs");
    if (!stageExists) mkdirSync(stage);
    const existing = new Set(previous.map(({ name }) => name));
    targets.forEach((target, index) => {
      const name = String(index);
      if (!existing.has(name))
        symlinkSync(target, join(stage, name), lstatSync(target).isDirectory() ? "junction" : "file");
    });
    if (archive && !previousArchive) symlinkSync(archive, archiveLink, "file");
    renameSync(stage, destination);
  } else {
    if (stageExists) throw new Error("Conflicting complete and incomplete builder GC roots");
    const previous = generationRoots(destination);
    if (
      previous.length !== targets.length ||
      previous.some(({ name, target }, index) => name !== String(index) || target !== targets[index])
    )
      throw new Error("Builder GC targets changed for the same image inputs");
    if (archive) {
      const path = join(destination, "archive");
      const existing = lstatSync(path, { throwIfNoEntry: false });
      if (!existing) symlinkSync(archive, path, "file");
      else if (!existing.isSymbolicLink() || readlinkSync(path) !== archive)
        throw new Error("Builder GC archive changed for the same image inputs");
    }
  }
  return { roots: targets, ...(archive ? { archive } : {}) };
}

function ownerRoots(builder: StoreManager, owner: string): string {
  if (!inputIdentity.test(owner)) throw new Error("Invalid builder store owner");
  return join(builder === "guix" ? "/var/guix/gcroots/workbench" : "/nix/var/nix/gcroots/workbench", owner);
}

/** A journaled host operation supplies expected link targets and the exact generation to retire. */
export function releaseStoreRoots(
  directory: string,
  inputs: string,
  pin: { roots: string[]; archive: string },
  release: "archive" | "generation",
): void {
  if (!inputIdentity.test(inputs)) throw new Error("Invalid builder store input identity");
  validateRootMarker(rootMarker(directory));
  const generation = join(directory, inputs),
    retired = join(directory, `.retiring-${inputs}`);
  const live = lstatSync(generation, { throwIfNoEntry: false });
  const pending = lstatSync(retired, { throwIfNoEntry: false });
  if (live && pending) throw new Error("Conflicting builder store retirement");
  if (!live && !pending) {
    if (release === "generation") return;
    throw new Error("Builder profile roots disappeared");
  }
  const selected = pending ? retired : generation;
  const roots = generationRoots(selected);
  if (
    !pending &&
    (roots.length !== pin.roots.length ||
      roots.some(({ name, target }, index) => name !== String(index) || target !== pin.roots[index]))
  )
    throw new Error("Builder profile roots changed before retirement");
  // A crash while unlinking a retired directory may leave a subset of its recorded links.
  if (pending && (release !== "generation" || roots.some(({ name, target }) => pin.roots[Number(name)] !== target)))
    throw new Error("Builder retirement contents changed");
  const archive = join(selected, "archive"),
    metadata = lstatSync(archive, { throwIfNoEntry: false });
  if (metadata && (!metadata.isSymbolicLink() || readlinkSync(archive) !== pin.archive))
    throw new Error("Builder archive root changed before retirement");
  if (release === "archive") {
    if (pin.roots.some((target) => !existsSync(target))) throw new Error("Builder profile closure is unavailable");
    if (metadata) rmSync(archive);
  } else {
    if (live) renameSync(generation, retired);
    rmSync(retired, { recursive: true });
  }
}

/** Only isolated managed store operations call this script. */
export function pinPrivateBuilderStore(builder: StoreManager): void {
  const owner = process.env.WORKBENCH_PREPARATION_OWNER;
  if (
    !existsSync("/.dockerenv") ||
    !/^[a-f0-9]{24}$/.test(process.env.WORKBENCH_PRIVATE_BUILDER ?? "") ||
    !owner ||
    !inputIdentity.test(owner)
  )
    throw new Error("Builder store GC requires an owned private Docker builder");
  const output = process.env.WORKBENCH_MANAGED_OUTPUT ?? "/output";
  const profiles: unknown = JSON.parse(
    readFileSync(join(output, builder === "guix" ? "guix-profiles.json" : "profiles.json"), "utf8"),
  );
  if (!Array.isArray(profiles)) throw new Error("Missing builder profile roots");
  const targets: string[] = profiles.flatMap((profile: unknown) => {
    if (builder === "nix" && typeof profile === "string") return [profile];
    if (
      builder === "guix" &&
      profile &&
      typeof profile === "object" &&
      "profile" in profile &&
      "runtime" in profile &&
      "manager" in profile &&
      typeof profile.profile === "string" &&
      typeof profile.runtime === "string" &&
      typeof profile.manager === "string"
    )
      return [profile.profile, profile.runtime, profile.manager];
    throw new Error("Invalid builder profile roots");
  });
  targets.push(...(builder === "guix" ? ["/opt/workbench-guix"] : ["/opt/workbench-bootstrap", "/opt/nix-runtime"]));
  const pin = retainStoreRoots({
    store: storePrefix(builder),
    directory: ownerRoots(builder, owner),
    inputs: process.env.WORKBENCH_IMAGE_INPUTS ?? "",
    targets,
    archive: readFileSync(join(output, "image-path"), "utf8").trim(),
  });
  writeFileSync(
    join(output, "store-pin.json"),
    JSON.stringify(managedStorePin({ ...pin, builder, key: process.env.WORKBENCH_PRIVATE_BUILDER })),
  );
}

if (isMainScript(import.meta.url)) {
  const builder = process.argv[2];
  if (builder !== "guix" && builder !== "nix") throw new Error("Expected nix or guix builder");
  const [, , , operation, owner, inputs, encoded] = process.argv;
  if (operation === "archive" || operation === "generation") {
    if (!existsSync("/.dockerenv") || !owner || !inputs || !encoded)
      throw new Error("Managed store retirement requires an isolated builder");
    const pin = managedStorePin(JSON.parse(encoded));
    if (pin.builder !== builder) throw new Error("Managed store retirement manager changed");
    releaseStoreRoots(ownerRoots(builder, owner), inputs, pin, operation);
  } else if (operation === undefined) pinPrivateBuilderStore(builder);
  else throw new Error("Unknown managed store operation");
}
