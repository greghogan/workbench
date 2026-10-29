#!/usr/bin/env node
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major < 18 || (major === 18 && (minor < 20 || (minor === 20 && patch < 8)))) {
  console.error("workbench: Node.js 18.20.8 or newer is required to bootstrap Workbench");
  process.exit(1);
}
const distribution = dirname(dirname(fileURLToPath(import.meta.url)));
if (!existsSync(join(distribution, "bundle/launcher.cjs"))) {
  console.error(
    existsSync(join(distribution, "scripts/setup-development.mjs"))
      ? "workbench: local bundles are missing; with the pinned development Node, run:\n  node scripts/setup-development.mjs"
      : "workbench: the installed runtime is incomplete; reinstall this release",
  );
  process.exit(1);
}
// The CLI discovers the project from the working directory, or honors an explicit
// snapshot root. A shared executable must never redirect commands into its own checkout.
process.env.WORKBENCH_DISTRIBUTION_ROOT = distribution;
const { default: launcher } = await import(new URL("../bundle/launcher.cjs", import.meta.url).href);
await launcher.launch(process.argv.slice(2), undefined, distribution).catch((error) => {
  console.error(launcher.formatFailure(error));
  process.exitCode = 1;
});
