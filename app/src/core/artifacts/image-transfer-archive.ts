import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { archivePath } from "../toolchains/acquisition/archive-paths.js";
import { artifactLimits, DigestStream } from "../toolchains/acquisition/artifact-streams.js";
import { record, records, strings } from "../runtime/values.mjs";
import { InvalidInput } from "../runtime/input-errors.js";
import { imageDigest } from "./image-contract.js";

const metadata = new Set(["manifest.json", "index.json", "oci-layout", "repositories"]);
const blob = /^(?:blobs\/sha256\/)?[a-f0-9]{64}$/;
const legacy = /^[a-f0-9]{64}(?:\.(?:json|tar)|\/(?:layer\.tar|json|VERSION))?$/;

/** Workbench transfers one image by immutable ID. Reject archives that could install tags before verification. */
export async function checkImageTransferArchive(path: string, image: string, maximum: number, signal: AbortSignal) {
  if (!imageDigest.test(image)) throw new InvalidInput("Invalid prepared image ID");
  const parser = tar.extract();
  const digest = new DigestStream(maximum, "prepared image archive");
  const reading = pipeline(createReadStream(path), digest, parser, { signal });
  void reading.catch(() => undefined);
  const seen = new Set<string>();
  const files = new Set<string>();
  const documents = new Map<string, Buffer>();
  let metadataBytes = 0;
  try {
    for await (const entry of parser) {
      const name = archivePath(entry.header.name);
      if (seen.has(name) || seen.size >= artifactLimits.entries)
        throw new InvalidInput("Prepared image archive has duplicate or excessive entries");
      seen.add(name);
      if (entry.header.type === "directory") {
        if (!["blobs", "blobs/sha256"].includes(name) && !legacy.test(name))
          throw new InvalidInput("Unexpected prepared image archive directory");
      } else {
        if (entry.header.type !== "file" || (!metadata.has(name) && !blob.test(name) && !legacy.test(name)))
          throw new InvalidInput("Unexpected prepared image archive member");
        files.add(name);
      }
      if (
        entry.header.type === "file" &&
        (metadata.has(name) ||
          name === `${image.slice("sha256:".length)}.json` ||
          (blob.test(name) && entry.header.size <= artifactLimits.metadata))
      ) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of entry as AsyncIterable<Buffer>) {
          size += chunk.length;
          metadataBytes += chunk.length;
          if (size > artifactLimits.metadata || metadataBytes > 8 * 1024 ** 2)
            throw new InvalidInput("Prepared image metadata is too large");
          chunks.push(chunk);
        }
        documents.set(name, Buffer.concat(chunks));
      } else {
        // Consume the entire entry to verify the complete archive digest without unpacking any layers.
        await pipeline(
          entry,
          new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
          }),
          { signal },
        );
      }
    }
    await reading;
  } catch (error) {
    parser.destroy();
    await reading.catch(() => undefined);
    throw error;
  }
  const json = (name: string): unknown => {
    const value = documents.get(name);
    if (!value) throw new InvalidInput(`Prepared image archive is missing ${name}`);
    return JSON.parse(value.toString("utf8")) as unknown;
  };
  const digestOf = (name: string) => {
    const bytes = documents.get(name);
    if (!bytes) throw new InvalidInput(`Prepared image archive is missing metadata for ${name}`);
    return createHash("sha256").update(bytes).digest("hex");
  };
  const images = records(json("manifest.json"), "Invalid prepared image manifest");
  const manifest = images[0];
  if (
    images.length !== 1 ||
    !manifest ||
    (manifest.RepoTags !== null &&
      manifest.RepoTags !== undefined &&
      strings(manifest.RepoTags, "Invalid image tags").length > 0) ||
    (manifest.Parent !== undefined && manifest.Parent !== "")
  )
    throw new InvalidInput("Prepared image archive must contain one untagged image");
  const config = image.slice("sha256:".length);
  if (
    (manifest.Config !== `${config}.json` && manifest.Config !== `blobs/sha256/${config}`) ||
    digestOf(manifest.Config) !== config ||
    strings(manifest.Layers, "Invalid image layers").some(
      (layer) => !files.has(layer) || (!legacy.test(layer) && !blob.test(layer)),
    )
  )
    throw new InvalidInput("Prepared image archive does not contain the declared image");
  if (documents.has("repositories") && Object.keys(record(json("repositories"), "Invalid image repositories")).length)
    throw new InvalidInput("Prepared image archive contains legacy repository tags");
  if (documents.has("index.json")) {
    const index = record(json("index.json"), "Invalid OCI image index");
    const manifests = records(index.manifests, "Invalid OCI image manifests");
    const descriptor = manifests[0];
    if (
      index.schemaVersion !== 2 ||
      index.annotations !== undefined ||
      manifests.length !== 1 ||
      !descriptor ||
      descriptor.annotations !== undefined ||
      !["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"].includes(
        String(descriptor.mediaType),
      ) ||
      typeof descriptor.digest !== "string" ||
      !imageDigest.test(descriptor.digest)
    )
      throw new InvalidInput("Prepared image archive must have one untagged OCI manifest");
    const expected = descriptor.digest.slice("sha256:".length);
    const manifestPath = `blobs/sha256/${expected}`;
    if (digestOf(manifestPath) !== expected) throw new InvalidInput("OCI image manifest does not match its descriptor");
    const oci = record(json(manifestPath), "Invalid OCI image manifest");
    if (
      oci.schemaVersion !== 2 ||
      oci.artifactType !== undefined ||
      oci.subject !== undefined ||
      oci.manifests !== undefined ||
      record(oci.config, "Invalid OCI image config").digest !== image ||
      records(oci.layers, "Invalid OCI image layers").some(
        (layer) =>
          typeof layer.digest !== "string" ||
          !imageDigest.test(layer.digest) ||
          !files.has(`blobs/sha256/${layer.digest.slice("sha256:".length)}`),
      )
    )
      throw new InvalidInput("OCI manifest does not describe the declared image");
  }
  return { sha256: digest.hash.digest("hex"), bytes: digest.bytes };
}
