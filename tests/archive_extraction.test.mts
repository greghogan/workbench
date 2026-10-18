import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync, gzipSync, zstdCompressSync } from "node:zlib";
import tar from "tar-stream";
import { afterEach, expect, test, vi } from "vitest";
import { boundTarArchive, extractZipArchive } from "../src/archive-extraction.ts";
import { artifactLimits } from "../src/artifact-streams.ts";
import { installAsset } from "../src/tool-downloads.ts";
import { createHash } from "node:crypto";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  temporary.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});
function fixture(bytes: string | Buffer<ArrayBuffer> | NodeJS.ArrayBufferView, extension = ".zip") {
  const root = mkdtempSync(join(tmpdir(), "workbench-archive-bounds-"));
  temporary.push(root);
  const archive = join(root, `archive${extension}`);
  writeFileSync(archive, bytes);
  const destination = join(root, "content");
  mkdirSync(destination);
  return { root, archive, destination };
}
// Construct ZIP headers directly so malformed declarations remain independent of the reader.
interface ZipEntry {
  name: string;
  content?: string;
  mode?: number;
  size?: number;
  comment?: string;
}
function zip(entries: ZipEntry[]) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, content = "", mode = 0o100755, size, comment = "" } of entries) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(content);
    const compressed = deflateRawSync(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(size ?? bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    header.copy(directory, 6, 4, 30);
    directory.writeUInt16LE(Buffer.byteLength(comment), 32);
    directory.writeUInt32LE((mode << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed);
    central.push(directory, filename, Buffer.from(comment));
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function tarBytes() {
  const pack = tar.pack();
  pack.entry({ name: "bin/tool", mode: 0o755 }, "hello");
  pack.entry({ name: "share/readme" }, "world");
  pack.finalize();
  const chunks = [];
  for await (const chunk of pack) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Expected archive bytes");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

test("ZIP extraction preserves executable content and supports the declared top directory", async () => {
  const { archive, destination } = fixture(zip([{ name: "tool/bin/checker", content: "ready" }]));
  const content = await extractZipArchive(archive, destination, 1, artifactLimits);
  expect(content).toBe(join(destination, "tool"));
  expect(readFileSync(join(content, "bin/checker"), "utf8")).toBe("ready");
});

test.each([
  [[{ name: "../outside" }], /unsafe|invalid relative path/],
  [[{ name: "link", mode: 0o120777, content: "outside" }], /only unencrypted files and directories/],
  [[{ name: "device", mode: 0o020600 }], /only unencrypted files and directories/],
  [[{ name: "tool" }, { name: "./tool" }], /duplicate/],
  [[{ name: "tool", content: "too much data", size: 1 }], /size|byte limit|too many bytes/],
])("ZIP rejects unsafe entries or false size declarations: %j", async (entries, error) => {
  const { archive, destination } = fixture(zip(entries));
  await expect(extractZipArchive(archive, destination, 0, artifactLimits)).rejects.toThrow(error);
});

test.each([
  [{ compressed: 10 }, /byte limit/],
  [{ file: 4 }, /size limit/],
  [{ retained: 9 }, /retained byte limit/],
  [{ decompressed: 9 }, /retained byte limit/],
  [{ entries: 1 }, /entry limit/],
  [{ metadata: 2 }, /metadata/],
])("ZIP independently enforces resource bound %j", async (override, error) => {
  const { archive, destination } = fixture(
    zip([
      { name: "one", content: "hello" },
      { name: "two", content: "world" },
    ]),
  );
  await expect(extractZipArchive(archive, destination, 0, { ...artifactLimits, ...override })).rejects.toThrow(error);
});

test("ZIP installation failures remove private extraction data without activating content", async () => {
  const bytes = zip([{ name: "tool", content: "expanded payload", size: 1 }]);
  const { root } = fixture(bytes);
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  vi.stubGlobal("fetch", () => Promise.resolve(new Response(bytes)));
  await expect(
    installAsset(join(root, "installed"), {
      url: "https://tools.example/tool.zip",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: "zip",
      strip: 0,
      bin: ".",
    }),
  ).rejects.toThrow(/size|byte limit|too many bytes/);
  expect(readdirSync(root).sort()).toEqual(["archive.zip", "cache", "content"]);
});

test.each([
  [".tar", (bytes: Buffer) => bytes],
  [".tar.gz", gzipSync],
  [".tar.zst", zstdCompressSync],
])("ordinary tar preflight supports %s without writing extracted files", async (extension, compress) => {
  const { archive, destination } = fixture(compress(await tarBytes()), extension);
  await boundTarArchive(archive, artifactLimits);
  expect(readdirSync(destination)).toEqual([]);
});

test.each([
  [{ compressed: 10 }, /byte limit/],
  [{ decompressed: 100 }, /decompressed byte limit/],
  [{ file: 4 }, /size limit/],
  [{ retained: 9 }, /retained byte limit/],
  [{ entries: 1 }, /entry limit/],
])("ordinary tar independently enforces resource bound %j", async (override, error) => {
  const { archive } = fixture(await tarBytes(), ".tar");
  await expect(boundTarArchive(archive, { ...artifactLimits, ...override })).rejects.toThrow(error);
});

test("entry overrides reject values outside the declared hard cap before any download", async () => {
  const { root } = fixture(Buffer.alloc(0));
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    installAsset(join(root, "installed"), {
      url: "https://tools.example/tool.tar",
      sha256: "a".repeat(64),
      format: "tar",
      strip: 0,
      bin: ".",
      archiveLimits: { entries: 400001 },
    }),
  ).rejects.toThrow(/entry override/);
  expect(fetcher).not.toHaveBeenCalled();
});

test("expired ZIP extraction deadlines reject and release the archive", async () => {
  const { archive, destination } = fixture(zip([{ name: "tool", content: "ready" }]));
  await expect(extractZipArchive(archive, destination, 0, { ...artifactLimits, milliseconds: 0 })).rejects.toThrow(
    /deadline|cancel|abort/i,
  );
});

test("tar extended metadata and overridden entry sizes remain bounded before platform extraction", async () => {
  const cases: [Record<string, string>, Partial<typeof artifactLimits>, RegExp][] = [
    [{ comment: "x".repeat(100) }, { metadata: 16 }, /metadata/],
    [{ size: "1000000" }, { file: 1024 }, /size limit/],
  ];
  for (const [pax, override, expected] of cases) {
    const pack = tar.pack();
    const header: Partial<tar.Header> & Pick<tar.Header, "name"> & { pax: Record<string, string> } = {
      name: "tool",
      pax,
    };
    pack.entry(header, "hello");
    pack.finalize();
    const chunks = [];
    for await (const chunk of pack) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Expected archive bytes");
      chunks.push(chunk);
    }
    const { archive } = fixture(Buffer.concat(chunks), ".tar");
    await expect(boundTarArchive(archive, { ...artifactLimits, ...override })).rejects.toThrow(expected);
  }
});

test("PECL .tgz sources receive bounded gzip decoding", async () => {
  const { archive } = fixture(gzipSync(await tarBytes()), ".tgz");
  await expect(boundTarArchive(archive, artifactLimits)).resolves.toBeUndefined();
  await expect(boundTarArchive(archive, { ...artifactLimits, decompressed: 512 })).rejects.toThrow(/byte limit/);
});
