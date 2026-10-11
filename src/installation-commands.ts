import { Command, Option } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspectDistribution, readDistributionPin, sealDistribution } from "./distribution-manifest.js";
import {
  defaultInstallation,
  installedVersion,
  installationStores,
  installDistribution,
  listInstallations,
  provisionInstallationOwner,
  pruneInstallations,
  recoverInstallationStore,
  releaseInstallationRoot,
} from "./installation-store.js";
import {
  forgetInstallationGenerations,
  installationRegistration,
  registerInstallation,
  unregisterInstallation,
} from "./installation-project.js";
import { InvalidInput } from "./input-errors.js";

interface StoreOptions {
  directory?: string;
  scope?: "user" | "system";
}
const base = (options: StoreOptions) =>
  resolve(
    options.directory ??
      installationStores()[options.scope === "system" ? 1 : 0] ??
      (() => {
        throw new InvalidInput("no system installation path; supply --directory");
      })(),
  );
function findPin(hash: string, options: StoreOptions) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new InvalidInput("supply a full installation SHA-256");
  for (const store of options.directory ? [base(options)] : installationStores()) {
    const directory = join(store, "versions", hash);
    if (existsSync(directory)) return { pin: inspectDistribution(directory).pin, store };
  }
  throw new InvalidInput(`Workbench installation is missing: ${hash}`);
}
const output = (value: unknown) => {
  console.log(JSON.stringify(value, null, 2));
};
export function registerInstallationCommands(program: Command, root: string): void {
  const command = program
    .command("installation")
    .description("Manage exact Workbench installations, project profiles, retained generations, and pruning")
    .action(() => {
      output({ pin: readDistributionPin(root) ?? null, registration: installationRegistration(root) ?? null });
    });
  command
    .command("inspect")
    .argument("<directory>")
    .description("Verify a sealed distribution and print its identity")
    .action((directory: string) => {
      output(inspectDistribution(resolve(directory)).pin);
    });
  command
    .command("seal")
    .argument("<directory>")
    .requiredOption("--revision <commit>", "Exact source Git commit")
    .description("Create the verified inventory for a prepared runnable distribution")
    .action((directory: string, options: { revision: string }) => {
      output(sealDistribution(resolve(directory), options.revision));
    });
  command
    .command("install")
    .argument("<directory>")
    .requiredOption("--sha256 <digest>", "Independently selected distribution seal digest")
    .addOption(new Option("--scope <scope>", "Installation authority").choices(["user", "system"]).default("user"))
    .option("--directory <path>", "Explicit installation store")
    .option("--default", "Install a stable launcher and retain this default generation")
    .description("Verify and install immutable contents without executing them")
    .action((directory: string, options: StoreOptions & { sha256: string; default?: boolean }) => {
      const store = base(options);
      const pin = installDistribution(resolve(directory), options.sha256, store, options.scope ?? "user");
      if (options.default) defaultInstallation(store, pin);
      output({
        pin,
        store,
        executable: join(
          options.default ? join(store, "bin") : join(installedVersion(store, pin), "bin"),
          "workbench.mjs",
        ),
      });
    });
  command
    .command("register")
    .argument("[sha256]", "Installation identity for first adoption; otherwise use the project pin")
    .option("--directory <path>", "Explicit installation store")
    .option("--repair", "Repair a moved checkout or manually changed pin")
    .description("Register this checkout and create its ignored local dependency link")
    .action((hash: string | undefined, options: StoreOptions & { repair?: boolean }) => {
      const selection = hash ? findPin(hash, options) : undefined;
      output(registerInstallation(root, selection?.pin, selection?.store ?? options.directory, !!options.repair));
    });
  command
    .command("generations")
    .option("--forget <sha256...>", "Explicitly release retained generations, preserving the current pin")
    .description("Inspect or release this checkout's rollback generations")
    .action((options: { forget?: string[] }) => {
      output(options.forget ? forgetInstallationGenerations(root, options.forget) : installationRegistration(root));
    });
  command
    .command("unregister")
    .description("Release this checkout's profile and remove its local dependency link")
    .action(() => {
      unregisterInstallation(root);
    });
  command
    .command("default")
    .argument("<sha256>")
    .option("--directory <path>", "Explicit installation store")
    .option("--forget <sha256...>", "Release previous default generations")
    .description("Select the stable launcher's version; project pins keep their own selections")
    .action((hash: string, options: StoreOptions & { forget?: string[] }) => {
      const selected = findPin(hash, options);
      defaultInstallation(selected.store, selected.pin, options.forget);
      output(selected.pin);
    });
  command
    .command("list")
    .option("--directory <path>", "Explicit installation store")
    .addOption(new Option("--scope <scope>", "Store scope").choices(["user", "system"]).default("user"))
    .description("Verify installed versions and show all retention reasons; system scope requires an administrator")
    .action((options: StoreOptions) => {
      output(listInstallations(base(options)));
    });
  command
    .command("prune")
    .option("--directory <path>", "Explicit installation store")
    .option("--apply", "Remove verified versions without retention roots")
    .addOption(new Option("--scope <scope>", "Store scope").choices(["user", "system"]).default("user"))
    .description("Preview pruning, or explicitly apply it under coordinated maintenance")
    .action((options: StoreOptions & { apply?: boolean }) => {
      output(pruneInstallations(base(options), !!options.apply));
    });
  command
    .command("provision")
    .argument("<account>", "Numeric POSIX UID or Windows SID")
    .option("--directory <path>", "Explicit system installation store")
    .description("As administrator, provision one account's private retention namespace")
    .action((account: string, options: StoreOptions) => {
      provisionInstallationOwner(base({ ...options, scope: "system" }), account);
    });
  command
    .command("recover")
    .option("--directory <path>", "Explicit installation store")
    .addOption(new Option("--scope <scope>", "Store scope").choices(["user", "system"]).default("user"))
    .description("Clear an interrupted maintenance fence after validating every retention root")
    .action((options: StoreOptions) => {
      recoverInstallationStore(base(options));
    });
  const roots = command.command("roots").description("Explicit retention-root repair without accessing project files");
  roots
    .command("remove")
    .argument("<id>")
    .option("--directory <path>", "Explicit installation store")
    .description("Remove one root owned by this account after confirming it is no longer needed")
    .action((id: string, options: StoreOptions) => {
      releaseInstallationRoot(base(options), id);
    });
}
