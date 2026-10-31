import { build } from "esbuild";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bundleOptions } from "./bundle-options.mjs";
import { bundleArtifacts, bundleCompression, bundleFormats } from "./bundle-artifacts.mjs";
import { bundleLicenses, noticesPath } from "./bundle-licenses.mjs";
import { stageFile, type StagedFile } from "./file-publication.mjs";
import { combineFailures } from "./diagnostic-errors.mjs";

export const compressedBundles = ["main", "skills", "package", "consumer", "bootstrap"] as const;
export const bundleEntries = [...compressedBundles, "launcher"] as const;
export interface BundleOutput {
  path: string;
  contents: Uint8Array;
  kind: "payload" | "loader" | "metadata";
}
export interface BundleSet {
  outputs: BundleOutput[];
  obsolete: string[];
  scripts: { path: string; contents: string }[];
  references: { origin: string; path: string }[];
}

/** Build and verify consume the same complete candidates; compilation never publishes files. */
export async function compileBundles(root: string): Promise<BundleSet> {
  const inputs = new Set<string>();
  const set: BundleSet = { outputs: [], obsolete: [], scripts: [], references: [] };
  const compression = bundleCompression(root);
  for (const name of bundleEntries) {
    const result = await build({ ...bundleOptions(root, name), write: false });
    const output = result.outputFiles[0];
    if (!output) throw new Error(`Missing bundle output: ${name}`);
    for (const input of Object.keys(result.metafile.inputs)) inputs.add(input);
    const path = `bundle/${name}.cjs`;
    set.scripts.push({ path, contents: output.text });
    if (name === "launcher") {
      set.outputs.push({ path, contents: output.contents, kind: "loader" });
      continue;
    }
    const selected = name === "bootstrap" ? "brotli" : compression;
    for (const [file, contents] of bundleArtifacts(name, output.contents, selected))
      set.outputs.push({ path: `bundle/${file}`, contents, kind: file.endsWith(".cjs") ? "loader" : "payload" });
    set.references.push({ origin: path, path: `${path}.${bundleFormats[selected]}` });
    for (const extension of Object.values(bundleFormats))
      if (extension !== bundleFormats[selected]) set.obsolete.push(`${path}.${extension}`);
  }
  set.outputs.push({ path: noticesPath, contents: Buffer.from(bundleLicenses(root, inputs)), kind: "metadata" });
  const order = { payload: 0, loader: 1, metadata: 2 };
  set.outputs.sort((a, b) => order[a.kind] - order[b.kind]);
  return set;
}

/** Every candidate is closed before activation; payloads precede the loaders that reference them. */
export function publishBundles(root: string, set: BundleSet): void {
  const staged: { output: BundleOutput; file: StagedFile }[] = [];
  let failure: unknown;
  let failed = false;
  try {
    for (const output of set.outputs)
      staged.push({ output, file: stageFile(join(root, output.path), output.contents, 0o644) });
    for (const kind of ["payload", "loader", "metadata"] as const)
      for (const entry of staged) if (entry.output.kind === kind) entry.file.publish();
    for (const path of set.obsolete) rmSync(join(root, path), { force: true });
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanup: unknown[] = [];
  for (const entry of staged)
    try {
      entry.file.discard();
    } catch (error) {
      cleanup.push(error);
    }
  if (cleanup.length) {
    const error = new AggregateError(cleanup, "Bundle staging cleanup failed");
    throw failed ? combineFailures(failure, error, "Bundle publication and cleanup failed") : error;
  }
  if (failed) throw failure;
}

export function verifyBundles(root: string, set: BundleSet): void {
  for (const output of set.outputs)
    if (
      !existsSync(join(root, output.path)) ||
      !readFileSync(join(root, output.path)).equals(Buffer.from(output.contents))
    )
      throw new Error(`${output.path} is stale; run pnpm run bundle:build`);
  for (const path of set.obsolete)
    if (existsSync(join(root, path))) throw new Error(`${path} is obsolete; run pnpm run bundle:build`);
}
