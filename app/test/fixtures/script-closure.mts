import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

/** Copy the actual local import graph so fixture setup follows entry-point ownership. */
export async function copyScriptClosure(root: string, destination: string, entry: string): Promise<void> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    write: false,
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const path = resolve(root, input),
      local = relative(root, path);
    if (local === ".." || local.startsWith(`..${sep}`))
      throw new Error("Fixture script import escapes its source root");
    const target = resolve(destination, local);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(path, target);
  }
}
