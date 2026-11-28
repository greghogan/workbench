import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import tar from "tar-stream";
import { archivePath } from "../toolchains/acquisition/archive-paths.js";
import { extractZipArchive } from "../toolchains/acquisition/archive-extraction.js";
import { ByteLimit, TarGuard, artifactLimits } from "../toolchains/acquisition/artifact-streams.js";
import type { offlineProfile } from "./offline-profiles.js";
import { ciCacheEnvironment } from "../execution/ci/support/ci-layout.mjs";
import { ciProcessOwner, executeCI } from "../execution/ci/support/ci-lifecycle.mjs";
import { mountFields } from "../execution/environments/managed/managed-contract.mjs";
import { readLanguageRoots } from "../projects/project-configuration.js";
import { materializeDistribution } from "../distribution/runtime-distribution.js";
import { required } from "../runtime/invariants.js";
import { dockerQuery } from "./docker-query.js";
import { packZipPaths } from "./release-directory.js";
import { hashFile, hashFileAsync, readBoundedFile } from "../runtime/file-reads.js";
import { StateConflict } from "../runtime/input-errors.js";
import { processCancellation, runOwnedChild } from "../runtime/owned-child.mjs";
import { processFailure } from "../runtime/process-outcome.mjs";
import type { ArtifactPlanEntry } from "./artifact-catalog.js";

const sdkInputs = ["authentication", "downloads"];
const dependencyInputs = ["go-mod", "npm", "pip", "uv", "xdg"];

export const nativeArchiveVersion = 1;
const installationManifest = "workbench-installation.json";
const manifestLimit = 64 * 1024 ** 2;
export interface NativeArchiveIdentity {
  platform: ArtifactPlanEntry["platform"];
  kind: "toolchain" | "development";
  profile: string;
  inputs: string;
  requirements: ArtifactPlanEntry["requirements"];
  bootstrapImage?: string;
}

function inputs(kind: NativeArchiveIdentity["kind"]) {
  return kind === "toolchain" ? sdkInputs : [...sdkInputs, ...dependencyInputs];
}

const limits = {
  ...artifactLimits,
  compressed: 16 * 1024 ** 3,
  retained: 32 * 1024 ** 3,
  entries: 500_000,
  decompressed: 34 * 1024 ** 3,
};

export function nativeArchiveDigest(archive: string): string {
  return hashFile(archive, limits.compressed, "native archive");
}

type NativeArchiveEntry =
  | { path: string; type: "directory"; mode: number }
  | { path: string; type: "file"; mode: number; size: number; sha256: string };

async function inventory(cache: string, roots: readonly string[], signal: AbortSignal): Promise<NativeArchiveEntry[]> {
  const entries: NativeArchiveEntry[] = [];
  let bytes = 0;
  async function inspect(path: string): Promise<void> {
    signal.throwIfAborted();
    if (entries.length >= limits.entries - 1) throw new Error("Native archive exceeds its entry limit");
    const name = join(cache, archivePath(path));
    const stat = await lstat(name);
    if (stat.isDirectory()) {
      entries.push({ path, type: "directory", mode: 0o700 });
      for (const child of (await readdir(name)).sort()) await inspect(`${path}/${child}`);
    } else if (stat.isFile() && path.includes("/")) {
      bytes += stat.size;
      if (stat.size > limits.file || bytes > limits.retained - manifestLimit)
        throw new Error("Native archive exceeds its retained byte limit");
      const mode = 0o600 | (process.platform === "win32" ? 0 : stat.mode & 0o100);
      entries.push({ path, type: "file", mode, size: stat.size, sha256: await hashFileAsync(name) });
    } else throw new Error(`Unsupported native archive entry: ${path}`);
  }
  for (const name of roots) await inspect(name);
  if (!bytes) throw new Error("Native archive contains no reusable inputs");
  return entries;
}

function manifest(identity: NativeArchiveIdentity, entries: NativeArchiveEntry[]) {
  return {
    version: nativeArchiveVersion,
    platform: identity.platform,
    kind: identity.kind,
    profile: identity.profile,
    inputs: identity.inputs,
    requirements: identity.requirements,
    ...(identity.bootstrapImage ? { bootstrapImage: identity.bootstrapImage } : {}),
    entries,
  };
}

function settle(promise: Promise<void>) {
  void promise.catch(() => {
    // The entry loop still awaits this pipeline and propagates its failure.
  });
  return promise;
}

/** Keep original distributions and upstream proof files from the private acquisition cache. */
export async function writeNativeArchive(cache: string, archive: string, identity: NativeArchiveIdentity) {
  const signal = AbortSignal.timeout(limits.milliseconds);
  const allowed = new Set(inputs(identity.kind));
  const roots = (await readdir(cache)).filter((name) => allowed.has(name)).sort();
  const entries = await inventory(cache, roots, signal);
  const document = JSON.stringify(manifest(identity, entries)) + "\n";
  if (Buffer.byteLength(document) > manifestLimit)
    throw new Error("Native installation manifest exceeds its byte limit");
  if (!identity.platform.startsWith("linux-")) {
    const path = join(cache, installationManifest);
    await writeFile(path, document, { flag: "wx", mode: 0o600 });
    try {
      await packZipPaths(cache, archive, [...roots, installationManifest], signal, ciProcessOwner());
      if ((await lstat(archive)).size > limits.compressed) throw new Error("Native archive exceeds its byte limit");
    } finally {
      await rm(path);
    }
    return;
  }

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
  try {
    for (const entry of entries) {
      const header = { name: entry.path, mode: entry.mode, mtime: new Date(0) };
      if (entry.type === "directory")
        await new Promise<void>((done, fail) => {
          pack.entry({ ...header, type: "directory" }, (error) => {
            if (error) fail(error);
            else done();
          });
        });
      else
        await pipeline(
          createReadStream(join(cache, entry.path)),
          new ByteLimit(entry.size, "native archive entry"),
          pack.entry({ ...header, type: "file", size: entry.size }),
          { signal },
        );
    }
    pack.entry({ name: installationManifest, mode: 0o600, mtime: new Date(0) }, document);
    pack.finalize();
    await transfer;
  } catch (error) {
    pack.destroy(error as Error);
    await Promise.allSettled([transfer]);
    throw error;
  }
}

async function extractNativeTar(archive: string, cache: string, allowed: ReadonlySet<string>, signal: AbortSignal) {
  const extract = tar.extract();
  const paths = new Map<string, "directory" | "file">();
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
      const descriptor = name === installationManifest;
      if (
        paths.has(name) ||
        (type !== "file" && type !== "directory") ||
        (descriptor
          ? type !== "file" || size > manifestLimit
          : !allowed.has(name.split("/")[0] ?? "") ||
            (parent === "." ? type !== "directory" : paths.get(parent) !== "directory"))
      )
        throw new Error(`Unsupported native archive entry: ${name}`);
      if (
        paths.size >= limits.entries ||
        size < 0 ||
        size > limits.file ||
        !Number.isSafeInteger(size) ||
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
        const bounded = new ByteLimit(size, "native archive entry");
        await pipeline(
          entry,
          bounded,
          createWriteStream(path, { flags: "wx", mode: 0o600 | (entry.header.mode & 0o100) }),
          { signal },
        );
        if (bounded.bytes !== size) throw new Error("Truncated native archive entry");
      }
      paths.set(name, type);
    }
    await transfer;
  } catch (error) {
    extract.destroy(error as Error);
    await Promise.allSettled([transfer]);
    throw error;
  }
}

/** Consume only authenticated bytes in private staging and expose the cache after verifying every entry. */
export async function restoreNativeArchive(
  archive: string,
  cache: string,
  identity: NativeArchiveIdentity,
  sha256: string,
) {
  if (nativeArchiveDigest(archive) !== sha256)
    throw new StateConflict("Native archive does not match the supplied SHA-256");
  const signal = AbortSignal.timeout(limits.milliseconds);
  const allowed = new Set(inputs(identity.kind));
  await mkdir(cache, { mode: 0o700 });
  if (identity.platform.startsWith("linux-")) await extractNativeTar(archive, cache, allowed, signal);
  else await extractZipArchive(archive, cache, 0, limits);
  const path = join(cache, installationManifest);
  const stored: unknown = JSON.parse(readBoundedFile(path, manifestLimit, "native installation manifest").toString());
  const roots = (await readdir(cache)).filter((name) => name !== installationManifest).sort();
  if (roots.some((name) => !allowed.has(name))) throw new Error("Unexpected native archive input directory");
  const entries = await inventory(cache, roots, signal);
  if (JSON.stringify(stored) !== JSON.stringify(manifest(identity, entries)))
    throw new StateConflict("Native installation manifest does not match the selected profile or extracted files");
  await rm(path);
}

export async function runNativeArchivePreparation(
  root: string,
  source: string,
  cache: string,
  profile: ReturnType<typeof offlineProfile>,
  image: string | undefined,
  kind: "toolchain" | "development",
  phase: "build" | "verify",
) {
  const { offline } = profile;
  const roots = offline.paths ?? readLanguageRoots(source).map(({ path }) => path);
  const container = process.platform === "linux";
  const prefix = phase === "build" ? "/workbench-acquisition" : "/workbench-restored";
  const distribution = materializeDistribution(root, source, "");
  const workspace = container ? `${prefix}/source` : source;
  const runtime = container ? `${prefix}/runtime` : distribution;
  const retained = container ? `${prefix}/cache` : cache;
  const home = container ? `/tmp${prefix}` : join(cache, "..", "home");
  const node = container ? "node" : process.execPath;
  const preparation = (mode: string) => [
    node,
    `${runtime}/scripts/prepare-development.mjs`,
    "native",
    mode,
    ...(mode === "--tools-only" ? ["--skip-ci-toolchains"] : []),
    ...(profile.toolchain ? ["--toolchain", profile.toolchain] : []),
    ...roots.flatMap((path) => ["--path", path]),
  ];
  const commands = [preparation("--tools-only")];
  if (phase === "verify")
    commands.push(
      offline.verify.map((part, index) =>
        index === 0 && part === "node" ? node : part.replaceAll("{workbench}", runtime),
      ),
    );
  else if (kind === "development") commands.push(preparation("--acquire-only"));
  const env = {
    ...ciCacheEnvironment(retained, join(home, "data")),
    HOME: home,
    ...(process.platform === "win32" ? { USERPROFILE: home } : {}),
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
  if (!container) {
    await mkdir(home, { mode: 0o700 });
    const cancellation = processCancellation();
    const owner = ciProcessOwner();
    try {
      for (const [program, ...arguments_] of commands) {
        const outcome = await runOwnedChild(
          required(program, "Native archive verification needs a command"),
          arguments_,
          {
            cwd: source,
            env: { ...process.env, ...env, WORKBENCH_LOCAL_CONFIG_ROOT: source },
            signal: cancellation.signal,
            ...(owner ? { owner } : {}),
            inheritOutput: true,
            stopDescendantsOnExit: true,
          },
        );
        const failure = processFailure("Prepare native archive inputs", outcome);
        if (failure) throw failure;
      }
    } finally {
      cancellation.close();
    }
    return;
  }
  const bootstrap = required(image, "Linux native archives require a pinned bootstrap image");
  const architecture = process.arch === "x64" ? "amd64" : "arm64";
  const user = required(process.getuid?.(), "Native archive execution requires a POSIX user");
  const group = required(process.getgid?.(), "Native archive execution requires a POSIX group");
  const daemon = await dockerQuery(["info", "--format", "{{.Architecture}}"]);
  if (!(architecture === "amd64" ? ["amd64", "x86_64"] : ["arm64", "aarch64"]).includes(daemon))
    throw new Error("Native archives require a Docker host matching the target architecture");
  const imagePlatform = await dockerQuery([
    "image",
    "inspect",
    "--format",
    "{{.Os}}/{{.Architecture}}",
    bootstrap,
  ]).catch((cause: unknown) => {
    throw new Error(`Load the pinned native archive bootstrap locally before continuing: ${bootstrap}`, { cause });
  });
  if (imagePlatform !== `linux/${architecture}`) throw new Error("Native archive bootstrap does not match the target");
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
      bootstrap,
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
