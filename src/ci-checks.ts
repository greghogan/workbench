import { hostOperatingSystem } from "./check-plan.js";
import { CheckNetwork } from "../scripts/check-network.mjs";
import { ciTargets } from "./ci-targets.js";
import { inspectChecks } from "./checks.js";
import { runGate } from "./check-gates.js";
import { validate } from "./validation.js";

/** A network partition remains part of the same configured CI gate and runtime selection. */
export async function runCIChecks(
  root: string,
  path: string,
  environment: string,
  network: CheckNetwork,
  toolchain?: string,
): Promise<void> {
  const declared = ciTargets(root).some(
    (target) =>
      target.path === path &&
      target.os === hostOperatingSystem() &&
      target.architecture === process.arch &&
      target.environment === environment &&
      (target.kind === "environment" || (target.kind === "native" && target.toolchain === toolchain)),
  );
  if (!declared) throw new Error("CI checks must select a configured native platform, environment, and tool profile");
  const options = {
    stage: "ci",
    path,
    environment,
    toolchain: toolchain ?? false,
    cache: false,
    network,
  } as const;
  if (network !== CheckNetwork.All && !inspectChecks(root, options).selected.length) {
    // A declared target may have no checks in one partition. Other gate selection rules remain authoritative.
    const complete = inspectChecks(root, { ...options, network: CheckNetwork.All });
    if (!complete.selected.length) {
      // Preserve the ordinary gate's configured allow-empty decision and diagnostics.
      await runGate(root, "check", { ...options, network: CheckNetwork.All });
      return;
    }
    await validate(root);
    console.log(`No ${network} checks are configured for ${path}.`);
    return;
  }
  await runGate(root, "check", options);
}
