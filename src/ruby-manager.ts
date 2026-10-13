import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readText } from "./core.js";
import { assetFor } from "./native-assets.js";
import { withCacheLock } from "./cache-lock.js";
import { userDirectory } from "./storage.js";
import { download, execute } from "./tool-downloads.js";
import { required } from "./invariants.js";
import { acquisitionIdentity } from "./artifact-policy.js";

export function bundlerVersion(directory: string): string {
  const version = /\nBUNDLED WITH\n +([0-9]+\.[0-9]+\.[0-9]+)\s*$/.exec(readText(join(directory, "Gemfile.lock")))?.[1];
  return required(version, "Gemfile.lock must pin BUNDLED WITH to an exact version");
}

/** RubyGems installs the verified local bootstrap gem; Bundler owns application resolution and extraction. */
export async function executeBundler(directory: string, distribution: string, args: string[]): Promise<void> {
  const authority = process.env.BUNDLE_GEMFILE ? dirname(resolve(process.env.BUNDLE_GEMFILE)) : directory;
  const version = bundlerVersion(authority);
  if (process.env.BUNDLE_FROZEN !== "false" && !/^CHECKSUMS\n/m.test(readText(join(authority, "Gemfile.lock"))))
    throw new Error("Frozen Bundler installs require a CHECKSUMS section; refresh the lock explicitly");
  const asset = required(
    assetFor(distribution, { name: "bundler", version, source: "Gemfile.lock" }),
    "missing verified Bundler bootstrap",
  );
  const ruby = execute(
    "ruby",
    ["-e", `print [RUBY_ENGINE, RUBY_VERSION, RUBY_PLATFORM, RbConfig::CONFIG.fetch("prefix")].join(':')`],
    {
      capture: true,
    },
  ).trim();
  const identity = createHash("sha256").update(ruby).update(acquisitionIdentity(asset)).digest("hex");
  // Keep generated extension paths within Windows tool limits; receipts retain the complete digest.
  const key = identity.slice(0, 24);
  const destination = join(userDirectory("cache"), "package-managers", "bundler", version, key);
  const receipt = join(destination, ".workbench-bootstrap");
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
    if (!existsSync(receipt) || readText(receipt) !== identity) throw new Error("incomplete Bundler bootstrap");
  });
  const env = {
    ...process.env,
    GEM_HOME: destination,
    GEM_PATH: destination,
    // Both downloaded extension caches and installed gems depend on this runtime's SDK ABI.
    BUNDLE_PATH: join(
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
    BUNDLE_USER_CACHE: join(userDirectory("cache"), "downloads", "bundler", key),
  };
  const executable = join(destination, "gems", `bundler-${version}`, "exe", "bundle");
  const actual = execute("ruby", [executable, "--version"], { env, capture: true }).trim();
  if (actual !== version && actual !== `Bundler version ${version}`)
    throw new Error(`expected Bundler ${version}, received ${actual}`);
  execute("ruby", [executable, ...args], { cwd: directory, env });
}
