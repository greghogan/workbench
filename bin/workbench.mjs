#!/usr/bin/env node
import { basename, dirname } from "node:path";

const distribution = dirname(import.meta.dirname);
const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && (minor < 23 || (minor === 23 && patch < 3)))) {
  console.error("workbench: Node.js 22.23.3 or newer is required");
  process.exit(1);
}
process.env.WORKBENCH_PROJECT_ROOT = basename(distribution) === ".workbench" ? dirname(distribution) : distribution;
process.env.WORKBENCH_DISTRIBUTION_ROOT = distribution;
await import(new URL("../bundle/main.cjs", import.meta.url).href);
