import {
  collectionBytes,
  collectionWorkingFiles,
  policyFilesHash,
  collectionByteLimit,
  collectionCharterPath,
  validateCollectionCharter,
} from "./collection-files.js";
export { collectionBytes } from "./collection-files.js";
import { readDecision, referencedDecisions, linkedDecisionPaths } from "./decision-record.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parse, stringify } from "smol-toml";
import { normalizedNumber, readConfig, readProjects, relativeRecordPath, writeAtomic } from "./core.js";
import { ownedPath } from "./paths.js";
import { localConfiguration } from "./environments.js";
import { userDirectory } from "./storage.js";
import { readUserConfig } from "./user-config.js";
import {
  collectionHash,
  collectionName,
  collectionRevision,
  collectionTable,
  validateCollectionIdentity,
  validateCollectionPins,
  type CollectionIdentity,
  type CollectionManifest,
  type CollectionPin,
} from "./collection-schema.js";
import { InvalidInput } from "./input-errors.js";
import { terminalTable } from "./terminal-table.js";
import { formatByteCount } from "./byte-size.js";

export interface VerifiedCollection {
  pin: CollectionPin;
  directory: string;
  manifest: CollectionManifest;
  files: Map<string, Buffer>;
}
export type ResolvedCollection =
  (VerifiedCollection & { local: true }) | { pin: CollectionPin; directory: string; local: false };
/** A proposed pin replaces only its owning declaration while ordinary resolution checks the combined result. */
export type CollectionSelection =
  { installation: "project"; pins: CollectionPin[] } | { installation: "local"; pins: CollectionPin[]; base: string };

export const hasCollectionProject = (root: string): boolean =>
  existsSync(join(root, "workbench/config.toml")) || existsSync(join(root, "workbench/projects.toml"));
const manifestPath = "workbench/collection.toml";
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const contentHash = (files: Record<string, string>) =>
  sha256(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
export const appliesWithin = (parent: string, child: string) =>
  parent === "." || parent === child || child.startsWith(`${parent}/`);

/** Local guidance registries use portable verified pins. */
export function registryPins(base: string): CollectionPin[] {
  const path = ownedPath(base, "index.toml");
  if (!existsSync(path)) return [];
  const document = collectionTable(
    parse(collectionBytes(base, "index.toml").toString("utf8")),
    ["schema_version", "sources"],
    path,
  );
  if (document.schema_version !== 1) throw new InvalidInput(`${path}: unsupported collection registry schema`);
  validateCollectionPins(document.sources, path);
  return document.sources as CollectionPin[];
}

export function collectionPins(root: string, replacements?: CollectionPin[]): CollectionPin[] {
  const configured = hasCollectionProject(root);
  const current = configured ? (readConfig(root).collections?.sources ?? []) : [];
  const pins = replacements
    ? [...current.filter((pin) => !replacements.some((replacement) => replacement.id === pin.id)), ...replacements]
    : current;
  const paths = new Set(configured ? readProjects(root).map((project) => project.path) : ["."]);
  for (const pin of pins) {
    if (new Set(pin.scopes).size !== pin.scopes.length || pin.scopes.some((scope) => !paths.has(scope)))
      throw new InvalidInput(`collection '${pin.id}': scopes must name distinct registered project paths`);
  }
  return pins;
}

/** System locations follow the same platform rules for installation and discovery. */
export function systemCollectionDirectories(): string[] {
  if (process.platform === "linux")
    return (process.env.XDG_DATA_DIRS?.trim() ? process.env.XDG_DATA_DIRS : "/usr/local/share:/usr/share")
      .split(":")
      .filter(isAbsolute)
      .map((path) => join(path, "workbench/collections"));
  if (process.platform === "darwin") return ["/Library/Application Support/workbench/collections"];
  return process.env.PROGRAMDATA && isAbsolute(process.env.PROGRAMDATA)
    ? [join(process.env.PROGRAMDATA, "workbench/collections")]
    : [];
}

/** Installed registries apply locally; repository exports are resolved separately. */
export function globalCollectionDirectories(): string[] {
  return [
    ...new Set([
      ...((readUserConfig()["collections.directories"] as string[] | undefined) ?? []),
      join(userDirectory("data"), "collections"),
      ...systemCollectionDirectories(),
    ]),
  ];
}

export function localCollectionDirectories(root: string): string[] {
  if (process.env.WORKBENCH_COLLECTIONS_MATERIALIZED === "1") return [join(root, "workbench/.collections")];
  const owner = process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? root;
  return [
    ...new Set([
      join(owner, "workbench/.local-collections"),
      ...(localConfiguration(root).collections?.directories ?? []),
      ...globalCollectionDirectories(),
    ]),
  ];
}

/** Hash the manifest and every explicitly exported file; unrelated provider records are ignored. */
export function inspectCollection(directory: string, expected?: CollectionIdentity): VerifiedCollection {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new InvalidInput(`${directory}: expected a real collection directory`);
  return inspectCollectionContents(directory, (name) => collectionBytes(directory, name), expected);
}

/** The same inventory and record checks apply to working files and Git blobs. */
export function inspectCollectionContents(
  directory: string,
  read: (name: string) => Buffer,
  expected?: CollectionIdentity,
): VerifiedCollection {
  const bytes = read(manifestPath);
  const manifest = collectionTable(
    parse(bytes.toString("utf8")),
    ["schema_version", "id", "revision", "visibility", "content_sha256", "decisions", "files"],
    manifestPath,
  ) as unknown as CollectionManifest;
  const identity = {
    id: manifest.id,
    revision: manifest.revision,
    visibility: manifest.visibility,
    sha256: sha256(bytes),
  };
  validateCollectionIdentity(identity, manifestPath);
  if (expected && (["id", "revision", "sha256", "visibility"] as const).some((key) => identity[key] !== expected[key]))
    throw new InvalidInput(`collection '${expected.id}': installed identity or SHA-256 does not match pin`);
  if (manifest.schema_version !== 1) throw new InvalidInput(`${directory}: unsupported collection manifest schema`);
  const fileInventory: unknown = manifest.files;
  if (!fileInventory || typeof fileInventory !== "object" || Array.isArray(fileInventory))
    throw new InvalidInput(`${directory}: expected collection files`);
  if (!Object.hasOwn(manifest.files, collectionCharterPath))
    throw new InvalidInput(
      `${directory}: collection charter is missing from the published inventory; preserve this snapshot, supply a human-written charter, and review a replacement collection`,
    );
  const entries = Object.entries(manifest.files);
  if (
    !entries.length ||
    entries.length > 4096 ||
    !collectionHash.test(manifest.content_sha256) ||
    contentHash(manifest.files) !== manifest.content_sha256
  )
    throw new InvalidInput(`${directory}: invalid collection content digest or inventory`);
  if (
    !Array.isArray(manifest.decisions) ||
    !manifest.decisions.length ||
    new Set(manifest.decisions).size !== manifest.decisions.length
  )
    throw new InvalidInput(`${directory}: expected distinct exported decisions`);
  const allowed = new Set([collectionCharterPath, "workbench/decision-map.md"]);
  const supportingDirectories: string[] = [];
  for (const number of manifest.decisions) {
    if (typeof number !== "string" || normalizedNumber(number) !== number)
      throw new InvalidInput(`${directory}: invalid exported decision identity`);
    const record = `workbench/${relativeRecordPath("ADR", number).split(sep).join("/")}`;
    allowed.add(record);
    supportingDirectories.push(`${record.slice(0, -3)}/`);
  }
  if (
    [...allowed].some((path) => !Object.hasOwn(manifest.files, path)) ||
    entries.some(
      ([path, digest]) =>
        (!allowed.has(path) && !supportingDirectories.some((prefix) => path.startsWith(prefix))) ||
        !collectionHash.test(digest),
    )
  )
    throw new InvalidInput(
      `${directory}: inventory must contain the collection charter, exported ADRs and map, with only their supporting files`,
    );
  const files = new Map<string, Buffer>([[manifestPath, bytes]]);
  let total = 0;
  for (const [name, digest] of entries) {
    const content = read(name);
    total += content.length;
    if (total > collectionByteLimit || sha256(content) !== digest)
      throw new InvalidInput(`${directory}: exported collection content failed verification`);
    files.set(name, content);
  }
  const charter = files.get(collectionCharterPath);
  validateCollectionCharter(charter, directory);
  const allowedPaths = new Set([...files.keys()].map((name) => resolve(directory, name)));
  if (
    linkedDecisionPaths({ path: join(directory, collectionCharterPath), contents: charter.toString("utf8") }).some(
      (path) => !allowedPaths.has(path),
    )
  )
    throw new InvalidInput(`${identity.id}: collection charter links outside its self-contained export`);
  for (const number of manifest.decisions) {
    const name = `workbench/${relativeRecordPath("ADR", number).split(sep).join("/")}`;
    const bytes = files.get(name);
    if (!bytes) throw new InvalidInput("exported decision is missing");
    const decision = readDecision(
      { id: identity.id, path: "." },
      number,
      join(directory, name),
      bytes.toString("utf8"),
    );
    for (const reference of referencedDecisions(decision)) {
      const target = reference.split("ADR-")[1] ?? "";
      if (!reference.startsWith(`${identity.id}:ADR-`) || !manifest.decisions.includes(target))
        throw new InvalidInput(`${identity.id}: collection references outside its self-contained export: ${reference}`);
      if (target.length > number.length || (target.length === number.length && target >= number))
        throw new InvalidInput(`${identity.id}: ADR references must name an earlier decision: ${reference}`);
    }
    if (linkedDecisionPaths(decision).some((path) => !allowedPaths.has(path)))
      throw new InvalidInput(`${identity.id}: collection links outside its self-contained export`);
  }
  return { directory, manifest, files, pin: { ...identity, scopes: ["."] } };
}

export function resolveLocalCollections(
  root: string,
  selection?: CollectionSelection,
): (VerifiedCollection & { local: true })[] {
  const resolved: (VerifiedCollection & { local: true })[] = [];
  const directories = new Set([
    ...localCollectionDirectories(root).map((base) => resolve(base)),
    ...(selection?.installation === "local" ? [resolve(selection.base)] : []),
  ]);
  for (const base of directories) {
    const current = registryPins(base);
    const pins =
      selection?.installation === "local" && base === resolve(selection.base)
        ? [
            ...current.filter((pin) => !selection.pins.some((replacement) => replacement.id === pin.id)),
            ...selection.pins,
          ]
        : current;
    for (const pin of pins) {
      const collection = {
        ...inspectCollection(ownedPath(base, `${pin.id}/${pin.revision}`), {
          id: pin.id,
          revision: pin.revision,
          sha256: pin.sha256,
          visibility: pin.visibility,
        }),
        pin,
        local: true as const,
      };
      if (pin.scopes.length !== 1 || pin.scopes[0] !== ".")
        throw new InvalidInput(`${base}: local installations must cover their entire installation scope`);
      resolved.push(collection);
    }
  }
  return resolved;
}

export function resolveCollections(
  root: string,
  includeLocal = true,
  selection?: CollectionSelection,
): ResolvedCollection[] {
  const resolved: ResolvedCollection[] = collectionPins(
    root,
    selection?.installation === "project" ? selection.pins : undefined,
  ).map((pin) => {
    const directory = ownedPath(root, `workbench/collections/${pin.id}`);
    if (!existsSync(directory)) throw new InvalidInput(`editable collection is missing: ${pin.id}`);
    const charter = "CHARTER.md";
    validateCollectionCharter(
      existsSync(ownedPath(directory, charter)) ? collectionBytes(directory, charter) : undefined,
      directory,
    );
    return { pin, directory, local: false };
  });
  if (includeLocal) {
    for (const collection of resolveLocalCollections(root, selection)) {
      const previous = resolved.find((entry) => entry.pin.id === collection.pin.id);
      if (previous) {
        const files = previous.local ? previous.files : collectionWorkingFiles(previous.directory);
        if (
          policyFilesHash(files) !== policyFilesHash(collection.files) ||
          previous.pin.scopes.length !== 1 ||
          previous.pin.scopes[0] !== "."
        )
          throw new InvalidInput(
            `collection '${collection.pin.id}': conflicting local and project installations; resolve explicitly`,
          );
      } else resolved.push(collection);
    }
  }
  return resolved;
}

/** Store verified immutable contents without changing the selected policy. */
export function storeCollection(
  source: string,
  digest: string,
  base = join(userDirectory("data"), "collections"),
): CollectionPin {
  if (!collectionHash.test(digest)) throw new InvalidInput("supply the independently recorded collection SHA-256");
  if (existsSync(base) && (!lstatSync(base).isDirectory() || lstatSync(base).isSymbolicLink()))
    throw new InvalidInput(`${base}: expected a real collections directory`);
  const collection = inspectCollection(resolve(source));
  if (collection.pin.sha256 !== digest) throw new InvalidInput("collection SHA-256 does not match the recorded digest");
  const destination = ownedPath(resolve(base), `${collection.pin.id}/${collection.pin.revision}`);
  mkdirSync(dirname(destination), { recursive: true });
  const lock = join(dirname(destination), `.${basename(destination)}.lock`);
  mkdirSync(lock, { mode: 0o700 });
  const staging = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    if (existsSync(destination)) {
      inspectCollection(destination, {
        id: collection.pin.id,
        revision: collection.pin.revision,
        sha256: digest,
        visibility: collection.pin.visibility,
      });
      return collection.pin;
    }
    mkdirSync(staging, { mode: 0o700 });
    for (const [name, bytes] of collection.files) {
      const path = ownedPath(staging, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes, { flag: "wx", mode: collection.pin.visibility === "public" ? 0o644 : 0o600 });
    }
    inspectCollection(staging, {
      id: collection.pin.id,
      revision: collection.pin.revision,
      sha256: digest,
      visibility: collection.pin.visibility,
    });
    if (collection.pin.visibility === "public") chmodSync(staging, 0o755);
    renameSync(staging, destination);
    return collection.pin;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Publish a previously approved local selection atomically. */
export function selectInstalledCollections(
  base: string,
  selected: CollectionPin[],
  beforeSelect: (() => void) | undefined,
  removed: string[] = [],
): void {
  validateCollectionPins(selected, "collection installation");
  const lock = join(base, ".registry.lock");
  mkdirSync(lock, { mode: 0o700 });
  try {
    const pins = registryPins(base).filter(
      (previous) => !removed.includes(previous.id) && !selected.some((pin) => pin.id === previous.id),
    );
    pins.push(...selected);
    pins.sort((a, b) => a.id.localeCompare(b.id));
    beforeSelect?.();
    const temporary = join(base, `.index.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, stringify({ schema_version: 1, sources: pins }), { flag: "wx", mode: 0o600 });
      if (pins.every((entry) => entry.visibility === "public")) chmodSync(temporary, 0o644);
      renameSync(temporary, ownedPath(base, "index.toml"));
    } finally {
      rmSync(temporary, { force: true });
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Supporting files inherit their selected record's ownership and acquisition bounds. */
export function collectionSupportingFiles(directory: string, decisions: string[]): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let entries = 0;
  let total = 0;
  const walk = (name: string): void => {
    for (const entry of readdirSync(ownedPath(directory, name), { withFileTypes: true })) {
      if (++entries > 4096) throw new InvalidInput(`${directory}: too many supporting entries`);
      const child = `${name}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else {
        const bytes = collectionBytes(directory, child);
        total += bytes.length;
        if (total > collectionByteLimit)
          throw new InvalidInput(`${directory}: supporting files exceed ${formatByteCount(collectionByteLimit)} bytes`);
        files.set(child, bytes);
      }
    }
  };
  for (const number of decisions) {
    const name = `workbench/${relativeRecordPath("ADR", number).split(sep).join("/")}`.slice(0, -3);
    if (existsSync(ownedPath(directory, name))) walk(name);
  }
  return files;
}

/** Build a manifest after the provider has prepared its charter, ADRs, maps, and supporting files. */
export function writeCollectionManifest(
  directory: string,
  input: Omit<CollectionManifest, "schema_version" | "content_sha256" | "files">,
): CollectionPin {
  const files: Record<string, string> = {};
  for (const name of [
    collectionCharterPath,
    "workbench/decision-map.md",
    ...input.decisions.map((number) => `workbench/${relativeRecordPath("ADR", number).split(sep).join("/")}`),
  ])
    files[name] = sha256(collectionBytes(directory, name));
  for (const [name, bytes] of collectionSupportingFiles(directory, input.decisions)) files[name] = sha256(bytes);
  writeAtomic(
    join(directory, manifestPath),
    stringify({ schema_version: 1, ...input, content_sha256: contentHash(files), files }),
  );
  return inspectCollection(directory).pin;
}

export function listCollections(root: string, installed: boolean, json: boolean): void {
  const entries = installed
    ? localCollectionDirectories(root)
        .filter(existsSync)
        .flatMap((base) =>
          readdirSync(base, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && collectionName.test(entry.name))
            .flatMap((entry) =>
              readdirSync(join(base, entry.name), { withFileTypes: true })
                .filter((revision) => revision.isDirectory() && collectionRevision.test(revision.name))
                .map((revision) => {
                  const collection = inspectCollection(ownedPath(base, `${entry.name}/${revision.name}`));
                  return { ...collection.pin, directory: collection.directory, installation: "available" };
                }),
            ),
        )
    : resolveCollections(root).map((entry) => ({
        ...entry.pin,
        directory: entry.directory,
        installation: entry.local ? "local" : "project",
      }));
  if (json) console.log(JSON.stringify(entries, null, 2));
  else
    console.log(
      terminalTable(
        ["COLLECTION", "REVISION", "VISIBILITY", "INSTALLATION", "SCOPES", "SOURCE"],
        entries.map((entry) => [
          entry.id,
          entry.revision,
          entry.visibility,
          entry.installation,
          installed ? "available" : entry.scopes.join(", "),
          entry.directory,
        ]),
      ),
    );
}
