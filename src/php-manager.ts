import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { readText } from "./core.js";
import { assetFor } from "./native-assets.js";
import { download, execute } from "./tool-downloads.js";
import { exactVersion } from "./toolchains.js";
import { required } from "./invariants.js";

/** Composer owns package installation; a trusted local plugin checks downloaded archives before extraction. */
export async function composerBootstrap(directory: string, distribution: string): Promise<string> {
  let root = directory;
  while (!existsSync(join(root, ".composer-version")) && dirname(root) !== root) root = dirname(root);
  const version = exactVersion(readText(join(root, ".composer-version")).trim(), ".composer-version");
  const artifact = required(
    assetFor(distribution, { name: "composer", version, source: ".composer-version" }),
    "missing verified Composer bootstrap",
  );
  const phar = await download(artifact);
  const actual = execute("php", [phar, "--version", "--no-ansi"], { capture: true }).trim();
  if (!actual.startsWith(`Composer version ${version} `))
    throw new Error(`expected Composer ${version}, received ${actual}`);
  return phar;
}

export async function executeComposer(directory: string, distribution: string, args: string[]): Promise<void> {
  const phar = await composerBootstrap(directory, distribution);
  execute("php", [phar, ...args], { cwd: directory, env: { ...process.env, COMPOSER_ALLOW_SUPERUSER: "1" } });
}
