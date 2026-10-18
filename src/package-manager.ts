import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { readText } from "./core.js";
import { ownedPath } from "./paths.js";
import { userDirectory } from "./storage.js";
import { execute } from "./tool-downloads.js";
import { packageManagerPin } from "./toolchains.js";
import { withCacheLockSync } from "./cache-lock.js";
import { isDeepStrictEqual } from "node:util";
import { managedBootstrap, managedInputRepository, verifiedBootstrapSources } from "./managed-inputs.js";

interface BootstrapLock {
  lockfileVersion: number;
  packages: Record<string, { version?: string; resolved?: string; integrity?: string; bin?: Record<string, string> }>;
}

/** Resolve and validate bootstrap inputs without acquisition or execution. */
function bootstrapDefinition(directory: string, distribution: string) {
  const { name, version } = packageManagerPin(directory);
  const local = ownedPath(directory, "workbench/package-manager");
  const source = existsSync(local) ? local : ownedPath(distribution, "scripts/package-manager");
  const manifest = readFileSync(join(source, "package.json"));
  const lockBytes = readFileSync(join(source, "package-lock.json"));
  const declared = JSON.parse(manifest.toString()) as { dependencies?: Record<string, string> };
  const lock = JSON.parse(lockBytes.toString()) as BootstrapLock;
  const selected = lock.packages[`node_modules/${name}`];
  if (declared.dependencies?.[name] !== version || selected?.version !== version || lock.lockfileVersion !== 3)
    throw new Error(
      `${source}: bootstrap lock must match ${name}@${version}; refresh it with npm install --package-lock-only`,
    );
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (
      !entry.resolved?.startsWith("https://") ||
      !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? "")
    )
      throw new Error(`${source}: every bootstrap package requires HTTPS and a recorded strong integrity hash`);
  }
  // pnpm >=11 exposes a native placeholder as its bin; its documented Corepack entry uses the locked optional binary.
  const binary = name === "pnpm" && Number(version.split(".")[0]) >= 11 ? "bin/pnpm.mjs" : selected.bin?.[name];
  if (!binary) throw new Error(`${source}: bootstrap lock must declare the ${name} executable`);
  if (!/^[A-Za-z0-9._/-]+$/.test(binary)) throw new Error(`${source}: unsafe bootstrap executable path`);
  ownedPath(source, `node_modules/${name}/${binary}`);
  const identity = createHash("sha256").update("npm-ci-signatures-v2\0").update(manifest).update(lockBytes);
  const managed = managedInputRepository(directory);
  if (managed) {
    const bootstrap = managedBootstrap(managed);
    if (!isDeepStrictEqual(bootstrap.package_json, declared) || !isDeepStrictEqual(bootstrap.package_lock, lock))
      throw new Error("Managed package-manager inputs do not match the declared bootstrap lock");
    identity.update(readFileSync(join(managed.directory, "bootstrap.json")));
  }
  const digest = identity.digest("hex");
  const destination = join(
    userDirectory("cache"),
    "package-managers",
    name,
    version,
    `${process.platform}-${process.arch}`,
    digest,
  );
  return { name, version, binary, identity: digest, destination, manifest, lockBytes, managed };
}

export function packageManagerInstallationPlan(directory: string, distribution: string) {
  const { name, version, identity, destination } = bootstrapDefinition(directory, distribution);
  return { name, version, identity, directory: destination };
}

/** npm owns acquisition and extraction; Workbench selects a committed lock and an isolated installation. */
export async function packageManagerCommand(directory: string, distribution: string): Promise<string[]> {
  const { name, version, binary, identity, destination, manifest, lockBytes, managed } = bootstrapDefinition(
    directory,
    distribution,
  );
  const receipt = join(destination, ".workbench-bootstrap");
  const declaredSources =
    managed && !existsSync(destination) ? await verifiedBootstrapSources(managed, distribution) : undefined;
  return withCacheLockSync(destination, () => {
    if (!existsSync(destination)) {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const staging = `${destination}.${randomUUID()}.partial`;
      mkdirSync(staging, { mode: 0o700 });
      try {
        writeFileSync(join(staging, "package.json"), manifest);
        writeFileSync(join(staging, "package-lock.json"), lockBytes);
        const cache = process.env.npm_config_cache ?? join(userDirectory("cache"), "downloads", "npm");
        if (declaredSources) execute("npm", ["cache", "add", ...declaredSources, "--offline", "--cache", cache]);
        execute(
          "npm",
          [
            "ci",
            "--ignore-scripts",
            "--include=optional",
            "--no-audit",
            "--no-fund",
            ...(managed ? ["--offline", "--cache", cache] : []),
          ],
          { cwd: staging },
        );
        if (!managed) execute("npm", ["audit", "signatures"], { cwd: staging });
        const executable = ownedPath(staging, `node_modules/${name}/${binary}`);
        // Expose this same locked manager to nested package scripts, without depending on a global shim.
        const launchers = join(staging, "bin");
        mkdirSync(launchers);
        writeFileSync(
          join(launchers, name),
          `#!/bin/sh\nexec node "$(dirname "$0")/../node_modules/${name}/${binary}" "$@"\n`,
          { mode: 0o755 },
        );
        writeFileSync(
          join(launchers, `${name}.cmd`),
          `@node "%~dp0..\\node_modules\\${name}\\${binary.replaceAll("/", "\\")}" %*\r\n`,
        );
        const actual = execute("env", ["COREPACK_ENABLE_NETWORK=0", process.execPath, executable, "--version"], {
          capture: true,
        }).trim();
        if (actual !== version) throw new Error(`${staging}: expected ${name} ${version}, received ${actual}`);
        writeFileSync(join(staging, ".workbench-bootstrap"), identity);
        try {
          renameSync(staging, destination);
        } catch (error) {
          if (!existsSync(receipt) || readText(receipt) !== identity) throw error;
        }
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    if (!existsSync(receipt) || readText(receipt) !== identity)
      throw new Error(`${destination}: incomplete package-manager installation; remove it explicitly and retry`);
    const executable = ownedPath(destination, `node_modules/${name}/${binary}`);
    if (
      ![executable, join(destination, "bin", name), join(destination, "bin", `${name}.cmd`)].every((path) =>
        existsSync(path),
      )
    )
      throw new Error(`${destination}: missing package-manager executable or launcher`);
    // Never let pnpm's wrapper fetch an unpinned replacement when npm could not install its optional binary.
    const nativePath = `${join(destination, "bin")}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`;
    // GNU env runs under Git Bash, whose PATH uses POSIX paths; MSYS converts it for the native Node child.
    const path =
      process.platform === "win32"
        ? execute("cygpath", ["-p", "-u", nativePath], { capture: true }).trim()
        : nativePath;
    return [
      "env",
      "COREPACK_ENABLE_NETWORK=0",
      ...(process.env.WORKBENCH_OFFLINE === "1" && !managed ? ["PNPM_CONFIG_OFFLINE=true"] : []),
      `PATH=${path}`,
      process.execPath,
      executable,
    ];
  });
}
