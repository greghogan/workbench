import { userConfigValues } from "../configuration/user-config.js";
import { UserFacingError } from "../diagnostics/diagnostic-errors.mjs";
import { executeCI } from "../execution/ci/support/ci-lifecycle.mjs";
import { PreparationStore } from "../execution/environments/managed/managed-contract.mjs";

const managers = {
  nix: {
    name: "Nix",
    probe: ["--extra-experimental-features", "nix-command", "store", "ping", "--store", "daemon"],
    units: ["nix-daemon.socket", "nix-daemon.service"],
  },
  guix: { name: "Guix", probe: ["gc", "--list-roots"], units: ["guix-daemon.service"] },
};

async function startupCommand(units: string[], cwd: string): Promise<string | undefined> {
  for (const unit of units) {
    try {
      const state = await executeCI("systemctl", ["show", "--property=LoadState", "--value", unit], {
        cwd,
        capture: true,
      });
      if (state.trim() === "loaded") return `sudo systemctl start ${unit}`;
    } catch {
      // Other service managers can still use the explicit managed mode.
    }
  }
  return undefined;
}

/** Call only for a local build. Reusing or verifying an existing image requires no store. */
export async function selectPreparationStore(builder: string, cwd: string) {
  if (builder !== "nix" && builder !== "guix") return undefined;
  const manager = managers[builder];
  const key = `preparation.${builder}_store` as const;
  const setting = userConfigValues()[key];
  const configure = `workbench config set --scope global ${key}`;
  if (setting === PreparationStore.Managed) return setting;
  if (setting !== PreparationStore.System)
    throw new UserFacingError(
      `${manager.name} image preparation is disabled.\n\nEnable it with:\n  ${configure} system\n  ${configure} managed`,
    );
  try {
    await executeCI(builder, manager.probe, { cwd, capture: true });
    return setting;
  } catch (cause) {
    const start = await startupCommand(manager.units, cwd);
    throw new UserFacingError(
      `${manager.name} system daemon is unavailable.\n\n${start ? `Start it with:\n  ${start}\n\n` : "Install or start the system daemon.\n\n"}To use the managed store:\n  ${configure} managed`,
      { cause },
    );
  }
}
