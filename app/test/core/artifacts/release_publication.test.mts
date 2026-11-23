import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { GitHubRelease, publishGitHubFiles } from "../../../src/core/artifacts/github-release.mts";
import { parseRelease } from "../../../src/core/records/releases.ts";
import { required } from "../../../src/core/runtime/values.mjs";

function releaseHost(root: string): NodeJS.ProcessEnv {
  const fixture = join(root, "fixture");
  const commands = join(root, "bin");
  mkdirSync(fixture);
  mkdirSync(commands);
  cpSync(resolve(import.meta.dirname, "../../fixtures/release-gh.mjs"), join(commands, "gh"));
  chmodSync(join(commands, "gh"), 0o755);
  return {
    ...process.env,
    PATH: commands + delimiter + (process.env.PATH ?? ""),
    RELEASE_FIXTURE: fixture,
  };
}

test.skipIf(process.platform === "win32")(
  "release promotion preserves the exact tested bytes, is repeatable, and rejects changed published assets",
  () => {
    const root = mkdtempSync(join(tmpdir(), "workbench-release-promotion-"));
    try {
      const repository = "owner/project";
      const source = join(root, "source");
      mkdirSync(source);
      mkdirSync(join(source, "workbench"));
      writeFileSync(join(source, "workbench/projects.toml"), '[[project]]\nid="workbench-app"\npath="."\n');
      writeFileSync(
        join(source, "workbench/config.toml"),
        "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
      );
      const release = "1.2.3";
      writeFileSync(join(source, "package.json"), JSON.stringify({ version: release }));
      const git = (...args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8" });
      git("init", "--quiet");
      git("add", "package.json");
      git(
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      );
      const revision = git("rev-parse", "HEAD").trim();
      const host = releaseHost(root);
      const fixture = join(root, "fixture");
      const artifact = "workbench-candidate-123-1",
        candidate = join(fixture, artifact);
      const bytes = Buffer.from("exact tested archive; this content is never executed");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      mkdirSync(join(candidate, "workbench-artifacts"), { recursive: true });
      writeFileSync(join(candidate, "workbench-artifacts/workbench.tar.gz"), bytes);
      writeFileSync(join(candidate, "workbench-artifacts/SHA256SUMS"), `${sha256}  workbench.tar.gz\n`);
      const metadata = { version: 1, repository, revision, release, sha256 };
      writeFileSync(join(candidate, "candidate.json"), JSON.stringify(metadata));
      const proof = join(fixture, "release-ready-123-2");
      mkdirSync(proof);
      const writePackage = (target: string, bytes: Buffer) => {
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const recipe = "a".repeat(64);
        const manifest = JSON.stringify({
          version: 1,
          revision,
          file: "artifact.zip",
          recipe,
          sha256,
          bytes: bytes.length,
          verification: { platform: target, revision, sha256 },
        });
        const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
        const directory = `artifact-${manifestSha256}`;
        const artifactName = `release-packages-workbench-app.${target}.native-${artifact}`;
        const packages = join(fixture, artifactName);
        const source = join(packages, directory, "artifact.zip");
        mkdirSync(join(packages, directory), { recursive: true });
        writeFileSync(source, bytes);
        writeFileSync(join(packages, directory, "workbench-artifact.json"), manifest);
        writeFileSync(
          join(packages, "packages.json"),
          JSON.stringify({
            version: 1,
            revision,
            packages: [
              {
                id: `native.${target}.archive.workbench-release`,
                status: "verified",
                recipe,
                directory,
                manifestSha256,
                sha256,
              },
            ],
          }),
        );
        return { target, source, artifactName, file: `workbench-${target}.zip`, bytes, sha256 };
      };
      const zips = ["macos-arm64", "windows-x64"].map((target) =>
        writePackage(target, Buffer.from(`${target} archive from the native package job`)),
      );
      mkdirSync(join(proof, "release-packages"));
      for (const zip of zips)
        cpSync(join(fixture, zip.artifactName), join(proof, "release-packages", zip.artifactName), { recursive: true });
      const recorded = spawnSync(
        process.execPath,
        [resolve(import.meta.dirname, "../../../../scripts/ci-release-ready.mts")],
        {
          cwd: source,
          encoding: "utf8",
          env: {
            ...host,
            RUNNER_TEMP: proof,
            GITHUB_REPOSITORY: repository,
            GITHUB_SHA: revision,
            WORKBENCH_CI_CANDIDATE: candidate,
            CANDIDATE_ARTIFACT: artifact,
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "2",
          },
        },
      );
      expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
      writeFileSync(
        join(fixture, "run.json"),
        JSON.stringify({
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
        }),
      );
      const env = {
        ...host,
        RUNNER_TEMP: root,
        WORKBENCH_EPHEMERAL_CHECKOUT: "1",
        WORKBENCH_PROJECT_ROOT: source,
        WORKBENCH_STATE_HOME: join(root, "state"),
        WORKBENCH_DATA_HOME: join(root, "data"),
        WORKBENCH_CONFIG_HOME: join(root, "config"),
        GITHUB_REF: "refs/heads/main",
        GITHUB_REPOSITORY: repository,
      };
      const registration = spawnSync(
        process.execPath,
        [resolve(import.meta.dirname, "../../../../bin/workbench.mjs"), "project", "add", "."],
        { cwd: source, env, encoding: "utf8" },
      );
      expect(registration.status, registration.stdout + registration.stderr).toBe(0);
      const run = (...args: string[]) =>
        spawnSync(
          process.execPath,
          [resolve(import.meta.dirname, "../../../../scripts/publish-release.mts"), ...args],
          {
            cwd: source,
            env,
            encoding: "utf8",
          },
        );
      const windows = required(
        zips.find(({ target }) => target === "windows-x64"),
        "Windows package fixture",
      );
      writeFileSync(windows.source, "changed CI package bytes");
      const mismatched = run("123", join(root, "mismatched-package-publication"));
      expect(mismatched.status).not.toBe(0);
      expect(mismatched.stderr).toContain("windows-x64: release package differs from the verified bytes or source");
      expect(existsSync(join(fixture, "state.json"))).toBe(false);
      writePackage("windows-x64", Buffer.from("replacement verified by another attempt"));
      const replaced = run("123", join(root, "replaced-package-publication"));
      expect(replaced.status).not.toBe(0);
      expect(replaced.stderr).toContain("windows-x64: release package differs from the successful Checks run proof");
      expect(existsSync(join(fixture, "state.json"))).toBe(false);
      writePackage("windows-x64", windows.bytes);
      writeFileSync(join(fixture, "outages.json"), JSON.stringify({ metadata: 1, download: 1 }));
      const first = run("123", join(root, "published"));
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(readFileSync(join(fixture, "assets/workbench.tar.gz"))).toEqual(bytes);
      for (const zip of zips) expect(readFileSync(join(fixture, "assets", zip.file))).toEqual(zip.bytes);
      const state = () => JSON.parse(readFileSync(join(fixture, "state.json"), "utf8")) as { draft: boolean };
      expect(state().draft).toBe(false);
      const retry = run("123", join(root, "retried-publication"));
      expect(retry.status, retry.stdout + retry.stderr).toBe(0);
      const record = run("record", join(root, "published"), join(root, "record"));
      expect(record.status, record.stdout + record.stderr).toBe(0);
      const releases = "workbench/releases";
      const recordFiles = readdirSync(join(root, "record", releases));
      expect(recordFiles).toHaveLength(1);
      const filename = required(recordFiles[0], "Missing retained release record");
      const path = join(root, "record", releases, filename);
      expect(parseRelease(readFileSync(path, "utf8"), path)).toMatchObject({
        id: "workbench-app-REL-0",
        tag: "v1.2.3",
        revision,
        released: "2026-10-01",
        artifacts: [
          {
            target: "portable-node",
            file: "workbench.tar.gz",
            url: "https://github.com/owner/project/releases/download/v1.2.3/workbench.tar.gz",
            sha256,
            bytes: bytes.length,
          },
          { target: "checksums", file: "SHA256SUMS" },
          ...zips.map(({ target, file, bytes, sha256 }) => ({
            target,
            file,
            bytes: bytes.length,
            sha256,
            url: `https://github.com/owner/project/releases/download/v1.2.3/${file}`,
          })),
        ],
      });
      const recordRetry = run("record", join(root, "retried-publication"), join(root, "retried-record"));
      expect(recordRetry.status, recordRetry.stdout + recordRetry.stderr).toBe(0);
      expect(readdirSync(join(root, "retried-record", releases))).toEqual(recordFiles);
      expect(readFileSync(join(root, "retried-record", releases, filename))).toEqual(readFileSync(path));
      const events = readFileSync(join(fixture, "events"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(events.filter((args) => args[0] === "release" && args[1] === "upload")).toHaveLength(4);
      expect(events.filter((args) => args[0] === "release" && args[1] === "create")).toHaveLength(1);
      // A partial owned draft resumes only its missing asset, then verifies and publishes the same bytes.
      const draft = JSON.parse(readFileSync(join(fixture, "state.json"), "utf8")) as {
        draft: boolean;
        assets: { name: string }[];
      };
      draft.draft = true;
      draft.assets = draft.assets.filter((asset) => asset.name !== "SHA256SUMS");
      rmSync(join(fixture, "assets/SHA256SUMS"));
      writeFileSync(join(fixture, "state.json"), JSON.stringify(draft));
      const resumed = run("123", join(root, "resumed-publication"));
      expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
      expect(state().draft).toBe(false);
      expect(readFileSync(join(fixture, "assets/workbench.tar.gz"))).toEqual(bytes);
      writeFileSync(join(fixture, "assets/workbench.tar.gz"), "changed published asset");
      const rejected = run("123", join(root, "rejected-publication"));
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("Published workbench.tar.gz differs from the tested");
      expect(readFileSync(join(fixture, "assets/workbench.tar.gz"), "utf8")).toBe("changed published asset");
      expect(state().draft).toBe(false);
      expect(existsSync(join(root, "rejected-publication"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "GitHub verifies the exact asset filenames selected by a project’s artifact recipes",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "workbench-project-release-"));
    try {
      const github = new GitHubRelease("owner/project", releaseHost(root), new AbortController().signal);
      const names = ["demo-linux-x64-archive.tar.gz", "demo-windows-x64-archive.zip"];
      const files = names.map((name) => {
        const path = join(root, name);
        writeFileSync(path, name);
        return path;
      });
      await publishGitHubFiles(github, "v1.2.3", "a".repeat(40), "Release 1.2.3", files, root);
      expect(await github.release("v1.2.3")).toMatchObject({
        draft: false,
        assets: names.map((name) => ({ name })),
      });
      for (const name of names) expect(readFileSync(join(root, "published-verification", name), "utf8")).toBe(name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
