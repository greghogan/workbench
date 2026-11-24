import { constants, createWriteStream, existsSync, lstatSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { settleCleanup } from "../diagnostics/diagnostic-errors.mjs";
import { readBoundedFile } from "../runtime/file-reads.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { processCancellation } from "../runtime/owned-child.mjs";
import { createOwnedScratch } from "../runtime/owned-scratch.mjs";
import { ownedPath } from "../runtime/paths.js";
import { record } from "../runtime/values.mjs";
import { withCacheLock } from "../storage/cache-lock.js";
import { userDirectory } from "../storage/storage.js";
import { dockerQuery } from "./docker-query.js";
import { imageDigest, imageHash, imageProfileLock } from "./image-contract.js";
import { checkImageTransferArchive } from "./image-transfer-archive.js";
import { preparedImageRecord } from "./local-images.js";
import {
  offlineCandidateReference,
  offlineImageReference,
  offlineInputs,
  offlineProfile,
  preparedOfflineProfile,
  verifyOfflineProfile,
  withOfflineProfileLock,
} from "./offline-profiles.js";

const archiveName = "image.tar";
const manifestName = "workbench-image.json";
const sha256 = /^[a-f0-9]{64}$/;

interface ImageTransferManifest {
  version: 1;
  profile: string;
  inputs: string;
  platform: string;
  image: string;
  bytes: number;
  sha256: string;
  verification: "verified" | "unverified";
}

function readManifest(source: string, expected: string, name: string, architecture: string): ImageTransferManifest {
  if (!sha256.test(expected)) throw new InvalidInput("Supply the trusted manifest SHA-256");
  const contents = readBoundedFile(ownedPath(source, manifestName), 4096, "image transfer manifest");
  if (createHash("sha256").update(contents).digest("hex") !== expected)
    throw new StateConflict("Image transfer manifest does not match the supplied SHA-256");
  const value = record(JSON.parse(contents.toString("utf8")) as unknown, "Invalid image transfer manifest");
  if (
    value.version !== 1 ||
    value.profile !== name ||
    value.platform !== `linux-${architecture}` ||
    typeof value.inputs !== "string" ||
    !sha256.test(value.inputs) ||
    typeof value.image !== "string" ||
    !imageDigest.test(value.image) ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    typeof value.sha256 !== "string" ||
    !sha256.test(value.sha256) ||
    (value.verification !== "verified" && value.verification !== "unverified")
  )
    throw new InvalidInput("Image transfer manifest does not match the selected profile and target");
  return {
    version: 1,
    profile: name,
    platform: value.platform,
    inputs: value.inputs,
    image: value.image,
    bytes: value.bytes,
    sha256: value.sha256,
    verification: value.verification,
  };
}

async function selectedImage(
  root: string,
  name: string,
  architecture: string,
  allowUnverified: boolean,
  signal: AbortSignal,
) {
  const profile = offlineProfile(root, name);
  const inputs = offlineInputs(root, profile, architecture);
  if (allowUnverified) {
    const reference = offlineCandidateReference(root, name, inputs, architecture);
    const candidate = preparedImageRecord(root, reference);
    if (candidate?.assembled && candidate.profile === name && candidate.inputs === inputs) {
      const listed = await dockerQuery(
        ["image", "ls", "--no-trunc", "--quiet", "--filter", `reference=${reference}`],
        signal,
      );
      if (listed === candidate.image) return { image: candidate.image, inputs, verification: "unverified" as const };
    }
  }
  const receipt = preparedOfflineProfile(root, profile, architecture);
  return { image: receipt.image, inputs: receipt.inputs, verification: "verified" as const };
}

function retainedImageExport(receipt: string, key: string): string | undefined {
  try {
    const { selection, manifest } = record(
      JSON.parse(readBoundedFile(receipt, 4096, "image export receipt").toString("utf8")) as unknown,
      "Invalid image export receipt",
    );
    if (selection === key && typeof manifest === "string" && sha256.test(manifest)) return manifest;
  } catch {
    // The transfer can be created afresh when its local receipt is unavailable.
  }
  return undefined;
}

async function verifyImageExport(
  directory: string,
  manifest: ImageTransferManifest,
  signal: AbortSignal,
): Promise<void> {
  const observed = await checkImageTransferArchive(
    ownedPath(directory, archiveName),
    manifest.image,
    manifest.bytes,
    signal,
  );
  if (observed.bytes !== manifest.bytes || observed.sha256 !== manifest.sha256)
    throw new StateConflict(`Image export differs from its manifest: ${directory}`);
}

/** Save an immutable image without registry tags, preserving the accepted profile during transfer. */
export async function exportPreparedImage(
  root: string,
  name: string,
  architecture: string,
  destination: string,
  allowUnverified = false,
) {
  const cancellation = processCancellation();
  try {
    return await withOfflineProfileLock(root, name, architecture, async () => {
      const selected = await selectedImage(root, name, architecture, allowUnverified, cancellation.signal);
      mkdirSync(destination, { recursive: true });
      const parent = realpathSync(destination);
      const key = imageHash(JSON.stringify([parent, selected.image, selected.inputs, selected.verification]));
      const receipt = `${imageProfileLock(root, name, architecture)}.export.json`;
      const retained = retainedImageExport(receipt, key);
      if (retained) {
        const directory = ownedPath(parent, `image-${retained}`);
        if (existsSync(directory))
          return await withCacheLock(
            directory,
            async () => {
              const manifest = readManifest(directory, retained, name, architecture);
              await verifyImageExport(directory, manifest, cancellation.signal);
              return { directory, manifestSha256: retained, verification: manifest.verification };
            },
            undefined,
            cancellation.signal,
            { mutable: false },
          );
      }
      const scratch = createOwnedScratch(parent, ".workbench-image-export");
      const stage = join(scratch.directory, "payload");
      try {
        mkdirSync(stage, { mode: 0o700 });
        const archive = join(stage, archiveName);
        await dockerQuery(["image", "save", "--output", archive, selected.image], cancellation.signal, scratch.owner);
        const size = lstatSync(archive);
        if (!size.isFile()) throw new InvalidInput("Docker did not save a regular image archive");
        const digest = await checkImageTransferArchive(archive, selected.image, size.size, cancellation.signal);
        if (digest.bytes !== size.size) throw new StateConflict("Saved image archive changed during export");
        const manifest: ImageTransferManifest = {
          version: 1,
          profile: name,
          platform: `linux-${architecture}`,
          ...selected,
          ...digest,
        };
        const contents = JSON.stringify(manifest, null, 2) + "\n";
        const manifestSha256 = imageHash(contents);
        const directory = ownedPath(parent, `image-${manifestSha256}`);
        return await withCacheLock(
          directory,
          async () => {
            if (existsSync(directory)) {
              const saved = readBoundedFile(ownedPath(directory, manifestName), 4096, "image transfer manifest");
              if (saved.toString("utf8") !== contents)
                throw new StateConflict(`Image export has a different manifest: ${directory}`);
              await verifyImageExport(directory, manifest, cancellation.signal);
            } else {
              writeAtomic(join(stage, manifestName), contents, 0o600);
              renameSync(stage, directory);
            }
            writeAtomic(receipt, JSON.stringify({ selection: key, manifest: manifestSha256 }) + "\n", 0o600);
            return { directory, manifestSha256, verification: selected.verification };
          },
          undefined,
          cancellation.signal,
          { mutable: false },
        );
      } finally {
        scratch.release();
      }
    });
  } finally {
    cancellation.close();
  }
}

/** The trusted digest authenticates the archive; only local qualification activates it. */
export async function importPreparedImage(
  root: string,
  name: string,
  architecture: string,
  source: string,
  expected: string,
) {
  const from = realpathSync(source);
  const manifest = readManifest(from, expected, name, architecture);
  if (offlineInputs(root, offlineProfile(root, name), architecture) !== manifest.inputs)
    throw new StateConflict("Image transfer inputs differ from the current profile; transfer a matching image");
  const file = ownedPath(from, archiveName);
  const directory = ownedPath(userDirectory("cache"), "image-transfers");
  const scratch = createOwnedScratch(directory, "import");
  const cancellation = processCancellation();
  let temporaryTag: string | undefined;
  let failure: unknown;
  try {
    const archive = join(scratch.directory, archiveName);
    const source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await source.stat();
      if (!opened.isFile() || opened.size !== manifest.bytes)
        throw new StateConflict("Image archive does not match the authenticated manifest size");
      await pipeline(
        source.createReadStream({ end: manifest.bytes - 1 }),
        createWriteStream(archive, { flags: "wx", mode: 0o600 }),
        { signal: cancellation.signal },
      );
    } finally {
      await source.close();
    }
    const digest = await checkImageTransferArchive(archive, manifest.image, manifest.bytes, cancellation.signal);
    if (digest.bytes !== manifest.bytes || digest.sha256 !== manifest.sha256)
      throw new StateConflict("Image archive does not match the authenticated manifest digest");
    await verifyOfflineProfile(root, name, manifest.image, architecture, {
      inputs: manifest.inputs,
      load: async () => {
        const present = await dockerQuery(["image", "ls", "--all", "--quiet", "--no-trunc"], cancellation.signal);
        if (present.split("\n").includes(manifest.image)) return;
        await dockerQuery(["image", "load", "--input", archive], cancellation.signal, scratch.owner);
        const loaded = await dockerQuery(
          ["image", "inspect", "--format", "{{.Id}}", manifest.image],
          cancellation.signal,
        );
        if (loaded !== manifest.image) throw new StateConflict("Docker did not load the authenticated image");
        temporaryTag = `workbench-offline:transfer-${randomUUID()}`;
        await dockerQuery(["image", "tag", manifest.image, temporaryTag], cancellation.signal, scratch.owner);
      },
    });
    return {
      receipt: preparedOfflineProfile(root, offlineProfile(root, name), architecture),
      reference: offlineImageReference(root, name, architecture),
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await settleCleanup(
      [
        () => {
          cancellation.close();
        },
        async () => {
          if (!temporaryTag) return;
          const listed = await dockerQuery([
            "image",
            "ls",
            "--no-trunc",
            "--quiet",
            "--filter",
            `reference=${temporaryTag}`,
          ]);
          if (listed === manifest.image) await dockerQuery(["image", "rm", temporaryTag]);
        },
        scratch.release,
      ],
      failure,
    );
  }
}
