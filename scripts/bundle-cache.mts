import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import { writeAtomic } from "../app/src/core/runtime/file-publication.mjs";
import { isRecord } from "../app/src/core/runtime/values.mjs";
import { bundleEntries, bundles } from "../app/src/core/distribution/bundle-layout.mts";

export const bundleCacheFile = "bundle/.workbench-build.json";
export const developmentToolingReceipt = "bundle/.workbench-tooling.json";
const bundleIgnore = ".workbench-build.json\n.workbench-tooling.json\n";
const roots = ["app/src", "app/test/integration/consumers", "scripts", "bin"];
const configuration = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".pnpmfile.cjs",
  ".npmrc",
  "tsconfig.json",
  ".node-version",
  ".prettierrc.json",
  "workbench/config.toml",
];

/** Canonical sources and build inputs identify disposable bundles; emitted helpers do not. */
export function bundleInputDigest(root: string): string {
  const files = new Set(configuration);
  const visit = (path: string) => {
    if (!existsSync(join(root, path))) return;
    const metadata = lstatSync(join(root, path));
    if (metadata.isFile() || metadata.isSymbolicLink()) {
      const source = path.replace(/\.mjs$/, ".mts").replace(/\.cjs$/, ".cts");
      if (source !== path && existsSync(join(root, source))) return;
    }
    if (metadata.isSymbolicLink()) throw new Error(`${path}: symbolic-link bundle inputs cannot be cached`);
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(join(root, path)))
        if (!["node_modules", "build", "dist", ".git"].includes(entry)) visit(`${path}/${entry}`);
    } else if (metadata.isFile()) files.add(path);
  };
  for (const path of roots) visit(path);
  const hash = createHash("sha256").update("workbench-portable-bundles-v2\0");
  for (const path of [...files].sort()) {
    hash.update(path + "\0");
    if (existsSync(join(root, path))) {
      if (configuration.includes(path) && lstatSync(join(root, path)).isSymbolicLink())
        throw new Error(`${path}: symbolic-link bundle inputs cannot be cached`);
      const bytes = readFileSync(join(root, path));
      hash.update(String(bytes.length) + "\0").update(bytes);
    } else hash.update("absent\0");
  }
  return hash.digest("hex");
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
interface BundleCache {
  version: 1;
  inputs: string;
  outputs: Record<string, string>;
}

export function saveBundleCache(
  root: string,
  inputs: string,
  outputs: readonly { path: string; contents: Uint8Array }[],
): void {
  if (bundleInputDigest(root) !== inputs)
    throw new Error("Source changed during bundle construction; rebuild with stable inputs");
  const receipt: BundleCache = {
    version: 1,
    inputs,
    outputs: Object.fromEntries(outputs.map((file) => [file.path, digest(file.contents)])),
  };
  writeAtomic(join(root, bundleCacheFile), JSON.stringify(receipt) + "\n");
  writeAtomic(join(root, "bundle/.npmignore"), bundleIgnore);
}

/** Reuse only complete, intact outputs for identical source and build inputs. */
export function reuseBundles(
  source: string,
  destination = source,
  { receiptFile = bundleCacheFile, destinationInputs = () => bundleInputDigest(destination) } = {},
): boolean {
  let value: unknown;
  try {
    const path = join(source, receiptFile);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536) return false;
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code)))
    )
      return false;
    throw error;
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.inputs !== "string" || !isRecord(value.outputs))
    return false;
  const entries = Object.entries(value.outputs);
  const outputs = value.outputs;
  if (
    !bundleEntries.every((name) => {
      if (!Object.hasOwn(outputs, `bundle/${name}.cjs`)) return false;
      const payloads = ["br", "gz", "zst"].filter((suffix) => Object.hasOwn(outputs, `bundle/${name}.cjs.${suffix}`));
      return bundles[name].compression === "none"
        ? payloads.length === 0
        : payloads.length === 1 && (bundles[name].compression !== "brotli" || payloads[0] === "br");
    }) ||
    !Object.hasOwn(outputs, "bundle/THIRD_PARTY_NOTICES.txt") ||
    entries.length !==
      bundleEntries.length + bundleEntries.filter((name) => bundles[name].compression !== "none").length + 1
  )
    return false;
  const files: { path: string; bytes: Buffer }[] = [];
  let total = 0;
  for (const [path, expected] of entries) {
    if (
      !/^bundle\/[A-Za-z0-9_.-]+$/.test(path) ||
      posix.normalize(path) !== path ||
      path === bundleCacheFile ||
      typeof expected !== "string" ||
      !/^[a-f0-9]{64}$/.test(expected)
    )
      return false;
    try {
      const metadata = lstatSync(join(source, path));
      total += metadata.size;
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > 16 * 1024 * 1024 ||
        total > 64 * 1024 * 1024
      )
        return false;
      const bytes = readFileSync(join(source, path));
      if (digest(bytes) !== expected) return false;
      files.push({ path, bytes });
    } catch (error) {
      if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))) return false;
      throw error;
    }
  }
  if (destinationInputs() !== value.inputs) return false;
  const obsolete = bundleEntries.flatMap((name) =>
    ["br", "gz", "zst"].map((suffix) => `bundle/${name}.cjs.${suffix}`).filter((path) => !Object.hasOwn(outputs, path)),
  );
  if (destination === source && obsolete.some((path) => existsSync(join(destination, path)))) return false;
  if (destination !== source) {
    for (const { path, bytes } of files) writeAtomic(join(destination, path), bytes);
    for (const path of obsolete) rmSync(join(destination, path), { force: true });
    writeAtomic(join(destination, bundleCacheFile), JSON.stringify(value) + "\n");
    writeAtomic(join(destination, "bundle/.npmignore"), bundleIgnore);
  }
  return true;
}
