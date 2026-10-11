#!/usr/bin/env node
import { dirname } from "node:path";

const distribution = dirname(import.meta.dirname);
const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && (minor < 23 || (minor === 23 && patch < 3)))) {
  console.error("workbench: Node.js 22.23.3 or newer is required");
  process.exit(1);
}
// The CLI discovers the project from the working directory, or honors an explicit
// snapshot root. A shared executable must never redirect commands into its own checkout.
process.env.WORKBENCH_DISTRIBUTION_ROOT = distribution;
await import(new URL("../bundle/main.cjs", import.meta.url).href);
