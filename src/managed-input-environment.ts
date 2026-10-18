import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { managedRegistry } from "./managed-registry.js";
import { withCacheLock, withCacheLockSync } from "./cache-lock.js";
import { managedInputRepository, managedInputSource, type ManagedInputRepository } from "./managed-inputs.js";
import { userDirectory } from "./storage.js";
import { execute, extractArchive } from "./tool-downloads.js";

function mavenRepository(repository: ManagedInputRepository): string {
  const directory = process.env.WORKBENCH_MAVEN_REPOSITORY ?? join(userDirectory("cache"), "downloads", "maven");
  return withCacheLockSync(directory, () => {
    for (const source of repository.declaration.inputs.filter((entry) => entry.destination.startsWith("maven/"))) {
      const target = join(directory, source.destination.slice(6));
      mkdirSync(dirname(target), { recursive: true });
      // Maven's writable repository is separate from the immutable source closure.
      if (!existsSync(target)) symlinkSync(managedInputSource(repository, source.url), target);
      const marker = join(dirname(target), "_remote.repositories");
      const line = `${basename(target)}>central-mirror=\n`;
      const previous = existsSync(marker) ? readFileSync(marker, "utf8") : "";
      if (!previous.includes(line)) writeFileSync(marker, previous + line);
    }
    return directory;
  });
}

async function cargoRepository(repository: ManagedInputRepository): Promise<string> {
  const directory = join(
    process.env.WORKBENCH_DEPENDENCIES_DIR ?? join(userDirectory("cache"), "dependencies"),
    "managed-inputs",
    createHash("sha256").update(repository.directory).digest("hex"),
    "cargo",
  );
  await withCacheLock(directory, async () => {
    if (existsSync(directory)) return;
    const staging = `${directory}.${randomUUID()}.partial`;
    mkdirSync(join(staging, "vendor"), { recursive: true });
    try {
      for (const source of repository.declaration.inputs.filter((entry) => entry.destination.startsWith("cargo/"))) {
        const archive = managedInputSource(repository, source.url);
        const target = join(staging, "vendor", basename(source.destination, ".crate"));
        const unpack = join(staging, "unpack");
        mkdirSync(unpack);
        const extracted = await extractArchive(archive, unpack, {
          url: source.url,
          sha256: Buffer.from(source.hash.slice(7), "base64").toString("hex"),
          format: "tar",
          strip: 1,
          bin: "",
        });
        renameSync(extracted, target);
        rmSync(unpack, { recursive: true });
        const files: Record<string, string> = {};
        const visit = (prefix: string) => {
          for (const entry of readdirSync(join(target, prefix), { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) visit(relative);
            else if (entry.isFile())
              files[relative] = createHash("sha256")
                .update(readFileSync(join(target, relative)))
                .digest("hex");
            else throw new Error("Managed Cargo sources must contain regular files and directories");
          }
        };
        visit("");
        writeFileSync(
          join(target, ".cargo-checksum.json"),
          JSON.stringify({ files, package: Buffer.from(source.hash.slice(7), "base64").toString("hex") }),
        );
      }
      writeFileSync(
        join(staging, "config.toml"),
        `[net]\noffline = true\n[source.crates-io]\nreplace-with = "workbench-managed"\n[source.workbench-managed]\ndirectory = ${JSON.stringify(join(directory, "vendor"))}\n`,
      );
      renameSync(staging, directory);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
  return directory;
}

/** Give each manager its supported local-source interface; do not warm caches by building projects. */
export async function managedInputEnvironment(directory: string): Promise<NodeJS.ProcessEnv> {
  const repository = managedInputRepository(directory);
  if (!repository) return { ...process.env };
  const env = { ...process.env, WORKBENCH_CHECK_INPUT_ROOT: process.env.WORKBENCH_CHECK_INPUT_ROOT ?? directory };
  const has = (prefix: string) => repository.declaration.inputs.some((entry) => entry.destination.startsWith(prefix));
  if (has("npm/")) Object.assign(env, { PNPM_CONFIG_OFFLINE: "true", npm_config_offline: "true" });
  if (has("python/"))
    Object.assign(env, {
      UV_OFFLINE: "true",
      UV_NO_INDEX: "true",
      UV_FIND_LINKS: join(repository.directory, "python"),
    });
  if (has("go/"))
    Object.assign(env, {
      GOPROXY: pathToFileURL(join(repository.directory, "go")).href,
      GOSUMDB: "off",
      GOTOOLCHAIN: "local",
    });
  if (has("maven/"))
    Object.assign(env, {
      WORKBENCH_MAVEN_REPOSITORY: mavenRepository(repository),
      MAVEN_ARGS: `${process.env.MAVEN_ARGS ?? ""} --offline`.trim(),
    });
  if (has("cargo/")) Object.assign(env, { CARGO_HOME: await cargoRepository(repository), CARGO_NET_OFFLINE: "true" });
  if (has("composer/")) Object.assign(env, { COMPOSER_DISABLE_NETWORK: "1" });
  return env;
}

export async function executeManagedCommand(directory: string, command: string[]): Promise<void> {
  const [executable, ...args] = command;
  if (!executable) throw new Error("Managed input execution requires a command");
  const env = await managedInputEnvironment(directory);
  const repository = managedInputRepository(directory);
  if (!repository?.declaration.registry) {
    execute(executable, args, { cwd: directory, env });
    return;
  }
  const registry = await managedRegistry(repository);
  try {
    Object.assign(env, {
      npm_config_registry: registry.url,
      PNPM_CONFIG_REGISTRY: registry.url,
      PNPM_CONFIG_CACHE_DIR: registry.cacheDirectory,
      PNPM_CONFIG_OFFLINE: "false",
      npm_config_offline: "false",
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { cwd: directory, env, stdio: "inherit" });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`${executable} failed: ${String(code ?? signal)}`));
      });
    });
  } finally {
    await registry.close();
  }
}
