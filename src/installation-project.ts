import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { withCacheLockSync as cacheLock } from "./cache-lock.js";
import { ownedPath } from "./paths.js";
import {
  distributionManifest,
  inspectDistribution,
  projectPinFile,
  readDistributionPin,
  validateDistributionPin,
  type DistributionPin,
} from "./distribution-manifest.js";
import {
  copyDistribution,
  installedVersion,
  installationStores,
  readInstallationStore,
  retainInstallation,
  releaseInstallationRoot,
  installationOwner,
} from "./installation-store.js";
import { InvalidInput } from "./input-errors.js";

const withCacheLockSync: typeof cacheLock = (path, action) => cacheLock(path, action, 10_000);

const registrationFile = "workbench/.installation.json";
export interface InstallationRegistration {
  schema_version: 1;
  owner: string;
  checkout: string;
  store: string;
  store_id: string;
  profile: string;
  generations: DistributionPin[];
}
function atomic(root: string, name: string, data: unknown): void {
  const output = ownedPath(root, name);
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, output);
}
export function installationRegistration(root: string): InstallationRegistration | undefined {
  const path = ownedPath(root, registrationFile);
  if (!existsSync(path)) return undefined;
  const registration = JSON.parse(readFileSync(path, "utf8")) as InstallationRegistration;
  if (
    (registration as { schema_version: unknown }).schema_version !== 1 ||
    registration.owner !== installationOwner() ||
    typeof registration.checkout !== "string" ||
    typeof registration.store !== "string" ||
    !isAbsolute(registration.checkout) ||
    !isAbsolute(registration.store) ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(registration.profile) ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(registration.store_id) ||
    !Array.isArray(registration.generations) ||
    !registration.generations.length
  )
    throw new InvalidInput("invalid local Workbench installation registration");
  registration.generations.forEach(validateDistributionPin);
  return registration;
}
export function resolveInstalledDistribution(
  root: string,
  pin: DistributionPin,
  requestedStore?: string,
): { directory: string; store?: string } {
  const embedded = join(root, ".workbench");
  // Isolated snapshots carry a real, verified dependency copy and require no host registration.
  if (
    existsSync(embedded) &&
    !lstatSync(embedded).isSymbolicLink() &&
    existsSync(join(embedded, distributionManifest))
  ) {
    inspectDistribution(embedded, pin);
    return { directory: embedded };
  }
  if (
    process.env.WORKBENCH_DISTRIBUTION_MATERIALIZED === "1" &&
    process.env.WORKBENCH_DISTRIBUTION_ROOT &&
    realpathSync(embedded) === realpathSync(process.env.WORKBENCH_DISTRIBUTION_ROOT)
  ) {
    const directory = realpathSync(embedded);
    inspectDistribution(directory, pin);
    return { directory };
  }
  const registration = installationRegistration(
    process.env.WORKBENCH_LOCAL_CONFIG_ROOT?.length ? process.env.WORKBENCH_LOCAL_CONFIG_ROOT : root,
  );
  const stores = [
    ...new Set([requestedStore, registration?.store, ...installationStores()].filter((p): p is string => !!p)),
  ];
  for (const store of stores) {
    if (!existsSync(join(store, "store.json"))) continue;
    const metadata = readInstallationStore(store);
    if (registration?.store === store && registration.store_id !== metadata.id)
      throw new InvalidInput("registered Workbench store identity changed; inspect it before repairing registration");
    const directory = installedVersion(store, pin);
    if (!existsSync(directory)) continue;
    inspectDistribution(directory, pin);
    return { directory, store };
  }
  throw new InvalidInput(
    `Workbench ${pin.revision} (${pin.sha256}) is not installed; explicitly install that sealed distribution and run workbench installation register`,
  );
}

export function resolvePinnedDistribution(root: string, fallback: string): string {
  const pin = readDistributionPin(root);
  if (pin) {
    const selected = resolveInstalledDistribution(root, pin);
    if (selected.store) {
      const registration = installationRegistration(root);
      if (registration && registration.checkout !== realpathSync(root))
        throw new InvalidInput(
          "checkout location changed; run installation register --repair before using its profile",
        );
    }
    const dependency = join(root, ".workbench");
    if (!existsSync(dependency) || realpathSync(dependency) !== realpathSync(selected.directory))
      throw new InvalidInput(
        "local Workbench dependency link is missing or differs from the pin; run installation register --repair",
      );
    return selected.directory;
  }
  const embedded = join(root, ".workbench");
  if (existsSync(join(embedded, "languages/index.toml"))) return realpathSync(embedded);
  return fallback;
}

function ensureIgnores(root: string): void {
  const path = ownedPath(root, ".gitignore");
  const contents = existsSync(path) ? readFileSync(path, "utf8") : "";
  const rules = [
    "/.workbench",
    "/workbench/.installation.json",
    "/workbench/.installation.lock",
    "/workbench/.installation.lock.lock",
  ];
  const missing = rules.filter((rule) => !contents.split(/\r?\n/).includes(rule));
  if (missing.length)
    writeFileSync(path, `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}
function facade(root: string, directory: string): void {
  const output = join(root, ".workbench");
  let previous: string | undefined;
  let present = false;
  try {
    const info = lstatSync(output);
    present = true;
    if (!info.isSymbolicLink())
      throw new InvalidInput(
        "preserve the existing .workbench directory; shared installation requires an unused dependency path",
      );
    previous = realpathSync(output);
    if (previous === realpathSync(directory)) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const pending = join(root, `.workbench-${randomUUID()}`);
  symlinkSync(directory, pending, process.platform === "win32" ? "junction" : "dir");
  try {
    if (process.platform === "win32" && present) rmSync(output); // Recoverable on Windows, where junction replacement is not atomic.
    renameSync(pending, output);
  } finally {
    if (existsSync(pending)) rmSync(pending);
  }
}

/** A root protecting the candidate is durable before publishing either the portable pin or its local facade. */
export function registerInstallation(
  root: string,
  requestedPin?: DistributionPin,
  storeInput?: string,
  repair = false,
  beforePublish?: () => void,
): InstallationRegistration {
  root = realpathSync(root);
  mkdirSync(ownedPath(root, "workbench"), { recursive: true });
  return withCacheLockSync(join(root, "workbench/.installation.lock"), () => {
    const before = readDistributionPin(root);
    const pin = requestedPin ?? before;
    if (!pin)
      throw new InvalidInput(
        "project has no shared Workbench pin; supply a sealed installation SHA-256 when adopting it",
      );
    validateDistributionPin(pin);
    if (before && requestedPin && before.sha256 !== pin.sha256 && !repair)
      throw new InvalidInput("use workbench update to change an existing project pin");
    const selected = resolveInstalledDistribution(root, pin, storeInput);
    if (!selected.store) throw new InvalidInput("an ephemeral snapshot cannot register a host installation");
    const previous = installationRegistration(root);
    if (previous && (previous.checkout !== root || previous.store !== selected.store) && !repair)
      throw new InvalidInput("checkout location or store changed; use installation register --repair after review");
    if (previous && previous.owner !== installationOwner())
      throw new InvalidInput("registration belongs to another account");
    const generations = previous?.generations ?? [];
    const pins = generations.some((p) => p.sha256 === pin.sha256) ? generations : [...generations, pin];
    const registration: InstallationRegistration = {
      schema_version: 1,
      owner: installationOwner(),
      checkout: root,
      store: selected.store,
      store_id: readInstallationStore(selected.store).id,
      profile: previous?.store === selected.store && previous.checkout === root ? previous.profile : randomUUID(),
      generations: pins,
    };
    const recovery = retainInstallation(selected.store, pins, "recovery");
    ensureIgnores(root);
    // The recovery root survives any interruption between these publications.
    retainInstallation(selected.store, pins, "profile", registration.profile);
    beforePublish?.();
    if (before?.sha256 !== pin.sha256) atomic(root, projectPinFile, pin);
    facade(root, selected.directory);
    atomic(root, registrationFile, registration);
    releaseInstallationRoot(selected.store, recovery.id);
    if (previous?.checkout === root && previous.store !== selected.store)
      releaseInstallationRoot(previous.store, previous.profile);
    return registration;
  });
}

export function forgetInstallationGenerations(root: string, hashes: string[]): InstallationRegistration {
  return withCacheLockSync(join(root, "workbench/.installation.lock"), () => {
    const registration = installationRegistration(root);
    const current = readDistributionPin(root);
    if (!registration || !current) throw new InvalidInput("project has no shared installation registration");
    if (registration.checkout !== realpathSync(root))
      throw new InvalidInput("repair the checkout registration before changing retained generations");
    if (hashes.includes(current.sha256)) throw new InvalidInput("cannot remove the current project generation");
    for (const hash of hashes)
      if (!registration.generations.some((pin) => pin.sha256 === hash))
        throw new InvalidInput(`unknown retained generation: ${hash}`);
    registration.generations = registration.generations.filter((pin) => !hashes.includes(pin.sha256));
    // Publish local intent before dropping a root. A failure retains excess versions for explicit repair.
    atomic(root, registrationFile, registration);
    retainInstallation(registration.store, registration.generations, "profile", registration.profile);
    return registration;
  });
}
export function unregisterInstallation(root: string): void {
  const registration = installationRegistration(root);
  if (!registration) throw new InvalidInput("project has no local installation registration");
  if (registration.checkout !== realpathSync(root))
    throw new InvalidInput("repair the checkout registration before unregistering it");
  withCacheLockSync(join(root, "workbench/.installation.lock"), () => {
    const dependency = join(root, ".workbench");
    if (
      existsSync(dependency) ||
      (() => {
        try {
          return lstatSync(dependency).isSymbolicLink();
        } catch {
          return false;
        }
      })()
    ) {
      if (!lstatSync(dependency).isSymbolicLink())
        throw new InvalidInput("preserving an unexpected .workbench directory");
      rmSync(dependency);
    }
    rmSync(ownedPath(root, registrationFile));
    releaseInstallationRoot(registration.store, registration.profile);
  });
}

export function materializeDistribution(project: string, destination: string, fallback: string): string {
  const pin = readDistributionPin(destination);
  if (!pin) return fallback;
  const selected = resolveInstalledDistribution(project, pin);
  const output = join(destination, ".workbench");
  if (existsSync(output)) {
    if (!lstatSync(output).isSymbolicLink()) {
      inspectDistribution(output, pin);
      return output;
    }
    rmSync(output);
  }
  const use = selected.store ? retainInstallation(selected.store, [pin], "use") : undefined;
  try {
    copyDistribution(selected.directory, output, pin);
  } finally {
    if (use && selected.store) releaseInstallationRoot(selected.store, use.id);
  }
  return output;
}
