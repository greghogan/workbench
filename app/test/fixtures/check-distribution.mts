import { cpSync } from "node:fs";
import { join } from "node:path";
import { distribution } from "./adoption.mjs";

/** Keep real gate entry points while excluding unrelated files from the distribution fingerprint. */
export function checkDistribution(root: string): string {
  const runtime = join(root, "runtime");
  for (const path of [".node-version", ".tool-versions", "Makefile", "bin", "bundle", "languages", "app/resources"])
    cpSync(join(distribution, path), join(runtime, path), { recursive: true });
  return runtime;
}
