import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parse, stringify } from "smol-toml";
import {
  distributionRoot,
  normalizedNumber,
  readConfig,
  readProjects,
  relativeRecordPath,
  writeAtomic,
} from "./core.js";
import { ownedPath, relativePath } from "./paths.js";
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
import { required } from "./invariants.js";
import { readDecision } from "./decision-record.js";
import { renderCollectionMap } from "./collection-maps.js";

export interface ResolvedCollection {
  pin: CollectionPin;
  directory: string;
  manifest: CollectionManifest;
  files: Map<string, Buffer>;
  local?: boolean;
}
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

/** Both shared dependency declarations and local installation selections use portable verified pins. */
function registryPins(base: string): CollectionPin[] {
  const path = ownedPath(base, "index.toml");
  if (!existsSync(path)) return [];
  const document = collectionTable(
    parse(fileBytes(base, "index.toml").toString("utf8")),
    ["schema_version", "sources"],
    path,
  );
  if (document.schema_version !== 1) throw new InvalidInput(`${path}: unsupported collection registry schema`);
  validateCollectionPins(document.sources, path);
  return document.sources as CollectionPin[];
}

export function collectionPins(root: string, replacements?: CollectionPin[]): CollectionPin[] {
  const inherited = registryPins(join(distributionRoot(root), "collections"));
  const configured = hasCollectionProject(root);
  const current = configured ? (readConfig(root).collections?.sources ?? []) : [];
  const local = replacements
    ? [...current.filter((pin) => !replacements.some((replacement) => replacement.id === pin.id)), ...replacements]
    : current;
  const pins = [...inherited];
  for (const pin of local) {
    const previous = pins.find((entry) => entry.id === pin.id);
    if (previous) {
      if (
        ["revision", "sha256", "visibility"].some(
          (key) => previous[key as keyof CollectionIdentity] !== pin[key as keyof CollectionIdentity],
        ) ||
        previous.scopes.length !== pin.scopes.length ||
        previous.scopes.some((scope) => !pin.scopes.includes(scope))
      )
        throw new InvalidInput(
          `collection '${pin.id}' conflicts with the pinned distribution; replace policy explicitly`,
        );
    } else pins.push(pin);
  }
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
export function localCollectionDirectories(root: string): string[] {
  if (process.env.WORKBENCH_COLLECTIONS_MATERIALIZED === "1") return [join(root, "workbench/.collections")];
  const owner = process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? root;
  return [
    ...new Set([
      join(owner, "workbench/.local-collections"),
      ...(localConfiguration(root).collections?.directories ?? []),
      ...((readUserConfig()["collections.directories"] as string[] | undefined) ?? []),
      join(userDirectory("data"), "collections"),
      ...systemCollectionDirectories(),
    ]),
  ];
}

/** Data lookup never creates directories or downloads missing sources. */
export function collectionDirectories(root: string): string[] {
  return [
    ...new Set([
      join(root, "collections"),
      join(distributionRoot(root), "collections"),
      ...localCollectionDirectories(root),
    ]),
  ];
}

function fileBytes(directory: string, name: string): Buffer {
  const path = ownedPath(directory, name);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new InvalidInput(`${path}: collection files must be regular files no larger than 1 MiB`);
    // One extra byte detects concurrent growth without allocating or reading an unbounded file.
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length === bytes.length) throw new InvalidInput(`${path}: collection file changed during verification`);
    return Buffer.from(bytes.subarray(0, length));
  } finally {
    closeSync(descriptor);
  }
}

/** Hash the manifest and every explicitly exported file; unrelated provider records are ignored. */
export function inspectCollection(directory: string, expected?: CollectionIdentity): ResolvedCollection {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new InvalidInput(`${directory}: expected a real collection directory`);
  const bytes = fileBytes(directory, manifestPath);
  const manifest = collectionTable(
    parse(bytes.toString("utf8")),
    ["schema_version", "id", "revision", "visibility", "content_sha256", "namespace", "dependency", "files"],
    manifestPath,
  ) as unknown as CollectionManifest;
  const identity = {
    id: manifest.id,
    revision: manifest.revision,
    visibility: manifest.visibility,
    sha256: sha256(bytes),
  };
  validateCollectionIdentity(identity, manifestPath);
  if (expected && Object.entries(expected).some(([key, value]) => identity[key as keyof CollectionIdentity] !== value))
    throw new InvalidInput(`collection '${expected.id}': installed identity or SHA-256 does not match pin`);
  if (manifest.schema_version !== 1) throw new InvalidInput(`${directory}: unsupported collection manifest schema`);
  const fileInventory: unknown = manifest.files;
  if (!fileInventory || typeof fileInventory !== "object" || Array.isArray(fileInventory))
    throw new InvalidInput(`${directory}: expected collection files`);
  const entries = Object.entries(manifest.files);
  if (
    !entries.length ||
    entries.length > 4096 ||
    !collectionHash.test(manifest.content_sha256) ||
    contentHash(manifest.files) !== manifest.content_sha256
  )
    throw new InvalidInput(`${directory}: invalid collection content digest or inventory`);
  if (!Array.isArray(manifest.namespace) || !manifest.namespace.length || !Array.isArray(manifest.dependency))
    throw new InvalidInput(`${directory}: expected namespaces and dependencies`);
  const ids = new Set<string>();
  const paths = new Set<string>();
  const allowed = new Set<string>();
  for (const namespace of manifest.namespace) {
    collectionTable(namespace, ["id", "path", "decisions"], manifestPath);
    if (
      typeof namespace.id !== "string" ||
      !collectionName.test(namespace.id) ||
      ids.has(namespace.id) ||
      paths.has(namespace.path)
    )
      throw new InvalidInput(`${directory}: duplicate or invalid collection namespace`);
    ids.add(namespace.id);
    paths.add(namespace.path);
    if (typeof namespace.path !== "string") throw new InvalidInput(`${directory}: invalid namespace path`);
    relativePath(namespace.path, manifestPath, true);
    if (
      !Array.isArray(namespace.decisions) ||
      !namespace.decisions.length ||
      new Set(namespace.decisions).size !== namespace.decisions.length
    )
      throw new InvalidInput(`${directory}: expected distinct exported decisions`);
    const prefix = namespace.path === "." ? "workbench" : `${namespace.path}/workbench`;
    allowed.add(`${prefix}/decision-map.md`);
    for (const number of namespace.decisions) {
      if (typeof number !== "string" || normalizedNumber(number) !== number)
        throw new InvalidInput(`${directory}: invalid exported decision identity`);
      allowed.add(`${prefix}/${relativeRecordPath("ADR", number).split(sep).join("/")}`);
    }
  }
  const dependencies = new Set<string>();
  for (const dependency of manifest.dependency) {
    validateCollectionIdentity(dependency, manifestPath);
    if (dependencies.has(dependency.id) || dependency.id === identity.id)
      throw new InvalidInput(`${directory}: duplicate or self collection dependency`);
    dependencies.add(dependency.id);
  }
  if (
    entries.length !== allowed.size ||
    entries.some(([path, digest]) => !allowed.has(path) || !collectionHash.test(digest))
  )
    throw new InvalidInput(`${directory}: inventory must contain exactly exported ADRs and maps`);
  const files = new Map<string, Buffer>([[manifestPath, bytes]]);
  let total = 0;
  for (const [name, digest] of entries) {
    const content = fileBytes(directory, name);
    total += content.length;
    if (total > 64 * 1024 * 1024 || sha256(content) !== digest)
      throw new InvalidInput(`${directory}: exported collection content failed verification`);
    files.set(name, content);
  }
  for (const namespace of manifest.namespace) {
    const prefix = namespace.path === "." ? "workbench" : `${namespace.path}/workbench`;
    const decisions = namespace.decisions.map((number) => {
      const name = `${prefix}/${relativeRecordPath("ADR", number).split(sep).join("/")}`;
      return readDecision(
        namespace,
        number,
        join(directory, name),
        required(files.get(name), "verified decision").toString("utf8"),
      );
    });
    if (
      required(files.get(`${prefix}/decision-map.md`), "verified map").toString("utf8") !==
      renderCollectionMap(decisions)
    )
      throw new InvalidInput(`${identity.id}: exported decision map is stale`);
  }
  return { directory, manifest, files, pin: { ...identity, scopes: ["."] } };
}

export function resolveCollections(
  root: string,
  includeLocal = true,
  selection?: CollectionSelection,
): ResolvedCollection[] {
  const resolved = collectionPins(root, selection?.installation === "project" ? selection.pins : undefined).map(
    (pin) => {
      const candidates = [...new Set([join(root, "collections"), join(distributionRoot(root), "collections")])]
        .map((base) => ownedPath(base, `${pin.id}/${pin.revision}`))
        .filter(existsSync);
      if (!candidates.length)
        throw new InvalidInput(
          `required project collection '${pin.id}' revision '${pin.revision}' is not installed in the repository`,
        );
      const copies = candidates.map((directory) =>
        inspectCollection(directory, {
          id: pin.id,
          revision: pin.revision,
          sha256: pin.sha256,
          visibility: pin.visibility,
        }),
      );
      return { ...required(copies[0], "resolved collection copy"), pin };
    },
  );
  if (includeLocal) {
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
          local: true,
        };
        if (pin.scopes.length !== 1 || pin.scopes[0] !== ".")
          throw new InvalidInput(`${base}: local installations must cover their entire installation scope`);
        const previous = resolved.find((entry) => entry.pin.id === pin.id);
        if (previous) {
          if (
            ["revision", "sha256", "visibility"].some(
              (key) => previous.pin[key as keyof CollectionIdentity] !== pin[key as keyof CollectionIdentity],
            ) ||
            previous.pin.scopes.length !== 1 ||
            previous.pin.scopes[0] !== "."
          )
            throw new InvalidInput(
              `collection '${pin.id}': conflicting local and project installations; resolve explicitly`,
            );
        } else resolved.push(collection);
      }
    }
  }
  const byId = new Map(resolved.map((entry) => [entry.pin.id, entry]));
  const active = new Set<string>();
  const visited = new Set<string>();
  const ordered: ResolvedCollection[] = [];
  const visit = (entry: ResolvedCollection) => {
    if (active.has(entry.pin.id)) throw new InvalidInput(`collection dependency cycle includes '${entry.pin.id}'`);
    if (visited.has(entry.pin.id)) return;
    active.add(entry.pin.id);
    for (const dependency of entry.manifest.dependency) {
      const target = byId.get(dependency.id);
      if (
        !target ||
        Object.entries(dependency).some(([key, value]) => target.pin[key as keyof CollectionIdentity] !== value)
      )
        throw new InvalidInput(`collection '${entry.pin.id}': missing or mismatched dependency '${dependency.id}'`);
      if (!entry.local && target.local)
        throw new InvalidInput(`project collection '${entry.pin.id}' cannot depend on a local installation`);
      if (entry.pin.scopes.some((scope) => !target.pin.scopes.some((parent) => appliesWithin(parent, scope))))
        throw new InvalidInput(`collection '${entry.pin.id}': dependency '${dependency.id}' does not cover its scopes`);
      if (entry.pin.visibility === "public" && target.pin.visibility === "private")
        throw new InvalidInput(`public collection '${entry.pin.id}' depends on private material`);
      visit(target);
    }
    active.delete(entry.pin.id);
    visited.add(entry.pin.id);
    ordered.push(entry);
  };
  for (const entry of resolved) visit(entry);
  return ordered;
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

/** Installation selects the local revision atomically; no separate activation is required. */
export function selectInstalledCollections(base: string, selected: CollectionPin[], beforeSelect: () => void): void {
  validateCollectionPins(selected, "collection installation");
  const lock = join(base, ".registry.lock");
  mkdirSync(lock, { mode: 0o700 });
  try {
    const pins = registryPins(base).filter((previous) => !selected.some((pin) => pin.id === previous.id));
    pins.push(...selected);
    pins.sort((a, b) => a.id.localeCompare(b.id));
    beforeSelect();
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

/** Build a manifest after the provider has explicitly prepared its exported ADRs and maps. */
export function writeCollectionManifest(
  directory: string,
  input: Omit<CollectionManifest, "schema_version" | "content_sha256" | "files">,
): CollectionPin {
  const files: Record<string, string> = {};
  for (const namespace of input.namespace) {
    const prefix = namespace.path === "." ? "workbench" : `${namespace.path}/workbench`;
    for (const name of [
      `${prefix}/decision-map.md`,
      ...namespace.decisions.map((number) => `${prefix}/${relativeRecordPath("ADR", number).split(sep).join("/")}`),
    ])
      files[name] = sha256(fileBytes(directory, name));
  }
  writeAtomic(
    join(directory, manifestPath),
    stringify({ schema_version: 1, ...input, content_sha256: contentHash(files), files }),
  );
  return inspectCollection(directory).pin;
}

export function listCollections(root: string, installed: boolean, json: boolean): void {
  const entries = installed
    ? collectionDirectories(root)
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
