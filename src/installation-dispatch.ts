import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { distributionManifest, inspectDistribution, readDistributionPin } from "./distribution-manifest.js";
import { resolveInstalledDistribution, resolvePinnedDistribution } from "./installation-project.js";
import { retainInstallation, releaseInstallationRoot } from "./installation-store.js";

/** Resolve before parsing commands so an older launcher cannot interpret a newer project's options. */
export async function dispatchInstallation(
  root: string,
  executableDistribution: string,
  action: () => Promise<unknown>,
): Promise<void> {
  const maintenance = ["installation", "installation-snapshot", "distribution-inputs"].includes(process.argv[2] ?? "");
  const self = realpathSync(executableDistribution);
  const selected = maintenance ? self : resolvePinnedDistribution(root, self);
  if (realpathSync(selected) !== self) {
    await new Promise<void>((finish, reject) => {
      const child = spawn(process.execPath, [join(selected, "bin/workbench.mjs"), ...process.argv.slice(2)], {
        stdio: "inherit",
        env: { ...process.env, WORKBENCH_DISTRIBUTION_ROOT: selected },
      });
      const stop = (signal: NodeJS.Signals) => child.kill(signal);
      const interrupt = () => stop("SIGINT");
      const terminate = () => stop("SIGTERM");
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      const cleanup = () => {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
      };
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("exit", (code, signal) => {
        cleanup();
        process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
        finish();
      });
    });
    return;
  }
  process.env.WORKBENCH_DISTRIBUTION_ROOT = self;
  const projectPin = maintenance ? undefined : readDistributionPin(root);
  const installedStore = dirname(dirname(self));
  const selfPin =
    !projectPin && existsSync(join(self, distributionManifest)) && existsSync(join(installedStore, "store.json"))
      ? inspectDistribution(self).pin
      : undefined;
  const pin = projectPin ?? selfPin;
  const help = process.argv.slice(2).some((argument) => ["--help", "-h", "--help-all"].includes(argument));
  const inspection = help || ["completion", "complete"].includes(process.argv[2] ?? "");
  const store = !inspection
    ? projectPin
      ? resolveInstalledDistribution(root, projectPin).store
      : selfPin
        ? installedStore
        : undefined
    : undefined;
  const use = pin && store ? retainInstallation(store, [pin], "use") : undefined;
  let released = false;
  const release = () => {
    if (use && store && !released) {
      releaseInstallationRoot(store, use.id);
      released = true;
    }
  };
  // Commander may exit directly after invalid arguments. Keep ordinary failures from abandoning an active-use root.
  process.once("exit", release);
  try {
    await action();
  } finally {
    release();
    process.off("exit", release);
  }
}
