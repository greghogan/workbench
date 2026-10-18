import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readText } from "./core.js";
import { exactVersion } from "./toolchains.js";

/** Read a literal native requirement without evaluating project Ruby during planning. */
export function rubyMinimum(directory: string): string {
  const specs = readdirSync(directory).filter((name) => name.endsWith(".gemspec"));
  const name = specs[0];
  if (specs.length !== 1 || !name) throw new Error(`${directory}: Ruby support needs one root gemspec`);
  const path = join(directory, name);
  const matches = [
    ...readText(path).matchAll(/^\s*\w+\.required_ruby_version\s*=\s*["']>=(?: )?(\d+\.\d+\.\d+)["']\s*$/gm),
  ];
  if (matches.length !== 1) throw new Error(`${path}: declare one literal required_ruby_version >=major.minor.patch`);
  return exactVersion(matches[0]?.[1], path);
}

export function phpMinimum(directory: string): string {
  const path = join(directory, "composer.json");
  const manifest = JSON.parse(readText(path)) as {
    require?: { php?: string };
    config?: { platform?: { php?: string } };
  };
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.require?.php ?? "");
  const minimum = exactVersion(match?.[1], `${path}: require.php must declare >=major.minor.patch`);
  if (manifest.config?.platform?.php !== minimum)
    throw new Error(`${path}: config.platform.php must equal require.php's minimum`);
  return minimum;
}
