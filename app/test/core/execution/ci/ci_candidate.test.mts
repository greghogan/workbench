import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buffer } from "node:stream/consumers";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { expect, test } from "vitest";
import { activateCandidate, readCandidate } from "../../../../../scripts/ci-candidate.mts";
import { bundleCacheFile, bundleInputDigest, saveBundleCache } from "../../../../../scripts/bundle-cache.mts";
import { bundleEntries, bundles } from "../../../../src/core/distribution/bundle-layout.mts";
import { successfulReleaseRun } from "../../../../../scripts/release-contract.mts";
import { checkedCIImage } from "../../../../src/core/execution/ci/ci-images.ts";
import { copyScriptClosure } from "../../../fixtures/script-closure.mjs";

const revision = "a".repeat(40),
  repository = "owner/project";
function releaseRun() {
  return {
    id: 123,
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    event: "push",
    path: ".github/workflows/checks.yml",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_sha: revision,
    run_attempt: 2,
  };
}

test("publication accepts only complete successful main Checks from the selected repository", () => {
  expect(successfulReleaseRun(releaseRun(), repository, "123")).toEqual({ revision, attempt: "2" });
  for (const changed of [
    { id: 124 },
    { status: "in_progress" },
    { conclusion: "failure" },
    { head_branch: "other" },
    { event: "pull_request" },
    { path: ".github/workflows/other.yml" },
    { head_repository: { full_name: "fork/project" } },
    { repository: { full_name: "fork/project" } },
    { head_sha: "main" },
    { run_attempt: 0 },
  ])
    expect(() => successfulReleaseRun({ ...releaseRun(), ...changed }, repository, "123")).toThrow(
      /successful complete Checks/,
    );
});

test("portable candidates reject changed bytes, source identity, version, and checksum records", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-candidate-"));
  try {
    const directory = join(root, "workbench-artifacts");
    mkdirSync(directory);
    const bytes = Buffer.from("exact candidate bytes"),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(directory, "workbench.tar.gz"), bytes);
    writeFileSync(join(directory, "SHA256SUMS"), `${sha256}  workbench.tar.gz\n`);
    const metadata = { version: 1, repository, revision, release: "1.2.3", sha256 };
    const manifest = join(root, "candidate.json");
    writeFileSync(manifest, JSON.stringify(metadata));
    expect(readCandidate(root, repository, revision)).toEqual(metadata);
    for (const changed of [
      { repository: "other/project" },
      { revision: "b".repeat(40) },
      { release: "../1.2" },
      { sha256: "0".repeat(64) },
    ]) {
      writeFileSync(manifest, JSON.stringify({ ...metadata, ...changed }));
      expect(() => readCandidate(root, repository, revision)).toThrow(/source identity or archive digest/);
    }
    writeFileSync(manifest, JSON.stringify(metadata));
    writeFileSync(join(directory, "workbench.tar.gz"), "changed");
    expect(() => readCandidate(root, repository, revision)).toThrow(/source identity or archive digest/);
    writeFileSync(join(directory, "workbench.tar.gz"), bytes);
    writeFileSync(join(directory, "SHA256SUMS"), readFileSync(join(directory, "SHA256SUMS"), "utf8") + "extra\n");
    expect(() => readCandidate(root, repository, revision)).toThrow(/source identity or archive digest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable runtime activation binds intact bundle bytes to the receiving source before copying", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-candidate-runtime-"));
  try {
    const candidate = join(root, "candidate");
    mkdirSync(join(candidate, "workbench-artifacts"), { recursive: true });
    mkdirSync(join(candidate, "bundle"));
    const archive = Buffer.from("verified archive"),
      sha256 = createHash("sha256").update(archive).digest("hex");
    writeFileSync(join(candidate, "workbench-artifacts/workbench.tar.gz"), archive);
    writeFileSync(join(candidate, "workbench-artifacts/SHA256SUMS"), `${sha256}  workbench.tar.gz\n`);
    const outputs = bundleEntries.flatMap((name) => {
      const paths = [`bundle/${name}.cjs`];
      if (bundles[name].compression !== "none") paths.push(`bundle/${name}.cjs.br`);
      return paths.map((path) => ({ path, contents: Buffer.from(path) }));
    });
    outputs.push({ path: "bundle/THIRD_PARTY_NOTICES.txt", contents: Buffer.from("fixture notices") });
    saveBundleCache(root, bundleInputDigest(root), outputs);
    const receipt = readFileSync(join(root, bundleCacheFile));
    writeFileSync(join(candidate, "bundle-build.json"), receipt);
    writeFileSync(
      join(candidate, "candidate.json"),
      JSON.stringify({
        version: 1,
        repository,
        revision,
        release: "1.2.3",
        sha256,
        bundleBuildSha256: createHash("sha256").update(receipt).digest("hex"),
      }),
    );
    for (const file of outputs) writeFileSync(join(candidate, file.path), file.contents);
    rmSync(join(root, "bundle"), { recursive: true });
    const environment = { GITHUB_REPOSITORY: repository, GITHUB_SHA: revision };
    writeFileSync(join(candidate, "bundle/main.cjs"), "damaged");
    expect(() => {
      activateCandidate(candidate, environment, root);
    }).toThrow(/incomplete/);
    expect(existsSync(join(root, "bundle/main.cjs"))).toBe(false);
    writeFileSync(join(candidate, "bundle/main.cjs"), "bundle/main.cjs");
    writeFileSync(join(root, "package.json"), "{}");
    expect(() => {
      activateCandidate(candidate, environment, root);
    }).toThrow(/do not match/);
    expect(existsSync(join(root, "bundle/main.cjs"))).toBe(false);
    rmSync(join(root, "package.json"));
    activateCandidate(candidate, environment, root);
    for (const file of outputs) expect(readFileSync(join(root, file.path))).toEqual(file.contents);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog packaging reuses the same-run candidate from a clean checkout without build dependencies", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-candidate-package-"));
  try {
    const checkout = join(temporary, "checkout");
    const runtime = join(temporary, "runtime");
    const candidate = join(temporary, "candidate");
    const entry = "scripts/package-workbench.mts";
    mkdirSync(checkout);
    await copyScriptClosure(resolve(import.meta.dirname, "../../../../.."), runtime, entry);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "-qm",
      "fixture",
    );
    const packed = tar.pack();
    const contents = buffer(packed);
    packed.entry({ name: "package/workbench-source-manifest.json" }, "{}");
    packed.entry(
      { name: "package/bin/workbench.mjs", mode: 0o755 },
      "import { realpathSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; " +
        "console.log(JSON.stringify({ directory: realpathSync(fileURLToPath(new URL('../', import.meta.url))) }));",
    );
    packed.finalize();
    const bytes = gzipSync(await contents);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(join(candidate, "workbench-artifacts"), { recursive: true });
    writeFileSync(join(candidate, "workbench-artifacts", "workbench.tar.gz"), bytes);
    writeFileSync(join(candidate, "workbench-artifacts", "SHA256SUMS"), `${sha256}  workbench.tar.gz\n`);
    writeFileSync(
      join(candidate, "candidate.json"),
      JSON.stringify({
        version: 1,
        repository,
        revision: git("rev-parse", "HEAD"),
        release: "1.2.3",
        sha256,
      }),
    );
    const packageRelease = (output: string) =>
      spawnSync(process.execPath, [join(runtime, entry), "--archive", output], {
        cwd: checkout,
        env: { ...process.env, WORKBENCH_CI_CANDIDATE: candidate, WORKBENCH_CI_REPOSITORY: repository },
        encoding: "utf8",
      });
    const archive = join(temporary, "release.tar.gz");
    const accepted = packageRelease(archive);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(readFileSync(archive)).toEqual(bytes);
    if (process.platform !== "linux" || spawnSync("bsdtar", ["--version"], { stdio: "ignore" }).status === 0) {
      const zip = join(temporary, "release.zip");
      const archived = packageRelease(zip);
      expect(archived.status, archived.stderr).toBe(0);
      const verifier = join(runtime, "scripts/workbench-release-archive.mjs");
      const checked = spawnSync(process.execPath, [verifier, zip], { cwd: checkout, encoding: "utf8" });
      expect(checked.status, checked.stderr).toBe(0);
      expect(readFileSync(join(candidate, "workbench-artifacts/workbench.tar.gz"))).toEqual(bytes);
    }
    writeFileSync(join(checkout, "uncommitted.md"), "different source");
    const rejected = join(temporary, "invalid.tar.gz");
    expect(packageRelease(rejected).stderr).toContain("clean selected revision");
    expect(existsSync(rejected)).toBe(false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("CI image acquisition binds platform, declared inputs, builder, volumes, and immutable registry identity", () => {
  const expected = {
    profile: "native",
    platform: "linux-x64",
    inputs: "c".repeat(64),
    reference: "ghcr.io/owner/image:inputs",
  } as const;
  const image = {
    Id: `sha256:${"a".repeat(64)}`,
    Os: "linux",
    Architecture: "amd64",
    RepoDigests: [`ghcr.io/owner/image@sha256:${"b".repeat(64)}`],
    Config: { Labels: { "org.workbench.inputs": "c".repeat(64), "org.workbench.builder": "native" } },
  };
  expect(checkedCIImage(image, expected, "native").published).toBe(image.RepoDigests[0]);
  for (const changed of [
    { Os: "windows" },
    { Architecture: "arm64" },
    { Id: "mutable-tag" },
    { Config: { Labels: { ...image.Config.Labels, "org.workbench.inputs": "other" } } },
    { Config: { Labels: { ...image.Config.Labels, "org.workbench.builder": "guix" } } },
    { Config: { ...image.Config, Volumes: { "/data": {} } } },
    { RepoDigests: [] },
  ])
    expect(() => checkedCIImage({ ...image, ...changed }, expected, "native")).toThrow(/CI image|Acquired CI image/);
});
