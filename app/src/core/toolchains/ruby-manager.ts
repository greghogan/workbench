import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readText } from "../runtime/files.js";
import { assetFor } from "./native/native-assets.js";
import { withCacheLock } from "../storage/cache-lock.js";
import { userDirectory } from "../storage/storage.js";
import { download } from "./tool-downloads.js";
import { execute } from "./tool-execution.js";
import { required } from "../runtime/invariants.js";
import { acquisitionIdentity } from "./acquisition/artifact-policy.js";
import { rubyLockChecksums } from "../execution/environments/managed/managed-check-inputs.mjs";
import { hashFile } from "../runtime/file-reads.js";
import { createOwnedScratch } from "../runtime/owned-scratch.mjs";
import { ownedPath } from "../runtime/paths.js";
import { writeAtomic } from "../runtime/file-publication.mjs";

const gemReceipt = ".workbench-gems";

export function usesRubyCheckInstallation(
  directory: string,
  distribution: string,
  setup: readonly { directory: string; command: readonly string[] }[],
): boolean {
  const expected = ["node", "scripts/check.mjs", "setup", "{workbench}"];
  if (
    !setup.some(
      ({ directory: path, command }) =>
        path === directory && command.length === expected.length && expected.every((value, i) => command[i] === value),
    )
  )
    return false;
  const runner = join(directory, "scripts/check.mjs");
  const reference = join(distribution, "examples/languages/ruby/scripts/check.mjs");
  return (
    existsSync(runner) &&
    (runner === reference || (existsSync(reference) && readFileSync(runner).equals(readFileSync(reference))))
  );
}

/** The reference setup and its isolated consumers select the same installed dependency graph. */
export function rubyCheckInstallation(authority: string, ruby: string, env: NodeJS.ProcessEnv) {
  const manifest = join(authority, "Gemfile");
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        ruby,
        existsSync(manifest) ? readText(manifest) : null,
        readText(join(authority, "Gemfile.lock")),
      ]),
    )
    .digest("hex");
  const base =
    env.BUNDLE_PATH ??
    (env.WORKBENCH_DEPENDENCIES_DIR
      ? join(env.WORKBENCH_DEPENDENCIES_DIR, "ruby")
      : join(userDirectory("cache"), "dependencies", "ruby", createHash("sha256").update(authority).digest("hex")));
  return { path: ownedPath(base, identity.slice(0, 24)), identity };
}

export function bundlerVersion(directory: string): string {
  const version = /\nBUNDLED WITH\n +([0-9]+\.[0-9]+\.[0-9]+)\s*$/.exec(readText(join(directory, "Gemfile.lock")))?.[1];
  return required(version, "Gemfile.lock must pin BUNDLED WITH to an exact version");
}

export function bundlerInstallation(directory: string, distribution: string, env: NodeJS.ProcessEnv = process.env) {
  const authority = env.BUNDLE_GEMFILE ? dirname(resolve(env.BUNDLE_GEMFILE)) : directory;
  if (env.BUNDLE_FROZEN !== "false" && !/^CHECKSUMS\n/m.test(readText(join(authority, "Gemfile.lock"))))
    throw new Error("Frozen Bundler installs require a CHECKSUMS section; refresh the lock explicitly");
  const version = bundlerVersion(authority);
  const asset = required(
    assetFor(distribution, { name: "bundler", version, source: "Gemfile.lock" }),
    "missing verified Bundler bootstrap",
  );
  const ruby = execute(
    "ruby",
    ["-e", `print [RUBY_ENGINE, RUBY_VERSION, RUBY_PLATFORM, RbConfig::CONFIG.fetch("prefix")].join(':')`],
    { capture: true, env },
  ).trim();
  const identity = createHash("sha256").update(ruby).update(acquisitionIdentity(asset)).digest("hex");
  // Keep generated extension paths within Windows tool limits; receipts retain the complete digest.
  const key = identity.slice(0, 24);
  const cache = userDirectory("cache");
  return {
    authority,
    version,
    asset,
    identity,
    key,
    destination: join(cache, "package-managers", "bundler", version, key),
    downloads: join(cache, "downloads", "bundler", key),
  };
}

/** Bundler's local install reads a flat cache; only archives matching the frozen lock may be supplied. */
export function stageBundlerArchives(directory: string, downloads: string, destination: string): void {
  const checksums = new Map(rubyLockChecksums(directory).map(({ archive, checksum }) => [archive, checksum]));
  const registries = join(downloads, "gems");
  mkdirSync(destination);
  if (!existsSync(registries)) return;
  for (const registry of readdirSync(registries, { withFileTypes: true })) {
    if (!registry.isDirectory()) continue;
    const source = join(registries, registry.name);
    for (const gem of readdirSync(source, { withFileTypes: true })) {
      const expected = checksums.get(gem.name);
      if (!gem.isFile() || !expected) continue;
      const path = join(source, gem.name);
      if (hashFile(path) !== expected) continue;
      const target = join(destination, gem.name);
      copyFileSync(path, target, constants.COPYFILE_FICLONE);
      if (hashFile(target) !== expected) throw new Error(`Prepared gem changed during staging: ${gem.name}`);
      checksums.delete(gem.name);
    }
  }
}

/** RubyGems installs the verified local bootstrap gem; Bundler owns application resolution and extraction. */
export async function executeBundler(directory: string, distribution: string, args: string[]): Promise<void> {
  if (process.platform === "win32" && process.env.WORKBENCH_NATIVE_UTF8_CONSOLE !== "1") {
    // Ruby's locale encoding also governs paths passed to workers such as Rake's test subprocess.
    const { runWindowsUtf8Console } = await import("../runtime/windows-utf8-console.mjs");
    await runWindowsUtf8Console(
      [join(distribution, "bin/workbench.mjs"), "ruby-package-manager-exec", "--", ...args],
      process.env.WORKBENCH_BUILD_DIR ?? join(userDirectory("cache"), "console"),
      directory,
    );
    return;
  }
  const { authority, version, asset, identity, key, destination, downloads } = bundlerInstallation(
    directory,
    distribution,
  );
  const receipt = join(destination, ".workbench-bootstrap");
  const verify = () => {
    if (!existsSync(receipt) || readText(receipt) !== identity)
      throw new Error("incomplete Bundler bootstrap; run workbench prepare");
  };
  if (process.env.WORKBENCH_CHECK_SCOPED === "1") verify();
  else
    await withCacheLock(destination, async () => {
      if (!existsSync(destination)) {
        const archive = await download(asset);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        const stage = `${destination}.${randomUUID()}.partial`;
        mkdirSync(stage, { mode: 0o700 });
        try {
          execute("ruby", [
            "-S",
            "gem",
            "install",
            "--local",
            archive,
            "--install-dir",
            stage,
            "--ignore-dependencies",
            "--no-document",
          ]);
          writeFileSync(join(stage, ".workbench-bootstrap"), identity);
          renameSync(stage, destination);
        } finally {
          rmSync(stage, { recursive: true, force: true });
        }
      }
      verify();
    });
  const standardSetup =
    args.length === 3 && args[0] === "install" && args[1] === "--jobs" && /^\d+$/.test(args[2] ?? "");
  const frozen = process.env.BUNDLE_FROZEN !== "false";
  const gems =
    frozen && process.env.WORKBENCH_CHECK_SCOPED !== "1" && process.env.BUNDLE_GEMFILE
      ? rubyCheckInstallation(authority, key, process.env)
      : undefined;
  const prepared = process.env.WORKBENCH_CHECK_SCOPED === "1" ? process.env.WORKBENCH_CHECK_PREPARED_GEMS : undefined;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Ruby encodes filenames and load paths from the locale, independently of -E.
    ...(process.platform === "win32"
      ? {}
      : {
          LANG: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
          LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
        }),
    ...(process.env.WORKBENCH_CHECK_INPUTS
      ? { BUNDLE_CACHE_PATH: join(process.env.WORKBENCH_CHECK_INPUTS, "gems") }
      : {}),
    GEM_HOME: destination,
    GEM_PATH: destination,
    // Bundler and its Ruby workers exchange UTF-8 paths even when the host uses the C locale.
    RUBYOPT: "-EUTF-8:UTF-8",
    // Both downloaded extension caches and installed gems depend on this runtime's SDK ABI.
    BUNDLE_PATH:
      prepared ??
      gems?.path ??
      join(
        process.env.BUNDLE_PATH ??
          join(userDirectory("cache"), "dependencies", "ruby", createHash("sha256").update(authority).digest("hex")),
        key,
      ),
    BUNDLE_VERSION: version,
    BUNDLE_FROZEN: process.env.BUNDLE_FROZEN ?? "true",
    BUNDLE_DISABLE_VERSION_CHECK: "true",
    BUNDLE_LOCKFILE_CHECKSUMS: "true",
    BUNDLE_DISABLE_CHECKSUM_VALIDATION: "false",
    BUNDLE_GLOBAL_GEM_CACHE: "true",
    BUNDLE_USER_CACHE:
      process.env.WORKBENCH_CHECK_SCOPED === "1" ? (process.env.BUNDLE_USER_CACHE ?? downloads) : downloads,
  };
  const executable = join(destination, "gems", `bundler-${version}`, "exe", "bundle");
  const actual = execute("ruby", [executable, "--version"], { env, capture: true }).trim();
  if (actual !== version && actual !== `Bundler version ${version}`)
    throw new Error(`expected Bundler ${version}, received ${actual}`);
  if (prepared && standardSetup) {
    const expected = rubyCheckInstallation(authority, key, process.env).identity;
    if (readText(join(prepared, gemReceipt)) !== expected)
      throw new Error("Prepared Ruby gems do not match this checkout");
    execute("ruby", [executable, "check"], { cwd: directory, env });
    return;
  }
  const offlineInstall =
    args[0] === "install" &&
    (process.env.WORKBENCH_CHECK_INPUTS !== undefined || process.env.WORKBENCH_OFFLINE === "1");
  const run = () => {
    const staged =
      offlineInstall && !env.BUNDLE_CACHE_PATH ? createOwnedScratch(tmpdir(), "workbench-gems") : undefined;
    try {
      if (staged) {
        env.BUNDLE_CACHE_PATH = join(staged.directory, "gems");
        stageBundlerArchives(authority, downloads, env.BUNDLE_CACHE_PATH);
      }
      execute(
        "ruby",
        args[0] === "exec" && args[1] === "ruby"
          ? [
              // Bundler's native exec starts another Ruby process, which can lose a private Windows console's
              // locale. Preloading its standard setup keeps dependency activation and the selected interpreter
              // in this process, including Unicode working directories and load paths.
              "-I",
              join(destination, "gems", `bundler-${version}`, "lib"),
              "-rbundler/setup",
              ...args.slice(2),
            ]
          : [executable, ...args, ...(offlineInstall ? ["--local"] : [])],
        { cwd: directory, env },
      );
    } finally {
      staged?.release();
    }
  };
  if (!gems || !standardSetup) {
    run();
    return;
  }
  await withCacheLock(gems.path, async () => {
    const verified = join(gems.path, gemReceipt);
    if (existsSync(verified) && readText(verified) === gems.identity) {
      try {
        execute("ruby", [executable, "check"], { cwd: directory, env, capture: true });
        return;
      } catch {
        // Bundler will repair an incomplete installation from the verified archives.
      }
    }
    rmSync(verified, { force: true });
    run();
    if (rubyCheckInstallation(authority, key, process.env).identity !== gems.identity)
      throw new Error("Ruby dependency declarations changed during installation");
    await mkdir(gems.path, { recursive: true, mode: 0o700 });
    writeAtomic(verified, gems.identity, 0o600);
  });
}
