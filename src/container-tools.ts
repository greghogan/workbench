import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withCacheLockSync } from "./cache-lock.js";
import { ownedPath } from "./paths.js";
import { userDirectory } from "./storage.js";
import { execute } from "./tool-downloads.js";

const packageName = "@devcontainers/cli";

function definition(distribution: string) {
  const source = join(distribution, "scripts/container-tools");
  const manifest = readFileSync(join(source, "package.json"));
  const lockBytes = readFileSync(join(source, "package-lock.json"));
  const declared = JSON.parse(manifest.toString()) as { dependencies?: Record<string, string> };
  const lock = JSON.parse(lockBytes.toString()) as {
    lockfileVersion: number;
    packages: Record<
      string,
      { version?: string; resolved?: string; integrity?: string; bin?: { devcontainer?: string } }
    >;
  };
  const version = declared.dependencies?.[packageName];
  const selected = lock.packages[`node_modules/${packageName}`];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version) || lock.lockfileVersion !== 3 || selected?.version !== version)
    throw new Error(`${source}: Dev Container bootstrap requires a matching exact manifest and npm lock`);
  for (const [path, entry] of Object.entries(lock.packages))
    if (
      path &&
      (!entry.resolved?.startsWith("https://") ||
        !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? ""))
    )
      throw new Error(`${source}: bootstrap packages require HTTPS and strong integrity hashes`);
  const binary = selected.bin?.devcontainer;
  if (!binary) throw new Error(`${source}: Dev Container executable is missing from the lock`);
  ownedPath(source, `node_modules/${packageName}/${binary}`);
  const identity = createHash("sha256")
    .update("npm-ci-signatures-v1\0")
    .update(manifest)
    .update(lockBytes)
    .digest("hex");
  const directory = join(userDirectory("cache"), "container-tools", `${process.platform}-${process.arch}`, identity);
  return { manifest, lockBytes, version, binary, identity, directory };
}

/** Read-only identity independent of the project's development dependency graph. */
export function containerToolsDirectory(distribution: string): string {
  return definition(distribution).directory;
}

export function containerCLI(distribution: string): string {
  const { directory, version, binary, identity } = definition(distribution);
  const receipt = join(directory, ".workbench-bootstrap");
  const metadataPath = join(directory, `node_modules/${packageName}/package.json`);
  if (!existsSync(receipt) || readFileSync(receipt, "utf8") !== identity || !existsSync(metadataPath))
    throw new Error("Install the locked Dev Container CLI with workbench tools install --devcontainer");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
    version?: string;
    bin?: { devcontainer?: string };
  };
  const executable = ownedPath(directory, `node_modules/${packageName}/${binary}`);
  if (metadata.version !== version || metadata.bin?.devcontainer !== binary || !existsSync(executable))
    throw new Error("Dev Container CLI does not match its lock; run workbench tools install --devcontainer");
  return executable;
}

/** npm owns locked acquisition, extraction, and registry signature verification. */
export function installContainerCLI(distribution: string, env: NodeJS.ProcessEnv): void {
  const { directory, manifest, lockBytes, version, binary, identity } = definition(distribution);
  withCacheLockSync(directory, () => {
    if (!existsSync(directory)) {
      mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
      const staging = `${directory}.${randomUUID()}.partial`;
      mkdirSync(staging, { mode: 0o700 });
      try {
        writeFileSync(join(staging, "package.json"), manifest);
        writeFileSync(join(staging, "package-lock.json"), lockBytes);
        execute("npm", ["ci", "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund"], {
          cwd: staging,
          env,
        });
        execute("npm", ["audit", "signatures"], { cwd: staging, env });
        const actual = execute("node", [ownedPath(staging, `node_modules/${packageName}/${binary}`), "--version"], {
          env,
          capture: true,
        }).trim();
        if (actual !== version) throw new Error(`Dev Container CLI expected ${version}, received ${actual}`);
        writeFileSync(join(staging, ".workbench-bootstrap"), identity);
        renameSync(staging, directory);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    containerCLI(distribution);
  });
}
