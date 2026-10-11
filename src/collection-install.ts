import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { distributionRoot, readConfig, readText } from "./core.js";
import { setConfiguration } from "./config-command.js";
import { decisionScopes } from "./decisions.js";
import { ensureLocalIgnore } from "./environments.js";
import { InvalidInput } from "./input-errors.js";
import { ownedPath } from "./paths.js";
import { userDirectory } from "./storage.js";
import {
  storeCollection,
  selectInstalledCollections,
  systemCollectionDirectories,
  type CollectionSelection,
} from "./collections.js";
import { validateCollectionPins, type CollectionPin } from "./collection-schema.js";

interface InstallOptions {
  directory?: string;
  scope: string;
}

function preflight(root: string, selection: CollectionSelection): void {
  try {
    decisionScopes(root, true, selection);
  } catch (error) {
    throw new InvalidInput(`collection selection rejected; previous selection is unchanged: ${String(error)}`, {
      cause: error,
    });
  }
}

/** Immutable content may be retained on rejection; publish its selection only after checking the candidate context. */
export function installSelectedCollections(
  root: string,
  requests: { source: string; sha256: string }[],
  options: InstallOptions,
): CollectionPin[] {
  if (!requests.length) throw new InvalidInput("select at least one collection to install");
  if (!["user", "system", "local", "project"].includes(options.scope))
    throw new InvalidInput(`unknown collection installation scope: ${options.scope}`);
  if (options.directory && ["project", "local"].includes(options.scope))
    throw new InvalidInput("--directory applies only to user or system installations");
  if (options.scope === "local") {
    readConfig(root);
    ensureLocalIgnore(root);
  }
  const destination =
    options.directory ??
    (options.scope === "project"
      ? join(root, "collections")
      : options.scope === "local"
        ? join(root, "workbench/.local-collections")
        : options.scope === "system"
          ? systemCollectionDirectories()[0]
          : join(userDirectory("data"), "collections"));
  if (!destination) throw new InvalidInput("no system collection directory is available; supply --directory");
  if (
    options.scope !== "project" &&
    [join(root, "collections"), join(distributionRoot(root), "collections")].includes(resolve(destination))
  )
    throw new InvalidInput(
      "repository collection directories are shared; use --scope project or select a local installation directory",
    );
  const prepare = () => {
    const pins = requests.map(({ source, sha256 }) => storeCollection(source, sha256, destination));
    validateCollectionPins(pins, "collection installation");
    return pins;
  };
  if (options.scope !== "project") {
    const pins = prepare();
    selectInstalledCollections(destination, pins, () => {
      preflight(root, { installation: "local", pins, base: destination });
    });
    return pins;
  }

  const configPath = ownedPath(root, "workbench/config.toml");
  const lock = ownedPath(root, "workbench/.collection-selection.lock");
  mkdirSync(lock, { mode: 0o700 });
  try {
    const contents = readText(configPath);
    const before = readConfig(root).collections?.sources ?? [];
    const pins = prepare().map((installed) => ({
      ...installed,
      scopes: before.find((entry) => entry.id === installed.id)?.scopes ?? installed.scopes,
    }));
    preflight(root, { installation: "project", pins });
    if (readText(configPath) !== contents)
      throw new InvalidInput("project configuration changed during installation; preserve it and retry");
    setConfiguration(
      root,
      "collections.sources",
      JSON.stringify([...before.filter((entry) => !pins.some((pin) => entry.id === pin.id)), ...pins]),
      "project",
    );
    return pins;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
