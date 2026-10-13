import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { authenticateRepository } from "../src/artifact-repositories.ts";
import { authenticateCatalog } from "../src/artifact-signatures.ts";

vi.mock("../src/artifact-signatures.ts", async (original) => ({ ...(await original()), authenticateCatalog: vi.fn() }));
const temporary = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(authenticateCatalog).mockReset();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-repository-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_CACHE_HOME", root);
  return root;
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test.skipIf(process.platform !== "linux")(
  "authenticated repository indices bind the exact package version, architecture, URL, and digest",
  async () => {
    const root = fixture();
    const artifact = { url: "https://archive.example/ubuntu/pool/icu.deb", sha256: hash("package bytes") };
    const packages = `Package: libicu70\nVersion: 70.1-2\nArchitecture: amd64\nFilename: pool/icu.deb\nSHA256: ${artifact.sha256}\n\n`;
    const bytes = execFileSync("xz", ["--compress", "--stdout"], { input: packages });
    const repository = {
      url: "https://archive.example/ubuntu/dists/jammy/Release",
      signature: { url: "https://archive.example/Release.gpg", keys: "fixture", signers: ["A".repeat(40)] },
      index: "main/binary-amd64/Packages.xz",
      indexSha256: hash(bytes),
      package: "libicu70",
      version: "70.1-2",
      architecture: "amd64",
    };
    const release = Buffer.from(`SHA256:\n ${repository.indexSha256} ${bytes.length} ${repository.index}\n`);
    vi.mocked(authenticateCatalog).mockResolvedValue(release);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes)),
    );
    await authenticateRepository(repository, artifact, root, AbortSignal.timeout(10000));
    for (const changed of [
      { ...repository, version: "other" },
      { ...repository, architecture: "arm64" },
      { ...repository, package: "other" },
    ]) {
      await expect(authenticateRepository(changed, artifact, root, AbortSignal.timeout(10000))).rejects.toThrow(
        /expected package/,
      );
    }
    await expect(
      authenticateRepository(
        repository,
        { ...artifact, url: "https://other.example/icu.deb" },
        root,
        AbortSignal.timeout(10000),
      ),
    ).rejects.toThrow(/expected package/);
    await expect(
      authenticateRepository(repository, { ...artifact, sha256: hash("wrong") }, root, AbortSignal.timeout(10000)),
    ).rejects.toThrow(/expected package/);
    vi.mocked(authenticateCatalog).mockResolvedValue(
      Buffer.from(`SHA256:\n ${"0".repeat(64)} ${bytes.length} ${repository.index}\n`),
    );
    await expect(authenticateRepository(repository, artifact, root, AbortSignal.timeout(10000))).rejects.toThrow(
      /pinned package index/,
    );
    vi.mocked(authenticateCatalog).mockRejectedValue(new Error("signature failed"));
    await expect(authenticateRepository(repository, artifact, root, AbortSignal.timeout(10000))).rejects.toThrow(
      "signature failed",
    );
    expect(readdirSync(join(root, "downloads"))).toHaveLength(1);
  },
);
