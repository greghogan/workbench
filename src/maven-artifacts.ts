import { createHash } from "node:crypto";
import {
  realpathSync,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  linkSync,
  rmSync,
  type Stats,
} from "node:fs";
import { open } from "node:fs/promises";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DigestStream, artifactLimits } from "./artifact-streams.js";
import { basename, dirname, join } from "node:path";
import { withCacheLock } from "./cache-lock.js";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { settleCleanup } from "../scripts/diagnostic-errors.mjs";
import { readBoundedFile } from "./file-reads.js";

export const mavenDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function mavenArtifactPath(value: string): string {
  if (
    !/^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+){3,}\.(?:pom|jar)$/.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error(`Invalid Maven artifact path: ${value}`);
  return value;
}

export function mavenChecksums(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.trim().split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) throw new Error("Invalid Maven checksum entry");
    const path = mavenArtifactPath(match[2]);
    if (entries.has(path)) throw new Error(`Duplicate Maven checksum: ${path}`);
    entries.set(path, match[1]);
  }
  return entries;
}

/** Hash the same byte stream that is copied; failed verification never leaves a candidate output. */
export async function verifyMavenArtifact(
  repository: string,
  path: string,
  checksums: ReadonlyMap<string, string>,
  destination?: string,
  signal?: AbortSignal,
): Promise<string> {
  const expected = checksums.get(mavenArtifactPath(path));
  if (!expected) throw new Error(`Missing reviewed Maven checksum: ${path}`);
  return streamMavenArtifact(realpathSync(join(repository, path)), path, expected, destination, undefined, signal);
}

/** Copy a source-owned regular build output and hash its bytes for the release inventory. */
export async function captureMavenSourceArtifact(
  file: string,
  destination: string,
  signal?: AbortSignal,
): Promise<string> {
  const identity = lstatSync(file);
  if (!identity.isFile() || identity.isSymbolicLink())
    throw new Error(`Source Maven artifact must be a regular file: ${file}`);
  return streamMavenArtifact(file, file, undefined, destination, identity, signal);
}

/** Publish verified proposal bytes before activating a lock that needs them for offline source checks. */
export async function retainMavenArtifacts(
  source: string,
  repository: string,
  checksums: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  await withCacheLock(
    repository,
    async () => {
      const markers = new Map<string, Set<string>>();
      for (const [path, expected] of checksums) {
        signal?.throwIfAborted();
        mavenArtifactPath(path);
        const target = join(repository, path),
          existing = lstatSync(target, { throwIfNoEntry: false });
        const verifyCache = async () => {
          const identity = lstatSync(target);
          if (!identity.isFile() || identity.isSymbolicLink())
            throw new Error(`Maven cache input must be a regular file: ${path}`);
          await streamMavenArtifact(target, path, expected, undefined, identity, signal);
        };
        if (existing) {
          await verifyMavenArtifact(source, path, checksums, undefined, signal);
          await verifyCache();
        } else {
          mkdirSync(dirname(target), { recursive: true });
          const staging = mkdtempSync(join(dirname(target), ".maven-input-")),
            temporary = join(staging, "artifact");
          let failure: unknown;
          try {
            await verifyMavenArtifact(source, path, checksums, temporary, signal);
            signal?.throwIfAborted();
            try {
              linkSync(temporary, target);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              await verifyCache();
            }
          } catch (error) {
            failure = error;
          }
          await settleCleanup(
            [
              () => {
                rmSync(staging, { recursive: true });
              },
            ],
            failure,
          );
        }
        const directory = dirname(target),
          names = markers.get(directory) ?? new Set<string>();
        names.add(`${basename(target)}>=`);
        markers.set(directory, names);
      }
      for (const [directory, names] of markers) {
        signal?.throwIfAborted();
        const marker = join(directory, "_remote.repositories"),
          metadata = lstatSync(marker, { throwIfNoEntry: false });
        const previous = metadata
          ? readBoundedFile(marker, 1024 * 1024, "Maven repository tracking metadata").toString("utf8")
          : "";
        const present = new Set(previous.split(/\r?\n/u)),
          added = [...names].filter((name) => !present.has(name));
        if (added.length)
          writeAtomic(
            marker,
            previous + (previous && !previous.endsWith("\n") ? "\n" : "") + added.join("\n") + "\n",
            0o644,
          );
      }
    },
    undefined,
    signal,
  );
}
async function streamMavenArtifact(
  file: string,
  path: string,
  expected?: string,
  destination?: string,
  identity?: Stats,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const handle = await open(file, "r");
  const outputOwnership = { created: false };
  let failure: unknown,
    sha256 = "";
  try {
    const before = await handle.stat();
    if (identity && (before.ino !== identity.ino || before.dev !== identity.dev || before.ctimeMs !== identity.ctimeMs))
      throw new Error(`Source Maven artifact changed before capture: ${path}`);
    if (!before.isFile() || before.size > artifactLimits.file)
      throw new Error(`Invalid or oversized Maven artifact: ${path}`);
    const digest = new DigestStream(artifactLimits.file, "Maven artifact");
    const output = destination
      ? createWriteStream(destination, { flags: "wx", mode: 0o644 })
      : new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
    if (destination)
      output.once("open", () => {
        outputOwnership.created = true;
      });
    await pipeline(handle.createReadStream({ autoClose: false }), digest, output, { signal });
    const after = await handle.stat();
    sha256 = digest.hash.digest("hex");
    if (expected !== undefined && sha256 !== expected) throw new Error(`Maven checksum mismatch: ${path}`);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      digest.bytes !== before.size
    )
      throw new Error(`Maven artifact changed during verification: ${path}`);
    signal?.throwIfAborted();
  } catch (error) {
    failure = error;
  }
  await settleCleanup(
    [
      async () => {
        try {
          await handle.close();
        } catch (error) {
          failure ??= error;
          throw error;
        }
      },
      () => {
        if (failure !== undefined && outputOwnership.created && destination) rmSync(destination, { force: true });
      },
    ],
    failure,
  );
  return sha256;
}
