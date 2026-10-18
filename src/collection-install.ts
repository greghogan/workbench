import { prepareLocalPolicy } from "./local-policy.js";
import { mkdirSync } from "node:fs";
import { reconcileCollection } from "./collection-reconcile.js";
import { join, resolve } from "node:path";
import { distributionRoot, readConfig } from "./core.js";
import { ensureLocalIgnore } from "./environments.js";
import { InvalidInput } from "./input-errors.js";
import { userDirectory } from "./storage.js";
import { systemCollectionDirectories } from "./collections.js";
import { type CollectionPin } from "./collection-schema.js";

interface InstallOptions {
  directory?: string;
  scope: string;
  commit?: string;
  collection?: string;
  visibility?: "public" | "private";
  resolved?: string;
}

/** Immutable content may be retained on rejection; publish its selection only after checking the candidate context. */
export function installSelectedCollections(
  root: string,
  requests: { source: string; sha256?: string }[],
  options: InstallOptions,
): CollectionPin[] {
  if (!requests.length) throw new InvalidInput("select at least one collection to install");
  if (!["user", "system", "local", "project"].includes(options.scope))
    throw new InvalidInput(`unknown collection installation scope: ${options.scope}`);
  if (options.directory && ["project", "local"].includes(options.scope))
    throw new InvalidInput("--directory applies only to user or system installations");
  if (options.scope === "project") {
    if (requests.length !== 1) throw new InvalidInput("adopt one self-contained collection at a time");
    const request = requests[0];
    if (!request) throw new InvalidInput("select a collection to adopt");
    if (!options.commit)
      throw new InvalidInput("project adoption requires --commit FULL_COMMIT and a Git repository source");
    return [
      reconcileCollection(root, request.source, {
        commit: options.commit,
        collection: options.collection ?? ".",
        visibility: options.visibility ?? "private",
        ...(request.sha256 ? { sha256: request.sha256 } : {}),
      }),
    ];
  }
  if (options.scope === "local") {
    readConfig(root);
    ensureLocalIgnore(root);
  }
  const destination =
    options.directory ??
    (options.scope === "local"
      ? join(root, "workbench/.local-collections")
      : options.scope === "system"
        ? systemCollectionDirectories()[0]
        : join(userDirectory("data"), "collections"));
  if (!destination) throw new InvalidInput("no system collection directory is available; supply --directory");
  if ([join(root, "collections"), join(distributionRoot(root), "collections")].includes(resolve(destination)))
    throw new InvalidInput(
      "repository collection directories are shared; use --scope project or select a local installation directory",
    );
  if (options.scope === "system") mkdirSync(destination, { recursive: true, mode: 0o755 });
  if (options.resolved && requests.length !== 1) throw new Error("resolve one local update at a time");
  return requests.map(({ source, sha256 }) => prepareLocalPolicy(destination, source, sha256 ?? "", options.resolved));
}
