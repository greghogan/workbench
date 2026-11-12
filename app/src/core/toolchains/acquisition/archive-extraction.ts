import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  lstatSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, join, posix, relative, isAbsolute } from "node:path";
import { Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { openPromise, type Entry, type ZipFile } from "yauzl";
import { archiveDecoder } from "./artifact-decoders.js";
import { ByteLimit, TarGuard, type ArtifactLimits } from "./artifact-streams.js";
import { archivePath } from "./archive-paths.js";

function nextZipEntry(zip: ZipFile, signal: AbortSignal): Promise<Entry | undefined> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.removeListener("entry", entry);
      zip.removeListener("end", end);
      zip.removeListener("error", error);
      signal.removeEventListener("abort", abort);
    };
    const entry = (value: Entry) => {
      cleanup();
      resolve(value);
    };
    const end = () => {
      cleanup();
      resolve(undefined);
    };
    const error = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const abort = () => {
      error(new Error("tool extraction cancelled", { cause: signal.reason }));
    };
    zip.once("entry", entry);
    zip.once("end", end);
    zip.once("error", error);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else zip.readEntry();
  });
}

/** Preflight verified tar bytes before the platform extractor writes any archive member. */
export async function boundTarArchive(archive: string, limits: ArtifactLimits): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("tool extraction exceeded its deadline"));
  }, limits.milliseconds);
  const decoder = archiveDecoder(archive, controller.signal, limits.windowLog);
  const parser = tar.extract();
  const tasks = [
    pipeline(createReadStream(archive), new ByteLimit(limits.compressed, "tool archive"), decoder.input, {
      signal: controller.signal,
    }),
    pipeline(decoder.output, new TarGuard(limits), parser, { signal: controller.signal }),
    decoder.completed,
  ];
  const transfers = Promise.all(tasks);
  void transfers.catch(() => {
    // The owning await below propagates failures while the parser consumes entries.
  });
  try {
    let bytes = 0;
    let entries = 0;
    for await (const entry of parser) {
      const header: Partial<tar.Header> = entry.header;
      const size = header.size ?? 0;
      if (!Number.isSafeInteger(size) || size < 0 || size > limits.file)
        throw new Error("archive entry exceeds its size limit");
      if (++entries > limits.entries) throw new Error("archive exceeds its entry limit");
      bytes += size;
      if (bytes > limits.retained) throw new Error("archive exceeds its retained byte limit");
      await pipeline(
        entry,
        new ByteLimit(size, "archive entry"),
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        { signal: controller.signal },
      );
    }
    await transfers;
  } catch (error) {
    controller.abort();
    parser.destroy(error as Error);
    await Promise.allSettled(tasks);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** ZIP uses lazy central-directory iteration and bounded streams, without a platform unzip process. */
export async function extractZipArchive(
  archive: string,
  destination: string,
  strip: number,
  limits: ArtifactLimits,
  links: Readonly<Record<string, string>> = {},
): Promise<string> {
  if (limits.milliseconds <= 0) throw new Error("tool extraction exceeded its deadline");
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("tool extraction exceeded its deadline"));
  }, limits.milliseconds);
  const zip = await openPromise(archive, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }).catch(
    (error: unknown) => {
      clearTimeout(timer);
      throw error;
    },
  );
  let active: Readable | undefined;
  let failure: Error | undefined;
  const error = (cause: Error) => {
    failure = cause;
    active?.destroy(cause);
  };
  zip.on("error", error);
  try {
    if (zip.fileSize > limits.compressed) throw new Error("tool archive exceeds its byte limit");
    if (zip.entryCount > limits.entries) throw new Error("archive exceeds its entry limit");
    if (Buffer.byteLength(zip.comment) > limits.metadata) throw new Error("archive metadata exceeds its size limit");
    const names = new Set<string>();
    const pendingLinks = new Map<string, string>();
    let bytes = 0;
    let entries = 0;
    for (
      let entry = await nextZipEntry(zip, controller.signal);
      entry;
      entry = await nextZipEntry(zip, controller.signal)
    ) {
      controller.signal.throwIfAborted();
      if (failure) throw failure;
      if (++entries > limits.entries) throw new Error("archive exceeds its entry limit");
      if (entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength > limits.metadata)
        throw new Error("archive metadata exceeds its size limit");
      const name = archivePath(entry.fileName);
      const key = process.platform === "win32" ? name.toLowerCase() : name;
      if (names.has(key)) throw new Error("tool archive contains duplicate paths");
      names.add(key);
      if (
        [".workbench-artifact", ".workbench-manifest.json", ".workbench-manifest.sha256"].includes(
          name.split("/")[strip] ?? "",
        )
      )
        throw new Error("tool archive conflicts with installation metadata");
      const mode = entry.externalFileAttributes >>> 16;
      const type = mode & 0o170000;
      const directory = entry.fileName.endsWith("/");
      const link = type === 0o120000 && Object.hasOwn(links, name) ? links[name] : undefined;
      if ((type !== 0 && type !== (directory ? 0o040000 : 0o100000) && link === undefined) || entry.isEncrypted())
        throw new Error("ZIP tool archives must contain only unencrypted files and directories");
      const size = entry.uncompressedSize;
      if (!Number.isSafeInteger(size) || size < 0 || size > limits.file || (directory && size !== 0))
        throw new Error("archive entry exceeds its size limit");
      bytes += size;
      if (bytes > limits.retained || bytes > limits.decompressed)
        throw new Error("archive exceeds its retained byte limit");
      const output = join(destination, name);
      if (link !== undefined) {
        if (process.platform === "win32") throw new Error("ZIP symbolic links require a POSIX host");
        archivePath(link);
        const prefix = name.split("/").slice(0, strip).join("/");
        const target = posix.join(posix.dirname(name), link);
        if (strip && !target.startsWith(`${prefix}/`)) throw new Error("ZIP symbolic link escapes the retained root");
        if (size > limits.metadata) throw new Error("ZIP symbolic link exceeds metadata limit");
        const source = await zip.openReadStreamPromise(entry);
        active = source;
        const chunks: Buffer[] = [];
        await pipeline(
          source,
          new ByteLimit(size, "ZIP symbolic link"),
          new Writable({
            write(chunk: Buffer, _encoding, callback) {
              chunks.push(chunk);
              callback();
            },
          }),
          { signal: controller.signal },
        );
        if (Buffer.concat(chunks).toString("utf8") !== link)
          throw new Error("ZIP symbolic link differs from its reviewed target");
        pendingLinks.set(name, link);
        active = undefined;
      } else if (directory) mkdirSync(output, { recursive: true, mode: 0o700 });
      else {
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
        const source = await zip.openReadStreamPromise(entry);
        active = source;
        const measured = new ByteLimit(size, "archive entry");
        await pipeline(source, measured, createWriteStream(output, { flags: "wx", mode: (mode || 0o755) & 0o755 }), {
          signal: controller.signal,
        });
        if (measured.bytes !== size) throw new Error("truncated archive entry");
        active = undefined;
      }
    }
    controller.signal.throwIfAborted();
    let content = destination;
    if (strip !== 0) {
      const roots = readdirSync(destination);
      const root = roots[0];
      if (strip !== 1 || roots.length !== 1 || !root || !lstatSync(join(destination, root)).isDirectory())
        throw new Error("tool archive has an unexpected directory layout");
      content = join(destination, root);
    }
    if (Object.keys(links).some((name) => !pendingLinks.has(name)))
      throw new Error("ZIP is missing a reviewed symbolic link");
    for (const [name, target] of pendingLinks) {
      const path = join(destination, name);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      symlinkSync(target, path);
    }
    for (const name of pendingLinks.keys()) {
      const target = relative(realpathSync(content), realpathSync(join(destination, name)));
      if (isAbsolute(target) || target === ".." || target.startsWith("../"))
        throw new Error("ZIP symbolic link escapes the retained root");
    }
    return content;
  } finally {
    active?.destroy();
    zip.close();
    clearTimeout(timer);
  }
}
