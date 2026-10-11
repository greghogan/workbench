import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  createReadStream,
  realpathSync,
  symlinkSync,
  linkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { archiveDecoder } from "./artifact-decoders.js";
import { artifactLimits, artifactResponse, DigestStream, TarGuard, type ArtifactLimits } from "./artifact-streams.js";
import { authenticateChecksums, signatureVerifier } from "./artifact-signatures.js";
import { authenticateAttestation } from "./artifact-attestations.js";
import { archivePath, unsafeArchiveText, type ToolAsset } from "./tool-downloads.js";
import { acquisitionIdentity, acquisitionProvenance, filterIdentity, type ArchiveFilter } from "./artifact-policy.js";

interface ManifestEntry {
  path: string;
  mode: number;
  bytes: number;
  sha256?: string;
  link?: string;
  type: string;
}
function validateFilter(filter: ArchiveFilter): RegExp[] {
  if (
    !Number.isSafeInteger(filter.revision) ||
    filter.revision < 1 ||
    !filter.include.length ||
    !filter.required.length
  )
    throw new Error("archive filter requires a revision, inclusion rules, and required components");
  filter.required.forEach(archivePath);
  return filter.include.map((pattern) => {
    if (pattern.length > 512 || !pattern.startsWith("^"))
      throw new Error("archive filter requires bounded, anchored expressions");
    return new RegExp(pattern);
  });
}

/** Hash the original bytes and retained files during extraction; no full downloaded archive reaches disk. */
export async function extractFilteredArtifact(
  asset: ToolAsset & { filter: ArchiveFilter },
  destination: string,
  limits: ArtifactLimits = artifactLimits,
): Promise<string> {
  const patterns = validateFilter(asset.filter);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("tool acquisition exceeded its deadline"));
  }, limits.milliseconds);
  const signature = asset.signature
    ? await signatureVerifier(asset.signature, destination, controller.signal).catch((error: unknown) => {
        clearTimeout(timer);
        throw error;
      })
    : undefined;
  const incoming = new DigestStream(limits.compressed, "tool download");
  const parser = tar.extract();
  const entries: ManifestEntry[] = [];
  const names = new Set<string>();
  const links: { path: string; target: string; type: string; original: string }[] = [];
  let retained = 0;
  let top: string | undefined;
  let decoder: Readable | undefined;
  let compressedTask: Promise<void> | undefined;
  let decoderDone: Promise<void> | undefined;
  try {
    if (asset.attestation) await authenticateAttestation(asset.attestation, asset.sha256, controller.signal);
    if (asset.checksums) await authenticateChecksums(asset.checksums, asset.sha256, destination, controller.signal);
    const source = await artifactResponse(asset.url, controller.signal);
    const url = new URL(asset.url).pathname;
    const decompressor = archiveDecoder(url, controller.signal, limits.windowLog);
    decoder = decompressor.output;
    decoderDone = decompressor.completed;
    compressedTask = signature
      ? pipeline(source, incoming, signature.relay, decompressor.input, { signal: controller.signal })
      : pipeline(source, incoming, decompressor.input, { signal: controller.signal });
    // Attach rejection handlers immediately while the asynchronous entry consumer drains the parser.
    const extraction = pipeline(decoder, new TarGuard(limits), parser, { signal: controller.signal });
    const transferTasks = [compressedTask, extraction, decoderDone];
    const transfers = Promise.all(transferTasks);
    void transfers.catch(() => {
      // Observe early rejection while entries are consumed; await transfers below propagates the failure.
    });
    try {
      for await (const entry of parser) {
        const header = entry.header;
        const size = header.size ?? 0;
        const full = archivePath(header.name);
        const components = full.split("/");
        if (asset.strip === 1) {
          top ??= components[0];
          if (components[0] !== top) throw new Error("tool archive has an unexpected directory layout");
        }
        const name = components.slice(asset.strip).join("/");
        if (!name) {
          if (header.type !== "directory") throw new Error("invalid archive root");
          entry.resume();
          continue;
        }
        const key = process.platform === "win32" ? name.toLowerCase() : name;
        if (names.has(key)) throw new Error("tool archive contains duplicate paths");
        names.add(key);
        if (!["file", "directory", "symlink", "link"].includes(header.type ?? ""))
          throw new Error("tool archive contains a special file");
        if (!Number.isSafeInteger(size) || size < 0 || size > limits.file)
          throw new Error("archive entry exceeds its size limit");
        let target: string | undefined;
        if (header.type === "symlink" || header.type === "link") {
          const raw = header.linkname ?? "";
          if (!raw || unsafeArchiveText(raw) || raw.startsWith("/")) throw new Error("unsafe tool archive link target");
          const resolved = header.type === "symlink" ? posix.normalize(posix.join(posix.dirname(full), raw)) : raw;
          archivePath(resolved);
          if (asset.strip === 1 && resolved.split("/")[0] !== top)
            throw new Error("tool archive link escapes its top directory");
          target = resolved.split("/").slice(asset.strip).join("/");
          if (!target) throw new Error("tool archive link resolves to its root");
        }
        if (!patterns.some((pattern) => pattern.test(name))) {
          entry.resume();
          continue;
        }
        if (
          [".workbench-artifact", ".workbench-manifest.json", ".workbench-manifest.sha256"].includes(
            name.split("/")[0] ?? "",
          )
        )
          throw new Error("tool archive conflicts with installation metadata");
        const output = join(destination, "content", name);
        const mode = (header.mode ?? 0o644) & 0o755;
        if (header.type === "directory") {
          entry.resume();
          continue;
        }
        if (target !== undefined) {
          links.push({ path: name, target, type: header.type ?? "", original: header.linkname ?? "" });
          entries.push({ path: name, mode, bytes: 0, type: header.type ?? "", link: target });
          entry.resume();
          continue;
        }
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
        retained += size;
        if (retained > limits.retained) throw new Error("archive exceeds its retained byte limit");
        const file = new DigestStream(size, "retained archive entry");
        await pipeline(entry, file, createWriteStream(output, { flags: "wx", mode }));
        if (file.bytes !== size) throw new Error("truncated archive entry");
        entries.push({
          path: name,
          mode: lstatSync(output).mode & 0o777,
          bytes: file.bytes,
          sha256: file.hash.digest("hex"),
          type: "file",
        });
      }
      await transfers;
    } catch (error) {
      controller.abort();
      parser.destroy(error as Error);
      // Drain canceled transfers while preserving the entry consumer's original error.
      await Promise.allSettled(transferTasks);
      throw error;
    }
    if (incoming.hash.digest("hex") !== asset.sha256) throw new Error("tool artifact checksum mismatch");
    await signature?.finish();
    const content = join(destination, "content");
    const linkNames = new Set(
      links.map((link) => (process.platform === "win32" ? link.path.toLowerCase() : link.path)),
    );
    for (const entry of entries) {
      let parent = posix.dirname(entry.path);
      while (parent !== ".") {
        if (linkNames.has(process.platform === "win32" ? parent.toLowerCase() : parent))
          throw new Error("tool archive link has a link as its parent");
        parent = posix.dirname(parent);
      }
    }
    for (const link of links) {
      const path = join(content, link.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (link.type === "symlink") symlinkSync(link.original, path, "file");
      else {
        const target = join(content, link.target);
        if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())
          throw new Error("archive hard link requires a retained regular file");
        linkSync(target, path);
      }
    }
    for (const link of links) {
      const within = relative(realpathSync(content), realpathSync(join(content, link.path)));
      if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
        throw new Error("tool archive link escapes installation");
    }
    for (const required of asset.filter.required)
      if (!existsSync(join(content, required)))
        throw new Error(`tool archive is missing required component: ${required}`);
    const manifest = JSON.stringify({
      source: asset.sha256,
      filter: filterIdentity(asset.filter),
      policy: acquisitionIdentity(asset),
      provenance: acquisitionProvenance(asset),
      entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    });
    writeFileSync(join(content, ".workbench-manifest.json"), manifest);
    writeFileSync(join(content, ".workbench-manifest.sha256"), createHash("sha256").update(manifest).digest("hex"));
    return content;
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Transfers are checked before success; on failure these settle cancellation without replacing its cause.
    await Promise.allSettled([compressedTask, decoderDone]);
    await signature?.cancel();
  }
}

export async function verifyFilteredInstallation(
  directory: string,
  asset: ToolAsset & { filter: ArchiveFilter },
): Promise<void> {
  validateFilter(asset.filter);
  const manifestPath = join(directory, ".workbench-manifest.json");
  if (
    !lstatSync(manifestPath).isFile() ||
    lstatSync(manifestPath).isSymbolicLink() ||
    lstatSync(manifestPath).size > 32 * 1024 ** 2
  )
    throw new Error("filtered cache manifest exceeds its size limit or has an invalid type");
  const manifest = readFileSync(manifestPath, "utf8");
  const checksumPath = join(directory, ".workbench-manifest.sha256");
  if (
    !lstatSync(checksumPath).isFile() ||
    lstatSync(checksumPath).isSymbolicLink() ||
    lstatSync(checksumPath).size !== 64
  )
    throw new Error("filtered cache manifest checksum has an invalid type or size");
  if (createHash("sha256").update(manifest).digest("hex") !== readFileSync(checksumPath, "utf8"))
    throw new Error("filtered cache manifest checksum mismatch");
  const parsed = JSON.parse(manifest) as {
    source: string;
    filter: string;
    policy: string;
    provenance: unknown;
    entries: ManifestEntry[];
  };
  if (
    parsed.source !== asset.sha256 ||
    parsed.filter !== filterIdentity(asset.filter) ||
    parsed.policy !== acquisitionIdentity(asset) ||
    JSON.stringify(parsed.provenance) !== JSON.stringify(acquisitionProvenance(asset))
  )
    throw new Error("filtered cache identity mismatch");
  if (!Array.isArray(parsed.entries) || parsed.entries.length > artifactLimits.entries)
    throw new Error("filtered cache exceeds its entry limit");
  const allowed = new Set([".workbench-artifact", ".workbench-manifest.json", ".workbench-manifest.sha256"]);
  const expected = new Set(parsed.entries.map((entry) => archivePath(entry.path)));
  if (expected.size !== parsed.entries.length) throw new Error("filtered cache has duplicate entries");
  let count = 0;
  const inspect = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (++count > artifactLimits.entries) throw new Error("filtered cache exceeds its entry limit");
      const path = join(folder, entry.name);
      const name = relative(directory, path).split(sep).join("/");
      if (entry.isDirectory() && !entry.isSymbolicLink()) inspect(path);
      else if (!expected.has(name) && !allowed.has(name)) throw new Error("filtered cache contains an unexpected file");
    }
  };
  inspect(directory);
  let retained = 0;
  for (const entry of parsed.entries) {
    const path = join(directory, archivePath(entry.path));
    let parent = dirname(path);
    while (parent !== directory) {
      if (lstatSync(parent).isSymbolicLink()) throw new Error("filtered cache has a redirected parent directory");
      parent = dirname(parent);
    }
    if (entry.type === "file") {
      if (
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        entry.bytes > artifactLimits.file ||
        lstatSync(path).size !== entry.bytes ||
        (retained += entry.bytes) > artifactLimits.retained
      )
        throw new Error("filtered cache file exceeds its size limit or differs from its receipt");
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
        throw new Error("filtered cache file type mismatch");
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of createReadStream(path)) {
        bytes += (chunk as Buffer).length;
        hash.update(chunk as Buffer);
      }
      if (hash.digest("hex") !== entry.sha256 || bytes !== entry.bytes)
        throw new Error("filtered cache file checksum mismatch");
      if (process.platform !== "win32" && (lstatSync(path).mode & 0o777) !== entry.mode)
        throw new Error("filtered cache file permission mismatch");
    } else {
      if (entry.type === "symlink") {
        if (
          !lstatSync(path).isSymbolicLink() ||
          posix.normalize(posix.join(posix.dirname(entry.path), readlinkSync(path))) !== entry.link
        )
          throw new Error("filtered cache link target mismatch");
      } else if (entry.type === "link" && entry.link) {
        const source = lstatSync(join(directory, archivePath(entry.link)));
        const link = lstatSync(path);
        if (!source.isFile() || !link.isFile() || source.ino !== link.ino || source.dev !== link.dev)
          throw new Error("filtered cache hard link mismatch");
      } else throw new Error("filtered cache has an invalid entry type");
      const target = relative(realpathSync(directory), realpathSync(path));
      if (isAbsolute(target) || target === ".." || target.startsWith(`..${sep}`))
        throw new Error("filtered cache link escapes installation");
    }
  }
  for (const path of asset.filter.required)
    if (!existsSync(join(directory, path))) throw new Error(`filtered cache is missing required component: ${path}`);
}
