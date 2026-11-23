import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import tar from "tar-stream";
import { archivePath } from "../toolchains/acquisition/archive-paths.js";
import { ByteLimit, TarGuard, artifactLimits } from "../toolchains/acquisition/artifact-streams.js";
import type { offlineProfile } from "./offline-profiles.js";
import { ciCacheEnvironment } from "../execution/ci/support/ci-layout.mjs";
import { executeCI } from "../execution/ci/support/ci-lifecycle.mjs";
import { mountFields } from "../execution/environments/managed/managed-contract.mjs";
import { readLanguageRoots } from "../projects/project-configuration.js";
import { materializeDistribution } from "../distribution/runtime-distribution.js";
import { required } from "../runtime/invariants.js";
import { dockerQuery } from "./docker-query.js";

const sdkInputs = ["authentication", "downloads"];
const dependencyInputs = ["go-mod", "npm", "pip", "uv", "xdg"];

function inputs(kind: "toolchain" | "development") {
  return kind === "toolchain" ? sdkInputs : [...sdkInputs, ...dependencyInputs];
}

const limits = {
  ...artifactLimits,
  compressed: 16 * 1024 ** 3,
  retained: 32 * 1024 ** 3,
  entries: 500_000,
  decompressed: 34 * 1024 ** 3,
};

function settle(promise: Promise<void>) {
  void promise.catch(() => {
    // The entry loop still awaits this pipeline and propagates its failure.
  });
  return promise;
}

/** Only retain reusable inputs from the operation's private cache. */
export async function writeNativeArchive(cache: string, archive: string, kind: "toolchain" | "development") {
  const signal = AbortSignal.timeout(limits.milliseconds);
  const pack = tar.pack();
  const transfer = settle(
    pipeline(
      pack,
      new ByteLimit(limits.decompressed, "native archive input"),
      createGzip({ level: 1 }),
      new ByteLimit(limits.compressed, "native archive"),
      createWriteStream(archive, { flags: "wx", mode: 0o600 }),
      { signal },
    ),
  );
  let bytes = 0;
  let entries = 0;
  async function append(name: string, optional = false): Promise<void> {
    const file = join(cache, archivePath(name));
    const stat = await lstat(file).catch((error: unknown) => {
      if (!optional || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    if (!stat) return;
    if (++entries > limits.entries) throw new Error("Native archive exceeds its entry limit");
    if (stat.isDirectory()) {
      await new Promise<void>((resolve, reject) => {
        pack.entry({ name, type: "directory", mode: 0o700, mtime: new Date(0) }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      for (const child of (await readdir(file)).sort()) await append(`${name}/${child}`);
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported native cache entry: ${name}`);
    bytes += stat.size;
    if (stat.size > limits.file || bytes > limits.retained)
      throw new Error("Native archive exceeds its retained byte limit");
    await pipeline(
      createReadStream(file),
      new ByteLimit(stat.size, "native archive entry"),
      pack.entry({ name, type: "file", size: stat.size, mode: 0o600 | (stat.mode & 0o100), mtime: new Date(0) }),
      { signal },
    );
  }
  try {
    for (const name of inputs(kind)) await append(name, true);
    if (!bytes) throw new Error("Native acquisition produced no portable inputs");
    pack.finalize();
    await transfer;
  } catch (error) {
    pack.destroy(error as Error);
    await Promise.allSettled([transfer]);
    throw error;
  }
}

/** Restore authenticated archive bytes into a fresh cache, before any installer can see the files. */
export async function restoreNativeArchive(archive: string, cache: string, kind: "toolchain" | "development") {
  const signal = AbortSignal.timeout(limits.milliseconds);
  const extract = tar.extract();
  const paths = new Map<string, "directory" | "file">();
  const allowed = new Set(inputs(kind));
  await mkdir(cache, { mode: 0o700 });
  const transfer = settle(
    pipeline(
      createReadStream(archive),
      new ByteLimit(limits.compressed, "native archive"),
      createGunzip(),
      new TarGuard(limits),
      extract,
      { signal },
    ),
  );
  let bytes = 0;
  try {
    for await (const entry of extract) {
      const name = archivePath(entry.header.name);
      const { size, type } = entry.header;
      const parent = posix.dirname(name);
      if (
        (type !== "file" && type !== "directory") ||
        paths.has(name) ||
        !allowed.has(name.split("/")[0] ?? "") ||
        (parent === "." ? type !== "directory" : paths.get(parent) !== "directory")
      )
        throw new Error(`Unsupported native archive entry: ${name}`);
      if (
        paths.size >= limits.entries ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > limits.file ||
        (type === "directory" && size !== 0)
      )
        throw new Error("Native archive entry exceeds its limit");
      bytes += size;
      if (bytes > limits.retained) throw new Error("Native archive exceeds its retained byte limit");
      const path = join(cache, name);
      if (type === "directory") {
        await mkdir(path, { mode: 0o700 });
        entry.resume();
      } else {
        await pipeline(
          entry,
          new ByteLimit(size, "native archive entry"),
          createWriteStream(path, { flags: "wx", mode: 0o600 | (entry.header.mode & 0o100) }),
          { signal },
        );
      }
      paths.set(name, type);
    }
    await transfer;
    if (!bytes) throw new Error("Native archive contains no reusable inputs");
  } catch (error) {
    extract.destroy(error as Error);
    await Promise.allSettled([transfer]);
    throw error;
  }
}

export async function runNativeArchivePreparation(
  root: string,
  source: string,
  cache: string,
  profile: ReturnType<typeof offlineProfile>,
  image: string,
  kind: "toolchain" | "development",
  phase: "build" | "verify",
) {
  const offline = required(profile.offline, "Native archive requires a preparation profile");
  const roots = offline.paths ?? readLanguageRoots(source).map(({ path }) => path);
  const architecture = process.arch === "x64" ? "amd64" : "arm64";
  const user = required(process.getuid?.(), "Native archive execution requires a POSIX user");
  const group = required(process.getgid?.(), "Native archive execution requires a POSIX group");
  const daemon = await dockerQuery(["info", "--format", "{{.Architecture}}"]);
  if (!(architecture === "amd64" ? ["amd64", "x86_64"] : ["arm64", "aarch64"]).includes(daemon))
    throw new Error("Native archives require a Docker host matching the target architecture");
  const imagePlatform = await dockerQuery(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image]).catch(
    (cause: unknown) => {
      throw new Error(`Load the pinned native archive bootstrap locally before continuing: ${image}`, { cause });
    },
  );
  if (imagePlatform !== `linux/${architecture}`) throw new Error("Native archive bootstrap does not match the target");
  const prefix = phase === "build" ? "/workbench-acquisition" : "/workbench-restored";
  const workspace = `${prefix}/source`;
  const runtime = `${prefix}/runtime`;
  const retained = `${prefix}/cache`;
  const home = `/tmp${prefix}`;
  const distribution = materializeDistribution(root, source, "");
  const preparation = (mode: string) => [
    "node",
    `${runtime}/scripts/prepare-development.mjs`,
    "native",
    mode,
    ...(mode === "--tools-only" ? ["--skip-ci-toolchains"] : []),
    ...(profile.toolchain ? ["--toolchain", profile.toolchain] : []),
    ...roots.flatMap((path) => ["--path", path]),
  ];
  const commands = [preparation("--tools-only")];
  if (phase === "verify") commands.push(offline.verify.map((part) => part.replaceAll("{workbench}", runtime)));
  else if (kind === "development") commands.push(preparation("--acquire-only"));
  const env = {
    ...ciCacheEnvironment(retained, `${home}/data`),
    HOME: home,
    GNUPGHOME: `${home}/gpg`,
    XDG_CONFIG_HOME: `${home}/config`,
    XDG_CACHE_HOME: `${retained}/xdg`,
    XDG_STATE_HOME: `${home}/state`,
    WORKBENCH_CONFIG_HOME: `${home}/workbench-config`,
    WORKBENCH_STATE_HOME: `${home}/state`,
    WORKBENCH_PROJECT_ROOT: workspace,
    WORKBENCH_DISTRIBUTION_ROOT: runtime,
    WORKBENCH_PREPARED: "0",
    WORKBENCH_OFFLINE: phase === "verify" ? "1" : "0",
    GOCACHE: `${home}/go-build`,
    CARGO_HOME: `${home}/cargo`,
    RUSTUP_HOME: `${home}/rustup`,
  };
  await executeCI(
    "docker",
    [
      "run",
      "--rm",
      "--init",
      "--pull=never",
      ...(phase === "verify" ? ["--network=none"] : []),
      "--platform",
      `linux/${architecture}`,
      "--user",
      `${String(user)}:${String(group)}`,
      "--workdir",
      workspace,
      "--mount",
      mountFields("type=bind", `src=${source}`, `dst=${workspace}`),
      "--mount",
      mountFields("type=bind", `src=${distribution}`, `dst=${runtime}`, "readonly"),
      "--mount",
      mountFields("type=bind", `src=${cache}`, `dst=${retained}`),
      ...Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
      "--entrypoint",
      "node",
      image,
      "--input-type=module",
      "-e",
      `import { spawnSync } from "node:child_process";
     import { mkdirSync } from "node:fs";
     mkdirSync(process.env.HOME, { mode: 0o700 });
     for (const [command, ...args] of JSON.parse(process.argv[1])) {
       const result = spawnSync(command, args, { stdio: "inherit" });
       if (result.error) throw result.error;
       if (result.status !== 0) process.exit(result.status ?? 1);
     }`,
      JSON.stringify(commands),
    ],
    { stderr: true },
  );
}
