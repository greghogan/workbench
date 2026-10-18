import { promised } from "./fixtures/promised.mjs";
import { required } from "../src/invariants.ts";
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { authenticateChecksums, signatureVerifier } from "../src/artifact-signatures.ts";
import { authenticateAttestation } from "../src/artifact-attestations.ts";
import { verifyAttestation } from "../src/attestation-verification.ts";
import { artifactResponse } from "../src/artifact-streams.ts";
import type { ToolAsset } from "../src/tool-downloads.ts";
import { download } from "../src/tool-downloads.ts";
import { createHash } from "node:crypto";

const temporary: string[] = [];
const watchdogs: NodeJS.Timeout[] = [];
function verificationSignal() {
  const controller = new AbortController();
  const watchdog = setTimeout(() => {
    controller.abort(new Error("Signature integration watchdog expired"));
  }, 120000);
  watchdog.unref();
  watchdogs.push(watchdog);
  return controller.signal;
}
afterEach(() => {
  for (const watchdog of watchdogs.splice(0)) clearTimeout(watchdog);
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
const file = (path: string | URL) => readFileSync(new URL(path, import.meta.url));
function asset(name: string, version: string) {
  const catalog = JSON.parse(file("./fixtures/authenticated-assets.json").toString("utf8")) as Record<
    string,
    Record<string, Record<string, ToolAsset>>
  >;
  return required(
    required(required(catalog[name], "Tool catalog")[version], "Tool version")["linux-x64"],
    "Tool platform",
  );
}
function signedAsset(name: string, version: string) {
  const pinned = asset(name, version);
  return { ...pinned, checksums: required(pinned.checksums, "Signed checksum policy") };
}
function nodeChecksums() {
  const pinned = signedAsset("node", "24.21.0");
  pinned.checksums.signature.keys = file("../scripts/keys/node.asc").toString("utf8");
  return pinned;
}
function serveCatalog({
  catalog = file("./fixtures/node-shasums.txt"),
  signature = file("./fixtures/node-shasums.sig"),
}: {
  catalog?: ConstructorParameters<typeof Response>[0];
  signature?: ConstructorParameters<typeof Response>[0];
} = {}) {
  const fetcher = vi.fn<typeof globalThis.fetch>((url) =>
    Promise.resolve(new Response(requestURL(url).endsWith(".sig") ? signature : catalog)),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

test("real signed checksum catalogs bind the exact filename, digest, and pinned signer", async () => {
  const root = fixture();
  const pinned = nodeChecksums();
  serveCatalog();
  await authenticateChecksums(pinned.checksums, pinned.sha256, root, verificationSignal());
  await expect(authenticateChecksums(pinned.checksums, "0".repeat(64), root, verificationSignal())).rejects.toThrow(
    /filename and digest/,
  );
  await expect(
    authenticateChecksums(
      { ...pinned.checksums, subject: "different.tar.gz" },
      pinned.sha256,
      root,
      verificationSignal(),
    ),
  ).rejects.toThrow(/filename and digest/);
  await expect(
    authenticateChecksums(
      { ...pinned.checksums, signature: { ...pinned.checksums.signature, signers: ["A".repeat(40)] } },
      pinned.sha256,
      root,
      verificationSignal(),
    ),
  ).rejects.toThrow(/approved fingerprint/);
  const cmake = signedAsset("cmake", "4.4.4");
  cmake.checksums.signature.keys = file("../scripts/keys/cmake.asc").toString("utf8");
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>((url) =>
      Promise.resolve(
        new Response(
          requestURL(url).endsWith(".asc")
            ? file("./fixtures/cmake-shasums.sig")
            : file("./fixtures/cmake-shasums.txt"),
        ),
      ),
    ),
  );
  await authenticateChecksums(cmake.checksums, cmake.sha256, root, verificationSignal());
});

test("failed publisher authentication prevents downloading an artifact and removes private staging", async () => {
  const root = fixture();
  const pinned = nodeChecksums();
  const catalog = file("./fixtures/node-shasums.txt").toString("utf8").replace(pinned.sha256, "0".repeat(64));
  const fetcher = serveCatalog({ catalog });
  await expect(download(pinned)).rejects.toThrow(/signature verification/);
  expect(fetcher.mock.calls.map(([url]) => requestURL(url))).toEqual([
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
  vi.stubGlobal("fetch", () =>
    promised(() => new Response(null, { status: 302, headers: { location: "http://tools.example/proof" } })),
  );
  await expect(download(pinned)).rejects.toThrow(/HTTPS/);
  expect(readdirSync(join(root, "cache/downloads"))).toEqual([]);
});

test("GitHub release attestations bind repository and tag as well as the artifact", () => {
  const pinned = asset("cargo-nextest", "0.9.140");
  const metadata = {
    ...required(pinned.attestation, "Attestation policy"),
    roots: file("../scripts/keys/sigstore-trusted-root.jsonl").toString("utf8"),
  };
  const proof = file("./fixtures/nextest-release-attestation.json").toString("utf8");
  expect(() => {
    verifyAttestation(proof, pinned.sha256, metadata);
  }).not.toThrow();
  for (const release of [
    { ...required(metadata.release, "Release attestation policy"), repository: "other/repository" },
    { ...required(metadata.release, "Release attestation policy"), tag: "other-tag" },
  ]) {
    expect(() => {
      verifyAttestation(proof, pinned.sha256, { ...metadata, release });
    }).toThrow(/attestation verification/);
  }
  expect(() => {
    verifyAttestation(proof, "0".repeat(64), metadata);
  }).toThrow(/attestation verification/);
  expect(() => {
    verifyAttestation(proof, pinned.sha256, { ...metadata, subject: "other.zip" });
  }).toThrow(/attestation verification/);
  expect(() => {
    Reflect.apply(verifyAttestation, undefined, [proof, pinned.sha256, { ...metadata, release: undefined }]);
  }).toThrow(/attestation verification/);
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
  expect(fetcher.mock.calls.map(([url]) => requestURL(url))).toEqual([pinned.signature.url]);
  serveCatalog({ signature: "invalid signature" });
  await expect(download(pinned)).rejects.toThrow(/signature verification/);
  expect(readFileSync(cached)).toEqual(bytes);
  expect(readdirSync(join(root, "cache/downloads"))).toHaveLength(1);
});

test("signature backups retain signer verification and invalid proof bytes do not trigger another source", async () => {
  fixture();
  const bytes = file("./fixtures/node-shasums.txt");
  const signature = nodeChecksums().checksums.signature;
  const pinned = {
    url: "https://tools.example/payload",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signature: { ...signature, url: "https://tools.example/missing.sig", backupUrls: [signature.url] },
  };
  const fetcher = vi.fn<typeof globalThis.fetch>((url) =>
    Promise.resolve(
      requestURL(url) === pinned.signature.url
        ? new Response(null, { status: 404 })
        : new Response(requestURL(url) === signature.url ? file("./fixtures/node-shasums.sig") : bytes),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(readFileSync(await download(pinned))).toEqual(bytes);
    expect(fetcher.mock.calls.map(([url]) => requestURL(url))).toEqual([
      pinned.signature.url,
      signature.url,
      pinned.url,
    ]);
    fetcher.mockReset().mockResolvedValue(new Response("invalid proof"));
    await expect(download(pinned)).rejects.toThrow(/signature verification/);
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
  }
});

test("managed acquisition never uses network backups for a missing declared source", async () => {
  const root = fixture();
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schema_version: 1, source_hashes: {}, inputs: [] }));
  vi.stubEnv("WORKBENCH_CHECK_INPUTS", root);
  const fetcher = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    artifactResponse("https://tools.example/missing", undefined, ["https://backup.example/missing"]),
  ).rejects.toThrow(/Missing or ambiguous declared managed source/);
  expect(fetcher).not.toHaveBeenCalled();
});

test("signature verification remains independent of agent socket path limits", async () => {
  const root = fixture();
  const staging = join(root, "a".repeat(140));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(staging);
  const pinned = nodeChecksums();
  serveCatalog();
  await authenticateChecksums(pinned.checksums, pinned.sha256, staging, verificationSignal());
});

test("offline proofs retain full signature verification and reject missing or corrupted cached evidence", async () => {
  const root = fixture();
  const pinned = nodeChecksums();
  serveCatalog();
  await authenticateChecksums(pinned.checksums, pinned.sha256, root, verificationSignal());
  const fetcher = vi.fn<typeof globalThis.fetch>(() => {
    throw new Error("network must not be used");
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubEnv("WORKBENCH_OFFLINE", "1");
  await authenticateChecksums(pinned.checksums, pinned.sha256, root, verificationSignal());
  await expect(authenticateChecksums(pinned.checksums, "0".repeat(64), root, verificationSignal())).rejects.toThrow(
    /filename and digest/,
  );
  const signature = join(
    root,
    "cache/authentication",
    createHash("sha256").update(pinned.checksums.signature.url).digest("hex"),
  );
  writeFileSync(signature, "damaged signature");
  await expect(authenticateChecksums(pinned.checksums, pinned.sha256, root, verificationSignal())).rejects.toThrow(
    /signature verification/,
  );
  rmSync(signature);
  await expect(authenticateChecksums(pinned.checksums, pinned.sha256, root, verificationSignal())).rejects.toThrow(
    /unavailable offline/,
  );
  expect(fetcher).not.toHaveBeenCalled();
});

test("offline attestations retain digest, release, and identity checks without a network request", async () => {
  fixture();
  const pinned = asset("cargo-nextest", "0.9.140");
  const metadata = {
    ...required(pinned.attestation, "Attestation policy"),
    roots: file("../scripts/keys/sigstore-trusted-root.jsonl").toString("utf8"),
  };
  const fetcher = vi.fn<typeof globalThis.fetch>(() =>
    promised(() => new Response(file("./fixtures/nextest-release-attestation.json"))),
  );
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
    .fn<typeof globalThis.fetch>()
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

test("transport exhaustion selects a backup without forwarding API credentials or URL query secrets", async () => {
  vi.stubEnv("GH_TOKEN", "fixture-token");
  const fetcher = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(new Response("verified"));
  vi.stubGlobal("fetch", fetcher);
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const stream = await artifactResponse("https://api.github.com/asset?secret=private", undefined, [
      "https://backup.example/asset?secret=private",
    ]);
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Expected downloaded bytes");
      expect(chunk.toString()).toBe("verified");
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(
      required(
        required(fetcher.mock.calls[0], "Expected fixture value: fetcher.mock.calls[0]")[1],
        'Fixture value required(fetcher.mock.calls[0], "Expected fixture value: fetcher.mock.',
      ).headers,
    ).toEqual({ Authorization: "Bearer fixture-token" });
    expect(
      required(
        required(fetcher.mock.calls[3], "Expected fixture value: fetcher.mock.calls[3]")[1],
        'Fixture value required(fetcher.mock.calls[3], "Expected fixture value: fetcher.mock.',
      ).headers,
    ).toBeUndefined();
    expect(log.mock.calls.flat().join(" ")).not.toContain("private");
  } finally {
    log.mockRestore();
  }
});

test("backup failures retain all endpoint causes and an aborted request never tries the next source", async () => {
  const fetcher = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() => Promise.resolve(new Response("missing", { status: 404 })));
  vi.stubGlobal("fetch", fetcher);
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await expect(
      artifactResponse("https://first.example/file", undefined, ["https://second.example/file"]),
    ).rejects.toThrow(/All declared artifact sources failed:.*first.example.*second.example/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockClear();
    await expect(
      artifactResponse("https://first.example/file", AbortSignal.abort(), ["https://second.example/file"]),
    ).rejects.toThrow(/404/);
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
  }
});

test("GitHub API authentication follows the API origin and is stripped from redirected asset requests", async () => {
  vi.stubEnv("GH_TOKEN", "fixture-read-only-token");
  const fetcher = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://assets.example/attestation" } }),
    )
    .mockResolvedValueOnce(new Response("signed bundle"));
  vi.stubGlobal("fetch", fetcher);
  const stream = await artifactResponse("https://api.github.com/repos/example/project/attestations/sha256:abc");
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Expected streamed bytes");
    expect(chunk.toString()).toBe("signed bundle");
  }
  expect(
    required(
      required(fetcher.mock.calls[0], "Expected fixture value: fetcher.mock.calls[0]")[1],
      'Fixture value required(fetcher.mock.calls[0], "Expected fixture value: fetcher.mock.',
    ).headers,
  ).toEqual({ Authorization: "Bearer fixture-read-only-token" });
  expect(
    required(
      required(fetcher.mock.calls[1], "Expected fixture value: fetcher.mock.calls[1]")[1],
      'Fixture value required(fetcher.mock.calls[1], "Expected fixture value: fetcher.mock.',
    ).headers,
  ).toBeUndefined();
  fetcher.mockReset().mockResolvedValue(new Response("public asset"));
  await artifactResponse("https://api.github.com.evil.example/asset");
  expect(
    required(
      required(fetcher.mock.calls[0], "Expected fixture value: fetcher.mock.calls[0]")[1],
      'Fixture value required(fetcher.mock.calls[0], "Expected fixture value: fetcher.mock.',
    ).headers,
  ).toBeUndefined();
});

test("signature cancellation is requested after verifier startup and drains the child", async () => {
  const root = fixture();
  const pinned = nodeChecksums();
  serveCatalog();
  const controller = new AbortController();
  const verifier = await signatureVerifier(
    pinned.checksums.signature,
    root,
    AbortSignal.any([controller.signal, verificationSignal()]),
  );
  try {
    controller.abort();
    await expect(verifier.finish()).rejects.toThrow(/cancelled/);
  } finally {
    await verifier.cancel();
  }
});

function requestURL(value: Parameters<typeof globalThis.fetch>[0]): string {
  return typeof value === "string" ? value : value instanceof URL ? value.href : value.url;
}
