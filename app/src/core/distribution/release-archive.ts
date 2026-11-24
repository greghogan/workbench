import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readBoundedFile } from "../runtime/file-reads.js";
import { extractArchive } from "../toolchains/tool-downloads.js";
import { readDistributionManifest } from "./distribution-source-manifest.js";

const releaseArchiveName = "workbench.tar.gz";
const archiveByteLimit = 512 * 1024 * 1024;

export function readReleaseChecksum(artifacts: string): string {
  const contents = readBoundedFile(join(artifacts, "SHA256SUMS"), 4096, "Workbench checksums").toString();
  const sha256 = /^([a-f0-9]{64}) {2}workbench\.tar\.gz\n$/.exec(contents)?.[1];
  if (!sha256) throw new Error("Expected a SHA-256 checksum for workbench.tar.gz");
  return sha256;
}

/** Use the same verified private bytes for unpacking and for delegating installation to npm. */
export async function stageReleaseArchive(source: string, sha256: string, scratch: string) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("A Workbench release requires its expected SHA-256 checksum");
  const bytes = readBoundedFile(source, archiveByteLimit, "Workbench release archive");
  if (createHash("sha256").update(bytes).digest("hex") !== sha256)
    throw new Error("Workbench release archive checksum mismatch");
  const archive = join(scratch, releaseArchiveName);
  writeFileSync(archive, bytes, { flag: "wx", mode: 0o600 });
  const destination = join(scratch, "release");
  mkdirSync(destination, { mode: 0o700 });
  const directory = await extractArchive(archive, destination, {
    url: pathToFileURL(archive).href,
    sha256,
    format: "tar",
    strip: 1,
    bin: "bin",
  });
  return { archive, directory, manifest: readDistributionManifest(directory) };
}
