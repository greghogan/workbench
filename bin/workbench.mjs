#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major < 18 || (major === 18 && (minor < 20 || (minor === 20 && patch < 8)))) {
  console.error("workbench: Node.js 18.20.8 or newer is required to bootstrap Workbench");
  process.exit(1);
}
const distribution = dirname(dirname(fileURLToPath(import.meta.url)));
// The CLI discovers the project from the working directory, or honors an explicit
// snapshot root. A shared executable must never redirect commands into its own checkout.
process.env.WORKBENCH_DISTRIBUTION_ROOT = distribution;
const { default: launcher } = await import(new URL("../bundle/launcher.cjs", import.meta.url).href);
await launcher.launch(process.argv.slice(2), undefined, distribution).catch((error) => {
  console.error(`workbench: ${error.message}`);
  process.exitCode = 1;
});
