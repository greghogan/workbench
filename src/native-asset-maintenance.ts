import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { readLanguageRoots, readText, writeAtomic } from "./core.js";
import { nativeTools } from "./native-assets.js";
import { exactVersion } from "./toolchains.js";
import { bundlerVersion } from "./ruby-manager.js";
import { rubyMinimum, phpMinimum } from "./script-language-config.js";
import { javaSupport } from "./java-config.js";

/** Calculate a replacement without writing; callers may format it before atomic publication. */
export function nativeAssetPruningPlan(root: string) {
  const path = join(root, "scripts/native-assets.json");
  const original = readText(path);
  const inventory = JSON.parse(original) as Record<string, Record<string, unknown>>;
  const needed = new Map<string, Set<string>>();
  const retain = (name: string, version: string) => {
    if (["python", "rust", "miri", "llvm", "clang"].includes(name)) return;
    if (!inventory[name]?.[version])
      throw new Error(`${path}: missing required ${name} ${version}; inventory was not pruned`);
    const versions = needed.get(name) ?? new Set<string>();
    versions.add(version);
    needed.set(name, versions);
  };
  const roots = readLanguageRoots(root);
  for (const directory of new Set([root, ...roots.map((entry) => resolve(root, entry.path))])) {
    for (const platform of ["linux", "darwin", "win32"] as const)
      for (const tool of nativeTools(directory, root, {}, platform)) retain(tool.name, tool.version);
    if (existsSync(join(directory, "Gemfile.lock"))) retain("bundler", bundlerVersion(directory));
    if (existsSync(join(directory, ".composer-version")))
      retain("composer", exactVersion(readText(join(directory, ".composer-version")).trim(), ".composer-version"));
    if (existsSync(join(directory, ".xdebug-version")))
      retain("xdebug", exactVersion(readText(join(directory, ".xdebug-version")).trim(), ".xdebug-version"));
    const gcc = join(directory, ".gcc-version");
    if (existsSync(gcc)) retain("gcc", exactVersion(readText(gcc).trim(), gcc));
  }
  for (const entry of roots)
    for (const [family, support] of Object.entries(entry.compilers ?? {}))
      for (const version of [support.minimum, ...support.ci_versions]) {
        retain(family, version);
        for (const tool of nativeTools(
          resolve(root, entry.path),
          root,
          { compiler: family, compilerVersion: version },
          "linux",
        ))
          retain(tool.name, tool.version);
      }
  for (const entry of roots) {
    if (
      entry.ci_compatibility === false ||
      !["typescript", "javascript", "go", "java", "ruby", "php"].includes(entry.language)
    )
      continue;
    const directory = resolve(root, entry.path);
    const runtime = ["typescript", "javascript"].includes(entry.language) ? "node" : entry.language;
    const manifest = join(
      directory,
      runtime === "node"
        ? "package.json"
        : runtime === "java"
          ? "pom.xml"
          : runtime === "ruby"
            ? "Gemfile"
            : runtime === "php"
              ? "composer.json"
              : "go.mod",
    );
    let minimum: string | undefined;
    if (existsSync(manifest)) {
      minimum =
        runtime === "php"
          ? phpMinimum(directory)
          : runtime === "ruby"
            ? rubyMinimum(directory)
            : runtime === "java"
              ? javaSupport(directory).minimum
              : runtime === "node"
                ? /^>=(\d+\.\d+\.\d+)$/.exec(
                    (JSON.parse(readText(manifest)) as { engines?: { node?: string } }).engines?.node ?? "",
                  )?.[1]
                : /^go (\d+\.\d+\.\d+)$/m.exec(readText(manifest))?.[1];
    }
    for (const version of new Set([...(entry.ci_versions ?? []), ...(minimum ? [minimum] : [])]))
      retain(runtime, version);
  }
  const bootstrap = JSON.parse(readText(join(root, "scripts/bootstrap-tools.json"))) as Record<string, string>;
  for (const [name, version] of Object.entries(bootstrap)) retain(name, exactVersion(version, "bootstrap-tools.json"));
  const removed: string[] = [];
  for (const [name, versions] of Object.entries(inventory)) {
    if (!Object.keys(versions).length) removed.push(name);
    for (const version of Object.keys(versions))
      if (!needed.get(name)?.has(version)) {
        removed.push(`${name}@${version}`);
        Reflect.deleteProperty(versions, version);
      }
    if (!Object.keys(versions).length) Reflect.deleteProperty(inventory, name);
  }
  return { original, inventory, removed };
}

/** One conflict-checked write path for both plain and build-formatted replacements. */
export function publishNativeAssets(root: string, original: string, contents: string): string[] {
  const path = join(root, "scripts/native-assets.json");
  const plan = nativeAssetPruningPlan(root);
  if (plan.original !== original) throw new Error(`${path}: changed during pruning; retry`);
  if (!isDeepStrictEqual(JSON.parse(contents), plan.inventory))
    throw new Error(`${path}: formatted replacement differs from the pruning plan`);
  if (readText(path) !== original) throw new Error(`${path}: changed during pruning; retry`);
  if (contents !== original) writeAtomic(path, contents);
  return plan.removed;
}

/** Prune versions, preserving every published platform of each still-required native tool. */
export function pruneNativeAssets(root: string, check = false): string[] {
  const { original, inventory, removed } = nativeAssetPruningPlan(root);
  if (check && removed.length)
    throw new Error(
      `${join(root, "scripts/native-assets.json")}: obsolete native assets: ${removed.join(", ")}; run pnpm run build`,
    );
  if (!check && removed.length) publishNativeAssets(root, original, `${JSON.stringify(inventory, null, 2)}\n`);
  return removed;
}
