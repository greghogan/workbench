import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import tar from "tar-stream";
import { afterEach, expect, test, vi } from "vitest";
import { installAsset } from "../src/tool-downloads.ts";
import { extractFilteredArtifact } from "../src/filtered-artifacts.ts";
import { artifactLimits } from "../src/artifact-streams.ts";
import { verifyAttestation } from "../src/artifact-attestations.ts";
import { acquisitionIdentity, filterIdentity } from "../src/artifact-policy.ts";

const temporary = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-filtered-"));
  temporary.push(root);
  return root;
}
async function archive(entries, compression = {}) {
  const pack = tar.pack();
  for (const { content = "", ...header } of entries) pack.entry(header, content);
  pack.finalize();
  const chunks = [];
  for await (const chunk of pack) chunks.push(chunk);
  return zstdCompressSync(Buffer.concat(chunks), compression);
}
function asset(bytes) {
  return {
    url: "https://tools.example/llvm.tar.zst",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    format: "tar",
    strip: 1,
    bin: "bin",
    filter: { revision: 1, include: ["^bin/"], required: ["bin/clang"] },
  };
}
function serve(bytes) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              for (let offset = 0; offset < bytes.length; offset += 73)
                controller.enqueue(bytes.subarray(offset, offset + 73));
              controller.close();
            },
          }),
        ),
      ),
    ),
  );
}

test("streaming extraction retains selected files, hashes their bytes, and installs without a downloaded archive", async () => {
  const root = fixture();
  const bytes = await archive([
    { name: "LLVM/bin/clang", content: "compiler", mode: 0o755 },
    { name: "LLVM/lib/unused.a", content: "discarded" },
  ]);
  serve(bytes);
  const pinned = asset(bytes);
  const destination = join(root, "installed");
  await installAsset(destination, pinned);
  expect(readFileSync(join(destination, "bin/clang"), "utf8")).toBe("compiler");
  expect(existsSync(join(destination, "lib"))).toBe(false);
  expect(readdirSync(root)).toEqual(["installed"]);
  const manifest = JSON.parse(readFileSync(join(destination, ".workbench-manifest.json"), "utf8"));
  expect(manifest.source).toBe(pinned.sha256);
  expect(manifest.filter).toBe(filterIdentity(pinned.filter));
  expect(manifest.entries).toEqual([
    {
      path: "bin/clang",
      mode: lstatSync(join(destination, "bin/clang")).mode & 0o777,
      bytes: 8,
      type: "file",
      sha256: createHash("sha256").update("compiler").digest("hex"),
    },
  ]);
  await installAsset(destination, pinned);
  writeFileSync(join(destination, "bin/clang"), "modified");
  await expect(installAsset(destination, pinned)).rejects.toThrow(/cache.*checksum/);
});

test("a wrong upstream checksum never activates extracted files and cleans its private staging", async () => {
  const root = fixture();
  const bytes = await archive([{ name: "LLVM/bin/clang", content: "compiler" }]);
  serve(bytes);
  await expect(installAsset(join(root, "installed"), { ...asset(bytes), sha256: "0".repeat(64) })).rejects.toThrow(
    /checksum/,
  );
  expect(readdirSync(root)).toEqual([]);
});

test("restored filtered caches bind acquisition policy and proof identities", async () => {
  const root = fixture();
  const bytes = await archive([{ name: "LLVM/bin/clang", content: "compiler" }]);
  serve(bytes);
  const pinned = asset(bytes);
  const destination = join(root, "installed");
  await installAsset(destination, pinned);
  for (const changed of [
    { ...pinned, url: "https://different.example/llvm.tar.zst" },
    { ...pinned, zstdWindowLogMax: 30 },
    {
      ...pinned,
      signature: { url: "https://tools.example/proof.sig", keys: "changed trust root", signers: ["A".repeat(40)] },
    },
  ]) {
    expect(acquisitionIdentity(changed)).not.toBe(acquisitionIdentity(pinned));
    await expect(installAsset(destination, changed)).rejects.toThrow(/cache identity/);
  }
  expect(readFileSync(join(destination, "bin/clang"), "utf8")).toBe("compiler");
});

test("stream filters reject traversal, escaping links, special files, and duplicate entries", async () => {
  const root = fixture();
  for (const extra of [
    { name: "LLVM/../../escaped", content: "bad" },
    { name: "LLVM/bin/alias", type: "symlink", linkname: "../../../escaped" },
    { name: "LLVM/bin/device", type: "character-device" },
    { name: "LLVM/bin/clang", content: "duplicate" },
  ]) {
    const bytes = await archive([{ name: "LLVM/bin/clang", content: "compiler" }, extra]);
    serve(bytes);
    await expect(installAsset(join(root, "installed"), asset(bytes))).rejects.toThrow(/archive/);
    expect(readdirSync(root)).toEqual([]);
  }
  expect(existsSync(join(root, "escaped"))).toBe(false);
});

test("deferred links cannot redirect a later write outside staging", async () => {
  const root = fixture();
  const bytes = await archive([
    { name: "LLVM/bin", type: "symlink", linkname: "target" },
    { name: "LLVM/bin/clang", content: "compiler" },
    { name: "LLVM/target", type: "directory" },
  ]);
  serve(bytes);
  const pinned = asset(bytes);
  pinned.filter.include = ["^bin(?:/|$)"];
  await expect(installAsset(join(root, "installed"), pinned)).rejects.toThrow();
  expect(readdirSync(root)).toEqual([]);
});

test("valid retained aliases resolve after the stream and survive cache verification", async () => {
  const root = fixture();
  const bytes = await archive([
    { name: "LLVM/bin/clang++", type: "symlink", linkname: "clang" },
    { name: "LLVM/bin/clang", content: "compiler" },
  ]);
  serve(bytes);
  const destination = join(root, "installed");
  await installAsset(destination, asset(bytes));
  expect(readFileSync(join(destination, "bin/clang++"), "utf8")).toBe("compiler");
  await installAsset(destination, asset(bytes));
});

test("retained links cannot become parents of subsequent deferred links", async () => {
  const root = fixture();
  const bytes = await archive([
    { name: "LLVM/bin/clang", content: "compiler" },
    { name: "LLVM/bin/alias", type: "symlink", linkname: "clang" },
    { name: "LLVM/bin/alias/child", type: "symlink", linkname: "../clang" },
  ]);
  serve(bytes);
  await expect(installAsset(join(root, "installed"), asset(bytes))).rejects.toThrow(/link.*parent/);
  expect(readdirSync(root)).toEqual([]);
});

test("discarding entries does not bypass decompressed, file, retained, or entry limits", async () => {
  const root = fixture();
  const bytes = await archive([
    { name: "LLVM/bin/clang", content: "compiler" },
    { name: "LLVM/lib/unused.a", content: "x".repeat(8192) },
  ]);
  for (const [override, expected] of [
    [{ compressed: 1 }, /download.*limit/],
    [{ decompressed: 1024 }, /decompressed.*limit/],
    [{ file: 64 }, /entry.*limit/],
    [{ retained: 4 }, /retained.*limit/],
    [{ entries: 1 }, /entry limit/],
  ]) {
    const stage = join(root, String(readdirSync(root).length));
    mkdirSync(stage);
    serve(bytes);
    await expect(extractFilteredArtifact(asset(bytes), stage, { ...artifactLimits, ...override })).rejects.toThrow(
      expected,
    );
  }
});

test("extended metadata is bounded before the tar parser buffers it", async () => {
  const root = fixture();
  const bytes = await archive([
    { name: `LLVM/lib/${"a".repeat(2048)}`, content: "ignored" },
    { name: "LLVM/bin/clang", content: "compiler" },
  ]);
  serve(bytes);
  await expect(extractFilteredArtifact(asset(bytes), root, { ...artifactLimits, metadata: 256 })).rejects.toThrow(
    /metadata.*limit/,
  );
});

test("Zstandard rejects an excessive decompression window independently of output limits", async () => {
  const root = fixture();
  const bytes = await archive([{ name: "LLVM/bin/clang", content: "x".repeat(1024 ** 2) }], {
    params: { [constants.ZSTD_c_windowLog]: 20 },
  });
  serve(bytes);
  await expect(extractFilteredArtifact(asset(bytes), root, { ...artifactLimits, windowLog: 10 })).rejects.toThrow(
    /memory|window/i,
  );
});

test("pinned Zstandard window limits are enforced and invalid limits fail before acquisition", async () => {
  const root = fixture();
  const bytes = await archive([{ name: "LLVM/bin/clang", content: "x".repeat(1024 ** 2) }], {
    params: { [constants.ZSTD_c_windowLog]: 20 },
  });
  serve(bytes);
  for (const zstdWindowLogMax of [9, 31, 1.5]) {
    await expect(installAsset(join(root, "installed"), { ...asset(bytes), zstdWindowLogMax })).rejects.toThrow(
      /window limit/,
    );
  }
  expect(fetch).not.toHaveBeenCalled();
  await expect(installAsset(join(root, "installed"), { ...asset(bytes), zstdWindowLogMax: 10 })).rejects.toThrow(
    /memory|window/i,
  );
  expect(readdirSync(root)).toEqual([]);
  await installAsset(join(root, "installed"), { ...asset(bytes), zstdWindowLogMax: 20 });
  expect(readFileSync(join(root, "installed/bin/clang")).length).toBe(1024 ** 2);
});

test("required components must survive filtering", async () => {
  const root = fixture();
  const bytes = await archive([{ name: "LLVM/lib/unused.a", content: "discarded" }]);
  serve(bytes);
  await expect(installAsset(join(root, "installed"), asset(bytes))).rejects.toThrow(/missing required component/);
  expect(readdirSync(root)).toEqual([]);
});

test("LLVM's signed provenance verifies against pinned trust roots and rejects another artifact or signer", () => {
  const text = readFileSync(new URL("./fixtures/llvm21-attestation.jsonl", import.meta.url), "utf8");
  const roots = readFileSync(new URL("../scripts/keys/sigstore-trusted-root.jsonl", import.meta.url), "utf8");
  const metadata = {
    roots,
    subject: "LLVM-21.1.8-Linux-X64.tar.xz",
    signer: "https://github.com/llvm/llvm-project/.github/workflows/release-binaries.yml@refs/tags/llvmorg-21.1.8",
  };
  const digest = "b3b7f2801d15d50736acea3c73982994d025b01c2f035b91ae3b49d1b575732b";
  expect(() => verifyAttestation(text, digest, metadata)).not.toThrow();
  expect(() => verifyAttestation(text, "0".repeat(64), metadata)).toThrow(/attestation verification/);
  expect(() =>
    verifyAttestation(text, digest, { ...metadata, signer: "https://github.com/another/repository/build.yml" }),
  ).toThrow(/attestation verification/);
});
