import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { managedDeclaration } from "../execution/environments/managed/managed-source-contract.mjs";
import { dependencyInputHash } from "../toolchains/dependency-identity.mjs";
import { artifactLimits, ByteLimit, withArtifactResponse } from "../toolchains/acquisition/artifact-streams.js";
import { hashFile, readBoundedFile } from "../runtime/file-reads.js";
import { ownedPath } from "../runtime/paths.js";
import { withCacheLock } from "../storage/cache-lock.js";
import { withCacheInstallation } from "../storage/cache-operations.js";
import { userDirectory } from "../storage/storage.js";
import { workQueue } from "../execution/checks/work-admission.mjs";
import { AcquisitionRejected } from "../toolchains/acquisition/network-retry.mts";

/** Restore declared language dependencies independently of any image or package-manager installation. */
export async function acquireManagedArtifactInputs(
  directory: string,
  platform: string,
  capacity: number,
  signal: AbortSignal,
): Promise<string | undefined> {
  const path = ownedPath(directory, "managed-check-inputs.json");
  if (!existsSync(path)) return undefined;
  const contents = readBoundedFile(path, 32 * 1024 * 1024, "managed dependency declaration");
  const declaration = managedDeclaration(JSON.parse(contents.toString("utf8")));
  for (const [file, expected] of Object.entries(declaration.source_hashes)) {
    const source = ownedPath(directory, file);
    if (dependencyInputHash(file, readBoundedFile(source, 64 * 1024 * 1024, "managed dependency input")) !== expected)
      throw new Error(`${file}: regenerate the stale managed dependency declaration before CI`);
  }
  const identity = createHash("sha256").update(platform).update("\0").update(contents).digest("hex");
  const destination = ownedPath(userDirectory("cache"), `managed-check-inputs/${identity}`);
  const entries = declaration.inputs.filter((input) => !input.platforms || input.platforms.includes(platform));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  await withCacheLock(destination, async () => {
    if (existsSync(destination)) {
      if (hashFile(join(destination, "manifest.json")) !== createHash("sha256").update(contents).digest("hex"))
        throw new Error("The restored managed dependency manifest changed");
      return;
    }
    await withCacheInstallation(destination, false, async (stage) => {
      writeFileSync(join(stage, "manifest.json"), contents, { flag: "wx", mode: 0o644 });
      if (declaration.bootstrap)
        copyFileSync(
          ownedPath(directory, "managed-bootstrap.json"),
          join(stage, "bootstrap.json"),
          constants.COPYFILE_EXCL,
        );
      if (declaration.registry)
        copyFileSync(
          ownedPath(directory, "managed-registry.json.br"),
          join(stage, "registry.json.br"),
          constants.COPYFILE_EXCL,
        );
      await workQueue(entries, { capacity, signal }, async (entry) => {
        const target = ownedPath(stage, entry.destination);
        mkdirSync(dirname(target), { recursive: true });
        const separator = entry.hash.indexOf("-");
        await withArtifactResponse(
          entry.url,
          async (source) => {
            const digest = createHash(entry.hash.slice(0, separator));
            try {
              await pipeline(
                source,
                new ByteLimit(artifactLimits.compressed, "managed dependency"),
                new Transform({
                  transform(chunk: Buffer, _encoding, done) {
                    digest.update(chunk);
                    done(null, chunk);
                  },
                }),
                createWriteStream(target, { flags: "wx", mode: 0o644 }),
                { signal },
              );
              if (digest.digest("base64") !== entry.hash.slice(separator + 1))
                throw new AcquisitionRejected(`${entry.destination}: managed dependency failed integrity verification`);
            } catch (error) {
              rmSync(target, { force: true });
              throw error;
            }
          },
          signal,
        );
      });
      signal.throwIfAborted();
      chmodSync(stage, 0o755);
      renameSync(stage, destination);
    });
  });
  return destination;
}
