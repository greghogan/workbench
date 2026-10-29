import { join } from "node:path";
import { existsSync } from "node:fs";
import { createSourceSnapshot } from "../scripts/source-snapshot.mjs";
import type { ConsumerCommands } from "./consumer-integration-runner.js";
import type { ConsumerScenarios } from "./consumer-integration-scenarios.js";
import type { ProcessLock } from "./process-lock.js";

/** Developer installation is checked from source without borrowing the checkout's generated helpers. */
export async function exerciseSourceCheckout(options: {
  source: string;
  temporary: string;
  environment: NodeJS.ProcessEnv;
  commands: ConsumerCommands;
  scenarios: ConsumerScenarios;
  signal: AbortSignal;
  owner: ProcessLock;
}): Promise<void> {
  await options.scenarios.run("source-only-development-checkout", async () => {
    const snapshot = await createSourceSnapshot({
      source: options.source,
      destination: join(options.temporary, "development-source"),
      environment: options.environment,
      signal: options.signal,
      owner: options.owner,
    });
    const env = {
      ...options.environment,
      PNPM_CONFIG_STORE_DIR: join(options.environment.WORKBENCH_CACHE_HOME ?? options.temporary, "downloads/pnpm"),
    };
    const root = snapshot.directory,
      cli = join(root, "bin/workbench.mjs");
    const run = (name: string, args: string[]) =>
      options.commands.run(`source-${name}`, [process.execPath, ...args], root, env);
    for (const file of ["eslint.config.mjs", "scripts/build-bundle.mjs", "scripts/maintenance/main.mjs"])
      if (existsSync(join(root, file))) throw new Error(`Source rehearsal started with a generated helper: ${file}`);
    await run("bootstrap", [cli, "--help"]);
    await run("register", [cli, "project", "add", root]);
    await run("validate-before", [cli, "validate"]);
    await run("setup", ["scripts/setup-development.mts"]);
    for (const file of ["eslint.config.mjs", "scripts/build-bundle.mjs", "scripts/maintenance/main.mjs"])
      if (!existsSync(join(root, file))) throw new Error(`Source setup did not generate ${file}`);
    await run("validate-after", [cli, "validate"]);
    await run("parity", [cli, "package-manager-exec", "--", "run", "bundle:check"]);
    await options.commands.run("source-unchanged", ["git", "diff", "--exit-code"], root, env);
  });
}
