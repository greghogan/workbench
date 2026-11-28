import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import tar, { type Header } from "tar-stream";
import { archivePath, unsafeArchiveText } from "../toolchains/acquisition/archive-paths.js";
import { captureOwnedChild } from "../runtime/owned-child.mjs";
import { processFailure } from "../runtime/process-outcome.mjs";
import { required } from "../runtime/values.mjs";
import { hashFile } from "../runtime/file-reads.js";
import { extractZipArchive } from "../toolchains/acquisition/archive-extraction.js";
import { artifactLimits } from "../toolchains/acquisition/artifact-streams.js";
import { extractArchive } from "../toolchains/tool-downloads.js";
import type { ProcessLock } from "../storage/process-lock.js";

type ReleaseHeader = Partial<Header> & Pick<Header, "name" | "type">;
type ReleaseArchive = "tar.gz" | "zip";

export async function packZipPaths(
  directory: string,
  archive: string,
  paths: string[],
  signal: AbortSignal,
  owner?: ProcessLock,
) {
  const command =
    process.platform === "win32"
      ? join(required(process.env.SystemRoot, "SystemRoot is required to locate Windows tar.exe"), "System32/tar.exe")
      : process.platform === "darwin"
        ? "/usr/bin/tar"
        : "bsdtar";
  const outcome = await captureOwnedChild(
    command,
    ["--format", "zip", "--no-mac-metadata", "-cf", resolve(archive), "--", ...paths],
    { cwd: directory, env: process.env, signal, ...(owner ? { owner } : {}), stopDescendantsOnExit: true },
    1024 * 1024,
  );
  const failure = processFailure("Write ZIP archive", outcome, outcome);
  if (failure) throw failure;
  signal.throwIfAborted();
}

async function* releaseEntries(root: string, signal: AbortSignal) {
  const contained = (path: string) => {
    const name = relative(root, path);
    return !isAbsolute(name) && name !== ".." && !name.startsWith(`..${sep}`);
  };
  async function* entry(name: string, source: string): AsyncGenerator<{ source: string; header: ReleaseHeader }> {
    signal.throwIfAborted();
    archivePath(name);
    const stat = await lstat(source);
    const common = { name, mtime: new Date(0), uid: 0, gid: 0, mode: stat.mode & 0o777 };
    if (stat.isFile()) {
      yield { source, header: { ...common, type: "file", size: stat.size } };
      return;
    }
    let header: ReleaseHeader;
    if (stat.isDirectory()) header = { ...common, type: "directory" };
    else if (stat.isSymbolicLink()) {
      const linkname = await readlink(source);
      if (
        unsafeArchiveText(linkname) ||
        isAbsolute(linkname) ||
        !contained(resolve(dirname(source), linkname)) ||
        !contained(await realpath(source))
      )
        throw new Error(`Release link escapes its package: ${name}`);
      header = { ...common, type: "symlink", linkname };
    } else throw new Error(`Unsupported release file: ${name}`);
    yield { source, header };
    if (stat.isDirectory())
      for (const child of (await readdir(source)).sort()) yield* entry(`${name}/${child}`, join(source, child));
  }
  if (!(await readdir(root)).length) throw new Error("Release preparation produced no files");
  yield* entry("release", root);
}

/** Stream the target archive from the builder's private output directory. */
export async function packReleaseDirectory(
  directory: string,
  artifact: string,
  format: ReleaseArchive,
  signal: AbortSignal,
) {
  const root = await realpath(directory);
  if (format === "zip") {
    for await (const { header } of releaseEntries(root, signal)) {
      if (process.platform === "win32" && header.type === "symlink")
        throw new Error(`Windows release archive cannot preserve the symbolic link ${header.name}`);
    }
    return packZipPaths(dirname(root), artifact, [basename(root)], signal);
  }
  const pack = tar.pack();
  const transfer = pipeline(pack, createGzip(), createWriteStream(artifact, { flags: "wx", mode: 0o600 }), { signal });
  void transfer.catch(() => {
    // The writer below propagates the pipeline failure and drains the stream before cleanup.
  });
  try {
    for await (const { source, header } of releaseEntries(root, signal)) {
      if (header.type === "file") await pipeline(createReadStream(source), pack.entry(header), { signal });
      else
        await new Promise<void>((ok, reject) => {
          pack.entry(header, (error) => {
            if (error) reject(error);
            else ok();
          });
        });
    }
    pack.finalize();
    await transfer;
  } catch (error) {
    pack.destroy(error as Error);
    await Promise.allSettled([transfer]);
    throw error;
  }
}

export function unpackReleaseDirectory(archive: string, directory: string, format: ReleaseArchive, sha256: string) {
  if (format === "zip") return extractZipArchive(archive, directory, 1, artifactLimits, "contained");
  return extractArchive(archive, directory, {
    url: pathToFileURL(archive).href,
    sha256,
    format: "tar",
    strip: 1,
    bin: "bin",
  });
}

/** Publish the archive to CI reports only after its extracted files pass the release verifier. */
export async function verifyPackedRelease(
  source: string,
  destination: string,
  format: ReleaseArchive,
  signal: AbortSignal,
  verify: (directory: string) => void,
) {
  const scratch = await mkdtemp(join(dirname(destination), ".release-package-"));
  try {
    const archive = join(scratch, `package.${format}`);
    const extracted = join(scratch, "extracted");
    await mkdir(extracted);
    await packReleaseDirectory(source, archive, format, signal);
    const digest = hashFile(archive);
    const directory = await unpackReleaseDirectory(archive, extracted, format, digest);
    signal.throwIfAborted();
    verify(directory);
    signal.throwIfAborted();
    if (hashFile(archive) !== digest) throw new Error("Release archive changed during verification");
    await rename(archive, destination);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
