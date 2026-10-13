import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { authenticateChecksums } from "../src/artifact-signatures.ts";
import { authenticateAttestation, verifyAttestation } from "../src/artifact-attestations.ts";
import { artifactResponse } from "../src/artifact-streams.ts";
import { download } from "../src/tool-downloads.ts";
import { createHash } from "node:crypto";

const temporary = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-authentication-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  return root;
}
const file = (path) => readFileSync(new URL(path, import.meta.url));
function nodeChecksums() {
  const pinned = JSON.parse(file("../scripts/native-assets.json")).node["24.21.0"]["linux-x64"];
  pinned.checksums.signature.keys = file("../scripts/keys/node.asc").toString("utf8");
  return pinned;
}
function serveCatalog({
  catalog = file("./fixtures/node-shasums.txt"),
  signature = file("./fixtures/node-shasums.sig"),
} = {}) {
  const fetcher = vi.fn((url) => Promise.resolve(new Response(String(url).endsWith(".sig") ? signature : catalog)));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

test("real signed checksum catalogs bind the exact filename, digest, and pinned signer", async () => {
  const root = fixture();
  const pinned = nodeChecksums();
  serveCatalog();
  await authenticateChecksums(pinned.checksums, pinned.sha256, root, AbortSignal.timeout(10000));
  await expect(
    authenticateChecksums(pinned.checksums, "0".repeat(64), root, AbortSignal.timeout(10000)),
  ).rejects.toThrow(/filename and digest/);
  await expect(
    authenticateChecksums(
      { ...pinned.checksums, subject: "different.tar.gz" },
      pinned.sha256,
      root,
      AbortSignal.timeout(10000),
    ),
  ).rejects.toThrow(/filename and digest/);
  await expect(
    authenticateChecksums(
      { ...pinned.checksums, signature: { ...pinned.checksums.signature, signers: ["A".repeat(40)] } },
      pinned.sha256,
      root,
      AbortSignal.timeout(10000),
    ),
  ).rejects.toThrow(/approved fingerprint/);
  const cmake = JSON.parse(file("../scripts/native-assets.json")).cmake["4.4.4"]["linux-x64"];
  cmake.checksums.signature.keys = file("../scripts/keys/cmake.asc").toString("utf8");
  vi.stubGlobal(
    "fetch",
    vi.fn((url) =>
      Promise.resolve(
        new Response(
          String(url).endsWith(".asc") ? file("./fixtures/cmake-shasums.sig") : file("./fixtures/cmake-shasums.txt"),
        ),
      ),
    ),
  );
  await authenticateChecksums(cmake.checksums, cmake.sha256, root, AbortSignal.timeout(10000));
});

test("failed publisher authentication prevents downloading an artifact and removes private staging", async () => {
  const root = fixture();
  const pinned = nodeChecksums();
  const catalog = file("./fixtures/node-shasums.txt").toString("utf8").replace(pinned.sha256, "0".repeat(64));
  const fetcher = serveCatalog({ catalog });
  await expect(download(pinned)).rejects.toThrow(/signature verification/);
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    pinned.checksums.url,
    pinned.checksums.signature.url,
  ]);
  expect(readdirSync(join(root, "cache/downloads"))).toEqual([]);
  serveCatalog({ signature: "invalid signature" });
  await expect(download(pinned)).rejects.toThrow(/signature verification/);
  expect(readdirSync(join(root, "cache/downloads"))).toEqual([]);
});

test("proof downloads are bounded and cannot redirect to insecure transport", async () => {
  const root = fixture();
  const pinned = nodeChecksums();
  serveCatalog({ catalog: Buffer.alloc(2 * 1024 ** 2 + 1) });
  await expect(download(pinned)).rejects.toThrow(/catalog exceeds/);
  serveCatalog({ signature: Buffer.alloc(64 * 1024 + 1) });
  await expect(download(pinned)).rejects.toThrow(/signature exceeds/);
  vi.stubGlobal(
    "fetch",
    async () => new Response(null, { status: 302, headers: { location: "http://tools.example/proof" } }),
  );
  await expect(download(pinned)).rejects.toThrow(/HTTPS/);
  expect(readdirSync(join(root, "cache/downloads"))).toEqual([]);
});

test("GitHub release attestations bind repository and tag as well as the artifact", () => {
  const pinned = JSON.parse(file("../scripts/native-assets.json"))["cargo-nextest"]["0.9.140"]["linux-x64"];
  const metadata = {
    ...pinned.attestation,
    roots: file("../scripts/keys/sigstore-trusted-root.jsonl").toString("utf8"),
  };
  const proof = file("./fixtures/nextest-release-attestation.json").toString("utf8");
  expect(() => verifyAttestation(proof, pinned.sha256, metadata)).not.toThrow();
  for (const release of [
    { ...metadata.release, repository: "other/repository" },
    { ...metadata.release, tag: "other-tag" },
  ]) {
    expect(() => verifyAttestation(proof, pinned.sha256, { ...metadata, release })).toThrow(/attestation verification/);
  }
  expect(() => verifyAttestation(proof, "0".repeat(64), metadata)).toThrow(/attestation verification/);
  expect(() => verifyAttestation(proof, pinned.sha256, { ...metadata, subject: "other.zip" })).toThrow(
    /attestation verification/,
  );
  expect(() => verifyAttestation(proof, pinned.sha256, { ...metadata, release: undefined })).toThrow(
    /attestation verification/,
  );
});

test("detached signatures authenticate both new downloads and cached source bytes", async () => {
  const root = fixture();
  const bytes = file("./fixtures/node-shasums.txt");
  const pinned = {
    url: "https://tools.example/payload",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signature: nodeChecksums().checksums.signature,
  };
  serveCatalog({ catalog: bytes });
  const cached = await download(pinned);
  expect(readFileSync(cached)).toEqual(bytes);
  const fetcher = serveCatalog({ catalog: bytes });
  expect(await download(pinned)).toBe(cached);
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([pinned.signature.url]);
  serveCatalog({ signature: "invalid signature" });
  await expect(download(pinned)).rejects.toThrow(/signature verification/);
  expect(readFileSync(cached)).toEqual(bytes);
  expect(readdirSync(join(root, "cache/downloads"))).toHaveLength(1);
});

test("signature verification remains independent of agent socket path limits", async () => {
  const root = fixture();
  const staging = join(root, "a".repeat(140));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(staging);
  const pinned = nodeChecksums();
  serveCatalog();
  await authenticateChecksums(pinned.checksums, pinned.sha256, staging, AbortSignal.timeout(10000));
});

test("offline proofs retain full signature verification and reject missing or corrupted cached evidence", async () => {
  const root = fixture();
  const pinned = nodeChecksums();
  serveCatalog();
  await authenticateChecksums(pinned.checksums, pinned.sha256, root, AbortSignal.timeout(10000));
  const fetcher = vi.fn(() => {
    throw new Error("network must not be used");
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubEnv("WORKBENCH_OFFLINE", "1");
  await authenticateChecksums(pinned.checksums, pinned.sha256, root, AbortSignal.timeout(10000));
  await expect(
    authenticateChecksums(pinned.checksums, "0".repeat(64), root, AbortSignal.timeout(10000)),
  ).rejects.toThrow(/filename and digest/);
  const signature = join(
    root,
    "cache/authentication",
    createHash("sha256").update(pinned.checksums.signature.url).digest("hex"),
  );
  writeFileSync(signature, "damaged signature");
  await expect(
    authenticateChecksums(pinned.checksums, pinned.sha256, root, AbortSignal.timeout(10000)),
  ).rejects.toThrow(/signature verification/);
  rmSync(signature);
  await expect(
    authenticateChecksums(pinned.checksums, pinned.sha256, root, AbortSignal.timeout(10000)),
  ).rejects.toThrow(/unavailable offline/);
  expect(fetcher).not.toHaveBeenCalled();
});

test("offline attestations retain digest, release, and identity checks without a network request", async () => {
  fixture();
  const pinned = JSON.parse(file("../scripts/native-assets.json"))["cargo-nextest"]["0.9.140"]["linux-x64"];
  const metadata = {
    ...pinned.attestation,
    roots: file("../scripts/keys/sigstore-trusted-root.jsonl").toString("utf8"),
  };
  const fetcher = vi.fn(async () => new Response(file("./fixtures/nextest-release-attestation.json")));
  vi.stubGlobal("fetch", fetcher);
  await authenticateAttestation(metadata, pinned.sha256);
  fetcher.mockReset().mockRejectedValue(new Error("network must not be used"));
  vi.stubEnv("WORKBENCH_OFFLINE", "1");
  await authenticateAttestation(metadata, pinned.sha256);
  await expect(authenticateAttestation(metadata, "0".repeat(64))).rejects.toThrow(/attestation verification/);
  await expect(
    authenticateAttestation({ ...metadata, signer: "https://other.example" }, pinned.sha256),
  ).rejects.toThrow(/attestation verification/);
  expect(fetcher).not.toHaveBeenCalled();
});

test("artifact connections retry transport failures within the shared deadline", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValue(new Response("verified later"));
  vi.stubGlobal("fetch", fetcher);
  const stream = await artifactResponse("https://tools.example/archive");
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe("verified later");
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockReset().mockRejectedValue(new TypeError("offline"));
  await expect(artifactResponse("https://tools.example/archive")).rejects.toThrow(
    /connection failed: https:\/\/tools.example\/archive/,
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockClear();
  await expect(artifactResponse("https://tools.example/archive", AbortSignal.abort())).rejects.toThrow(
    /connection failed/,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("GitHub API authentication follows the API origin and is stripped from redirected asset requests", async () => {
  vi.stubEnv("GH_TOKEN", "fixture-read-only-token");
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://assets.example/attestation" } }),
    )
    .mockResolvedValueOnce(new Response("signed bundle"));
  vi.stubGlobal("fetch", fetcher);
  const stream = await artifactResponse("https://api.github.com/repos/example/project/attestations/sha256:abc");
  for await (const chunk of stream) expect(chunk.toString()).toBe("signed bundle");
  expect(fetcher.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer fixture-read-only-token" });
  expect(fetcher.mock.calls[1][1].headers).toBeUndefined();
  fetcher.mockReset().mockResolvedValue(new Response("public asset"));
  await artifactResponse("https://api.github.com.evil.example/asset");
  expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
});
