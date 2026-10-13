import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./core.js";
import { inspectDistribution, projectPinFile, readDistributionPin } from "./distribution-manifest.js";
import { installationRegistration, registerInstallation } from "./installation-project.js";
import {
  copyDistribution,
  installationStores,
  readInstallationStore,
  retainInstallation,
  releaseInstallationRoot,
} from "./installation-store.js";
import { clean, cloneTree, git, gitEnvironment, prepareManagedPatch } from "./update-git.js";
import { InvalidInput } from "./input-errors.js";
import { required } from "./invariants.js";

/** Only already verified immutable versions are update candidates. Acquisition is an explicit installation step. */
export function updateSharedInstallation(root: string, requested?: string): void {
  const previous = required(readDistributionPin(root), "expected shared project pin");
  const registration = required(installationRegistration(root), "register this shared installation before updating");
  const selection = requested ?? readConfig(root).update?.revision;
  if (!selection || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(selection))
    throw new InvalidInput(
      "shared updates select an installed exact commit or seal SHA-256; install the candidate first",
    );
  const candidates = new Map<string, { pin: typeof previous; store: string; directory: string }>();
  for (const store of [...new Set([registration.store, ...installationStores()])]) {
    if (!existsSync(join(store, "versions"))) continue;
    readInstallationStore(store);
    for (const name of readdirSync(join(store, "versions"))) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const directory = join(store, "versions", name);
      const { pin } = inspectDistribution(directory);
      if ((pin.sha256 === selection || pin.revision === selection) && !candidates.has(pin.sha256))
        candidates.set(pin.sha256, { pin, store, directory });
    }
  }
  if (candidates.size !== 1)
    throw new InvalidInput(
      "shared update requires one installed identity; use its full seal SHA-256 to resolve a missing or ambiguous revision",
    );
  const target = required([...candidates.values()][0], "expected update candidate");
  if (target.pin.sha256 === previous.sha256) {
    console.log("Workbench is already at the selected installation.");
    return;
  }
  const lock = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "workbench-update.lock"]).trim();
  mkdirSync(lock);
  let temporary: string | undefined;
  let recovery: ReturnType<typeof retainInstallation> | undefined;
  const outcome = { retainRecovery: false };
  try {
    clean(root);
    const original = git(root, ["rev-parse", "HEAD"]).trim();
    const originalRegistration = JSON.stringify(installationRegistration(root));
    recovery = retainInstallation(target.store, [...registration.generations, target.pin], "recovery");
    temporary = mkdtempSync(join(tmpdir(), "workbench-update-"));
    writeFileSync(
      join(lock, "recovery"),
      JSON.stringify(
        {
          preparation: temporary,
          projectRevision: original,
          previous,
          target: target.pin,
          store: target.store,
          root: recovery.id,
        },
        null,
        2,
      ) + "\n",
    );
    const prepared = join(temporary, "project");
    cloneTree(root, prepared, original);
    writeFileSync(join(prepared, projectPinFile), JSON.stringify(target.pin, null, 2) + "\n");
    copyDistribution(target.directory, join(prepared, ".workbench"), target.pin);
    const result = spawnSync(process.execPath, [join(prepared, ".workbench/bin/workbench.mjs"), "update-prepare"], {
      cwd: prepared,
      stdio: "inherit",
      env: {
        ...gitEnvironment(),
        WORKBENCH_PROJECT_ROOT: prepared,
        WORKBENCH_DISTRIBUTION_ROOT: join(prepared, ".workbench"),
        WORKBENCH_UPDATE_PREPARATION: prepared,
        WORKBENCH_LOCAL_CONFIG_ROOT: root,
      },
    });
    if (result.error || result.status !== 0)
      throw new Error("candidate migration or validation failed; project selection is unchanged");
    inspectDistribution(join(prepared, ".workbench"), target.pin);
    const { changes, patch, agentDiff, privateContext } = prepareManagedPatch(root, prepared, original, temporary);
    const application = { applied: false };
    try {
      registerInstallation(root, target.pin, target.store, true, () => {
        clean(root);
        if (
          git(root, ["rev-parse", "HEAD"]).trim() !== original ||
          readDistributionPin(root)?.sha256 !== previous.sha256 ||
          JSON.stringify(installationRegistration(root)) !== originalRegistration
        )
          throw new InvalidInput("checkout or registration changed during preparation; retry");
        if (patch) {
          git(root, ["apply", "--check", "--whitespace=nowarn", "-"], patch);
          application.applied = true;
          git(root, ["apply", "--whitespace=nowarn", "-"], patch);
        }
      });
    } catch (failure) {
      if (application.applied) {
        try {
          git(root, ["apply", "--reverse", "--whitespace=nowarn", "-"], patch);
          registerInstallation(root, previous, registration.store, true);
        } catch (rollback) {
          outcome.retainRecovery = true;
          throw new AggregateError(
            [failure, rollback],
            `shared update rollback is uncertain; recovery retained at ${temporary}`,
            { cause: rollback },
          );
        }
      }
      throw failure;
    }
    console.log(
      `Workbench ${previous.sha256} -> ${target.pin.sha256}; ${String(changes.length / 2)} project file(s) changed.`,
    );
    if (agentDiff)
      console.log(
        privateContext
          ? "Agent context includes private policy; review the local AGENTS.md diff with a private audience."
          : agentDiff,
      );
    console.log(
      "Review the dependency and project diff together. ADR and EXP changes require human review before commit. Nothing was staged or committed.",
    );
  } finally {
    if (!outcome.retainRecovery) {
      if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
      if (recovery) releaseInstallationRoot(target.store, recovery.id);
      rmSync(lock, { recursive: true, force: true });
    }
  }
}
