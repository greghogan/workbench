import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { combineFailures } from "../app/src/core/diagnostics/diagnostic-errors.mjs";
import { stageFile, writeAtomic, type StagedFile } from "../app/src/core/runtime/file-publication.mjs";
import {
  bundleLoader,
  encodeBundle,
  bundleCompression,
  bundleEntries,
  bundleFormats,
  bundles,
  decodeBundle,
  type BundleCompression,
} from "../app/src/core/distribution/bundle-artifacts.mjs";
import { bundleLicenses, noticesPath, verifyBundleRuntime } from "./bundle-licenses.mjs";
import { bundleOptions, bundleRuntime } from "./bundle-options.mjs";
import { bundleInputDigest, saveBundleCache } from "./bundle-cache.mts";
export { bundleEntries, compressedBundles } from "../app/src/core/distribution/bundle-artifacts.mjs";

export type BundleOutput = { path: string; contents: Uint8Array } & (
  { kind: "payload"; compression: BundleCompression } | { kind: "loader" | "metadata" }
);
export interface BundleSet {
  inputs: string;
  outputs: BundleOutput[];
  obsolete: string[];
  scripts: { path: string; contents: string }[];
  references: { origin: string; path: string }[];
}

/** Build and verify consume the same complete candidates; compilation never publishes files. */
export async function compileBundles(root: string, signal?: AbortSignal, sourceInputs?: string): Promise<BundleSet> {
  signal?.throwIfAborted();
  const inputs = new Set<string>();
  const set: BundleSet = {
    inputs: sourceInputs ?? bundleInputDigest(root),
    outputs: [],
    obsolete: [],
    scripts: [],
    references: [],
  };
  const compression = bundleCompression(root);
  for (const name of bundleEntries) {
    signal?.throwIfAborted();
    const result = await build({ ...bundleOptions(root, name), write: false });
    signal?.throwIfAborted();
    verifyBundleRuntime(root, name, result.metafile, bundleRuntime(name));
    const output = result.outputFiles[0];
    if (!output) throw new Error(`Missing bundle output: ${name}`);
    for (const input of Object.keys(result.metafile.inputs)) inputs.add(input);
    const path = `bundle/${name}.cjs`;
    set.scripts.push({ path, contents: output.text });
    if (bundles[name].compression === "none") {
      set.outputs.push({ path, contents: output.contents, kind: "loader" });
      for (const extension of Object.values(bundleFormats)) set.obsolete.push(`${path}.${extension}`);
      continue;
    }
    const selected = bundles[name].compression === "brotli" ? "brotli" : compression;
    const payload = `${path}.${bundleFormats[selected]}`;
    set.outputs.push(
      { path, contents: bundleLoader(selected), kind: "loader" },
      { path: payload, contents: output.contents, kind: "payload", compression: selected },
    );
    set.references.push({ origin: path, path: payload });
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
  if (bundleInputDigest(root) !== set.inputs)
    throw new Error("Source changed during bundle construction; rebuild with stable inputs");
  const outputs = set.outputs.map((output) =>
    output.kind === "payload" ? { ...output, contents: encodeBundle(output.contents, output.compression) } : output,
  );
  const staged: { output: BundleOutput; file: StagedFile }[] = [];
  let failure: unknown;
  let failed = false;
  try {
    for (const output of outputs)
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
  saveBundleCache(root, set.inputs, outputs);
}

export function verifyBundles(root: string, set: BundleSet): void {
  for (const output of set.outputs) {
    const path = join(root, output.path);
    if (!existsSync(path)) throw new Error(`${output.path} is stale; run pnpm run bundle:build`);
    const actual = readFileSync(path);
    const expected = Buffer.from(output.contents);
    if (output.kind !== "payload" && actual.equals(expected)) continue;
    let cause: unknown;
    if (output.kind === "payload") {
      try {
        const decoded = decodeBundle(actual, output.compression);
        // Compression streams can differ across hosts; executed JavaScript must remain byte-identical.
        if (decoded.equals(expected)) continue;
        const directory = join(root, "coverage", "bundle-parity");
        const hash = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");
        const mismatch = new Error(
          `JavaScript differs (expected ${hash(expected)}, committed ${hash(decoded)}); diagnostic directory: ${directory}`,
        );
        cause = mismatch;
        try {
          for (const path of [join(root, "coverage"), directory]) {
            if (!existsSync(path)) mkdirSync(path);
            if (!lstatSync(path).isDirectory())
              throw new Error(`Bundle diagnostic path must be a real directory: ${path}`);
          }
          const name = output.path.split("/").at(-1) ?? "payload";
          writeAtomic(join(directory, name + ".expected.cjs"), expected);
          writeAtomic(join(directory, name + ".committed.cjs"), decoded);
        } catch (error) {
          cause = combineFailures(mismatch, error, "Bundle JavaScript differs and diagnostics could not be retained");
        }
      } catch (error) {
        cause = error;
      }
    }
    throw new Error(`${output.path} is stale; run pnpm run bundle:build`, cause === undefined ? undefined : { cause });
  }
  for (const path of set.obsolete)
    if (existsSync(join(root, path))) throw new Error(`${path} is obsolete; run pnpm run bundle:build`);
}
