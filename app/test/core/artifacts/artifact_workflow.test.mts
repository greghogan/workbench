import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "smol-toml";
import { Command } from "commander";
import { registerArtifactCommands } from "../../../src/cli/artifacts.ts";
import * as artifactCatalog from "../../../src/core/artifacts/artifact-catalog.ts";
import {
  artifactHost,
  artifactPlan,
  decodeArtifactCatalog,
  type ArtifactPlanEntry,
} from "../../../src/core/artifacts/artifact-catalog.ts";
import {
  buildFileArtifact,
  exportFileArtifact,
  importFileArtifact,
  inspectFileArtifact,
  inspectFileArtifactStates,
  verifyFileArtifact,
} from "../../../src/core/artifacts/artifact-files.ts";
import { webFixture } from "../../fixtures/web.mjs";
import { distribution, git } from "../../fixtures/adoption.mjs";
import { required } from "../../../src/core/runtime/invariants.ts";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { acquireManagedArtifactInputs } from "../../../src/core/artifacts/managed-artifact-inputs.ts";
import { publishArtifactFiles } from "../../../src/core/artifacts/artifact-release.ts";
import { publishGitHubFiles } from "../../../src/core/artifacts/github-release.mts";
import { parseRelease } from "../../../src/core/records/releases.ts";
import { packageCIRelease, publishCIRelease } from "../../../src/core/execution/ci/ci-release.ts";
import { plannedCIPackages, verifyCIPackages } from "../../../src/core/execution/ci/ci-packages.ts";
import { editArtifactProfile } from "../../../src/core/artifacts/artifact-profile-edits.ts";
import { restoreNativeArchive, writeNativeArchive } from "../../../src/core/artifacts/native-archive.ts";
import { withCacheLock } from "../../../src/core/storage/cache-lock.ts";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { waitForCondition } from "../../fixtures/coordination.mjs";
import tar from "tar-stream";

const scratch: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("managed toolchain dependencies are separately restored from their platform-filtered integrity declarations", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-managed-artifact-test-"));
  scratch.push(root);
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("WORKBENCH_CHECK_INPUTS", undefined);
  const input = "locked bytes";
  const hash = "sha512-" + createHash("sha512").update(input).digest("base64");
  writeFileSync(
    join(root, "managed-check-inputs.json"),
    JSON.stringify({
      schema_version: 1,
      source_hashes: {},
      inputs: [
        { url: "https://packages.example.test/input", destination: "npm/input", hash },
        { url: "https://packages.example.test/foreign", destination: "npm/foreign", hash, platforms: ["linux-arm64"] },
      ],
    }),
  );
  const fetch = vi.fn().mockResolvedValueOnce(new Response("changed bytes")).mockResolvedValueOnce(new Response(input));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await expect(acquireManagedArtifactInputs(root, "linux-x64", 2, signal)).rejects.toThrow(/integrity/);
  const installed = required(
    await acquireManagedArtifactInputs(root, "linux-x64", 2, signal),
    "managed inputs directory",
  );
  expect(readFileSync(join(installed, "npm/input"), "utf8")).toBe(input);
  expect(await acquireManagedArtifactInputs(root, "linux-x64", 2, signal)).toBe(installed);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every(([url]) => String(url).endsWith("/input"))).toBe(true);
});

test("GitHub publication preserves drafts when downloaded bytes differ from the reviewed output", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-artifact-publication-"));
  scratch.push(root);
  const file = join(root, "verified.tar.gz");
  writeFileSync(file, "reviewed");
  let different = true;
  const publish = vi.fn().mockResolvedValue(undefined);
  const release = {
    release: vi.fn().mockResolvedValue(undefined),
    verifyTag: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    upload: vi.fn().mockResolvedValue(undefined),
    download: vi.fn((_tag: string, directory: string) => {
      mkdirSync(directory);
      if (different) writeFileSync(join(directory, "verified.tar.gz"), "altered");
      else copyFileSync(file, join(directory, "verified.tar.gz"));
      return Promise.resolve();
    }),
    publish,
  };
  await expect(publishGitHubFiles(release, "v1.0.0", "source", "Marker", [file], root)).rejects.toThrow(/differs/);
  expect(publish).not.toHaveBeenCalled();
  release.release.mockResolvedValue({
    draft: true,
    body: "Marker",
    target_commitish: "source",
    assets: [{ name: "verified.tar.gz" }],
  });
  rmSync(join(root, "draft-verification"), { recursive: true });
  different = false;
  await publishGitHubFiles(release, "v1.0.0", "source", "Marker", [file], root);
  expect(release.upload).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledOnce();
});

test("GitLab publishes authenticated imports and distinct profile builds in one exact tagged release", async () => {
  const root = webFixture();
  const storage = mkdtempSync(join(tmpdir(), "workbench-artifact-gitlab-"));
  scratch.push(root, storage);
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", storage);
  vi.stubEnv("WORKBENCH_CACHE_HOME", storage);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  vi.stubEnv("GITLAB_TOKEN", "test-token");
  writeFileSync(join(root, "fixture.txt"), "payload");
  git(root, "add", "fixture.txt");
  git(root, "commit", "-qm", "Add release source");
  const tag = "v1.0.0";
  git(root, "tag", tag);
  const revision = git(root, "rev-parse", "HEAD").trim();
  const host = artifactHost();
  const config = configuration(host);
  config.targets.linux.platform = host === "linux-arm64" ? "linux-x64" : "linux-arm64";
  const catalog = decodeArtifactCatalog(
    {
      ...config,
      recipes: { ...config.recipes, alternate: config.recipes.sample },
      profiles: {
        ...config.profiles,
        alternate: {
          ...config.profiles.standard,
          variants: [{ target: "workstation", kind: "release", recipe: "alternate", formats: ["archive"] }],
        },
      },
    },
    new Set(["demo"]),
  );
  const rows = artifactPlan(catalog, { profiles: ["standard", "alternate"], kinds: ["release"], allTargets: true });
  const row = required(
    rows.find(({ target }) => target === "workstation"),
    "Fixture release",
  );
  const other = required(
    rows.find(({ target }) => target === "linux"),
    "Fixture second target",
  );
  const candidate = await buildFileArtifact(root, row, undefined, true);
  const transfer = await exportFileArtifact(candidate, storage, true);
  const otherHost = vi.spyOn(artifactCatalog, "artifactHost").mockReturnValue(other.platform);
  const targetBuilt = await buildFileArtifact(root, other).finally(() => {
    otherHost.mockRestore();
  });
  const targetExport = await exportFileArtifact(targetBuilt, storage);
  expect(targetBuilt.manifest.sha256).toBe(candidate.manifest.sha256);
  expect(targetExport.directory).not.toBe(transfer.directory);
  const receiver = join(storage, "receiver");
  mkdirSync(receiver);
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", receiver);
  const receiveTarget = () =>
    importFileArtifact(root, other, targetExport.directory, targetExport.manifestSha256, { verifiedOnTarget: true });
  await expect(importFileArtifact(root, other, targetExport.directory, targetExport.manifestSha256)).rejects.toThrow(
    /requires a .* builder or verifier/,
  );
  const localChange = join(root, "receiver-changes.txt");
  writeFileSync(localChange, "uncommitted receiver changes");
  await expect(receiveTarget()).rejects.toThrow(/exact clean source revision/);
  const imported = await importFileArtifact(root, row, transfer.directory, transfer.manifestSha256);
  expect(imported.manifest.verification?.revision).toBeNull();
  rmSync(localChange);
  await expect(
    importFileArtifact(root, row, transfer.directory, transfer.manifestSha256, { verifiedOnTarget: true }),
  ).rejects.toThrow(/requires target verification/);
  const remote = await receiveTarget();
  expect(remote.manifest.verification).toMatchObject({ source: "transfer", revision, platform: other.platform });
  expect(inspectFileArtifact(root, row)?.generation).toBe(imported.generation);
  const alternate = await buildFileArtifact(
    root,
    required(
      rows.find(({ profile }) => profile === "alternate"),
      "Alternate release on the same target",
    ),
  );

  const destination = { kind: "gitlab" as const, host: "https://gitlab.example.test", project: "team/demo" };
  const bytes = new Map<string, string>();
  let release: unknown;
  let tagReads = 0;
  const fetch = vi.fn(async (url: string | URL, options?: RequestInit): Promise<Response> => {
    const request = new URL(url);
    if (request.pathname.includes("/repository/tags/")) {
      if (++tagReads === 1) return new Response(null, { status: 503 });
      return Response.json({ commit: { id: revision } });
    }
    if (request.pathname.includes("/packages/generic/")) {
      if (options?.method === "PUT") {
        if (!(options.body instanceof Blob)) throw new Error("Expected streamed artifact");
        bytes.set(request.pathname, await options.body.text());
        return new Response(null, { status: 201 });
      }
      const content = bytes.get(request.pathname);
      return content === undefined ? new Response(null, { status: 404 }) : new Response(content);
    }
    if (options?.method === "POST") {
      if (typeof options.body !== "string") throw new Error("Expected release declaration");
      release = JSON.parse(options.body) as unknown;
      return new Response(null, { status: 201 });
    }
    return release ? Response.json(release) : new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  await expect(publishArtifactFiles(root, [row], { destination, tag })).rejects.toThrow(
    /verify this artifact.*reviewed source/,
  );
  const selection = { destination, tag, generations: [imported.generation, remote.generation, alternate.generation] };
  await expect(publishArtifactFiles(root, rows, selection)).rejects.toThrow(/verify this artifact.*reviewed source/);
  await expect(publishArtifactFiles(root, [row], selection)).rejects.toThrow(
    /does not match a selected release recipe/,
  );
  expect(fetch).not.toHaveBeenCalled();
  const verified = await verifyFileArtifact(root, row, undefined, imported.generation);
  expect(verified.manifest.verification?.revision).toBe(revision);
  const run = (recordRelease = false) => publishArtifactFiles(root, rows, { ...selection, recordRelease });
  const first = await run();
  expect(tagReads).toBe(2);
  expect(first.artifacts.map(({ target }) => target)).toEqual([
    "standard.workstation.archive",
    "standard.linux.archive",
    "alternate.workstation.archive",
  ]);
  expect(first.artifacts.every(({ sha256 }) => sha256 === verified.manifest.sha256)).toBe(true);
  const changed = required(
    [...bytes.keys()].find((key) => key.includes("/standard.workstation.archive.")),
    "Published package",
  );
  bytes.set(changed, "tampered");
  await expect(run()).rejects.toThrow(/differs|larger/);
  bytes.set(changed, "payload");
  const recorded = await run(true);
  expect(recorded.artifacts).toEqual(first.artifacts);
  const path = required(recorded.release, "Written release record");
  expect(parseRelease(readFileSync(path, "utf8"), path)).toMatchObject({
    tag,
    revision,
    artifacts: first.artifacts.map(({ sha256, url, bytes: size }) => ({ sha256, url, bytes: size })),
  });
  expect(fetch.mock.calls.filter(([, options]) => options?.method !== "GET")).toHaveLength(4);
});

function configuration(platform: string) {
  return {
    schema_version: 1,
    targets: { workstation: { platform }, linux: { platform: "linux-arm64", abi: "gnu" } },
    recipes: {
      sample: {
        owner: "demo",
        inputs: ["fixture.txt"],
        build: [
          "{node}",
          "-e",
          "require('node:fs').copyFileSync(process.argv[1],process.argv[2])",
          "{source}/fixture.txt",
          "{artifact}",
        ],
        verify: [
          "{node}",
          "-e",
          "const fs=require('node:fs');if(process.cwd()===process.argv[2]||fs.readFileSync(process.argv[1],'utf8')!=='payload')process.exit(3)",
          "{artifact}",
          "{source}",
        ],
      },
    },
    profiles: {
      standard: {
        builder: "native",
        projects: ["demo"],
        variants: [
          { target: "workstation", kind: "release", recipe: "sample", formats: ["archive"] },
          { target: "workstation", kind: "development", recipe: "sample", formats: ["archive"] },
          { target: "linux", kind: "release", recipe: "sample", formats: ["archive"] },
        ],
      },
    },
  };
}

test("build and publish checks the tagged source before building and retains the verified output on delivery failure", async () => {
  const root = webFixture();
  const storage = mkdtempSync(join(tmpdir(), "workbench-build-publication-"));
  scratch.push(root, storage);
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", storage);
  vi.stubEnv("WORKBENCH_CACHE_HOME", storage);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  vi.stubEnv("GITLAB_TOKEN", "test-token");
  const config = {
    ...configuration(artifactHost()),
    destinations: { hosted: { kind: "gitlab", host: "https://gitlab.example.test", project: "team/demo" } },
  };
  writeFileSync(join(root, "workbench/profiles.toml"), stringify(config));
  writeFileSync(join(root, "fixture.txt"), "payload");
  git(root, "add", "fixture.txt", "workbench/profiles.toml");
  git(root, "commit", "-qm", "Declare release artifacts");
  const tag = "v1.0.0";
  const [row] = artifactPlan(artifactCatalog.readArtifactCatalog(root), {
    profiles: ["standard"],
    kinds: ["release"],
    target: "workstation",
    tag,
  });
  const release = required(row, "Fixture release");
  const fetch = vi.fn().mockResolvedValue(Response.json({ commit: { id: "f".repeat(40) } }));
  vi.stubGlobal("fetch", fetch);
  const run = () => {
    const program = new Command();
    program.command("release");
    registerArtifactCommands(program, root);
    return program.parseAsync(
      [
        "artifact",
        "build",
        "standard",
        "--kind",
        "release",
        "--target",
        "workstation",
        "--publish",
        "hosted",
        "--tag",
        tag,
      ],
      { from: "user" },
    );
  };
  await expect(run()).rejects.toThrow(/Check out the reviewed version tag/);
  expect(inspectFileArtifact(root, release)).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  git(root, "tag", tag);
  const revision = git(root, "rev-parse", "HEAD").trim();
  await expect(run()).rejects.toThrow("1 artifact operations failed");
  expect(fetch).toHaveBeenCalledOnce();
  expect(inspectFileArtifact(root, release)?.manifest.verification).toMatchObject({ revision });
});

test.skipIf(process.platform === "win32")(
  "interrupting a build batch preserves its completed output and stops admission",
  async () => {
    const root = webFixture();
    const storage = mkdtempSync(join(tmpdir(), "workbench-artifact-interruption-"));
    const marker = join(storage, "active-build");
    scratch.push(root, storage);
    const catalog = configuration(artifactHost());
    const profile = catalog.profiles.standard;
    const active = {
      ...catalog.recipes.sample,
      build: [
        "{node}",
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'started');setTimeout(() => process.exit(1), 60_000)",
        marker,
      ],
    };
    writeFileSync(join(root, "fixture.txt"), "payload");
    writeFileSync(
      join(root, "workbench/profiles.toml"),
      stringify({
        ...catalog,
        recipes: { ...catalog.recipes, active },
        profiles: {
          ...catalog.profiles,
          active: {
            ...profile,
            variants: [{ target: "workstation", kind: "release", recipe: "active", formats: ["archive"] }],
          },
          queued: profile,
        },
      }),
    );
    const entry = join(distribution, "bin/workbench.mjs");
    const env = {
      ...process.env,
      WORKBENCH_PROJECT_ROOT: root,
      WORKBENCH_EPHEMERAL_CHECKOUT: "1",
      WORKBENCH_CACHE_HOME: join(storage, "cache"),
      WORKBENCH_STORAGE_ROOT: join(storage, "builds"),
      WORKBENCH_CONFIG_HOME: join(storage, "config"),
      WORKBENCH_DATA_HOME: join(storage, "data"),
      WORKBENCH_STATE_HOME: join(storage, "state"),
    };
    const registered = spawnSync(process.execPath, [entry, "project", "add", "."], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    expect(registered.status, registered.stderr).toBe(0);
    const child = spawn(
      process.execPath,
      [entry, "artifact", "build", "standard", "active", "queued", "--kind", "release", "--json"],
      {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      errors += chunk;
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject).once("close", resolve);
    });
    try {
      await waitForCondition(() => existsSync(marker), closed, "active artifact recipe", AbortSignal.timeout(30_000));
      child.kill("SIGINT");
      expect(await closed, errors).toBe(130);
      const results = JSON.parse(output) as { profile: string; status?: string; artifact?: { directory: string } }[];
      expect(results).toMatchObject([
        { profile: "standard", artifact: { manifest: { verification: { platform: artifactHost() } } } },
        { profile: "active", status: "cancelled" },
        { profile: "queued", status: "not-started" },
      ]);
      const first = required(results[0]?.artifact, "Completed artifact");
      const suffix = artifactHost().startsWith("linux-") ? "tar.gz" : "zip";
      expect(readFileSync(join(first.directory, `artifact.${suffix}`), "utf8")).toBe("payload");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
    }
  },
);

test("artifact retention waits for a verified replacement and preserves in-use and transferred generations", async () => {
  const root = webFixture();
  const storage = mkdtempSync(join(tmpdir(), "workbench-artifact-retention-"));
  scratch.push(root, storage);
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", storage);
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  vi.stubEnv("WORKBENCH_CONFIG_HOME", storage);
  vi.stubEnv("WORKBENCH_STATE_HOME", storage);
  writeFileSync(join(storage, "config.toml"), "[cache]\nauto_prune = true\nmax_generations = 1\nmax_age_days = 0\n");
  const settings = configuration(artifactHost());
  settings.recipes.sample.verify = [
    "{node}",
    "-e",
    "if (require('node:fs').readFileSync(process.argv[1], 'utf8') === 'broken') process.exit(9);",
    "{artifact}",
  ];
  const [planned] = artifactPlan(decodeArtifactCatalog(settings, new Set(["demo"])), {
    profiles: ["standard"],
    kinds: ["release"],
  });
  const row = required(planned, "Retained release variant");
  const input = join(root, "fixture.txt");
  writeFileSync(input, "previous");
  const previous = await buildFileArtifact(root, row);
  const exported = await exportFileArtifact(previous, join(storage, "export"));
  const imported = await importFileArtifact(root, row, exported.directory, exported.manifestSha256);

  writeFileSync(input, "broken");
  const staged = await buildFileArtifact(root, row, undefined, true);
  await expect(verifyFileArtifact(root, row)).rejects.toThrow(/status=9/);
  expect(existsSync(previous.directory)).toBe(true);

  writeFileSync(input, "replacement");
  const latest = await withCacheLock(previous.directory, () => buildFileArtifact(root, row));
  expect(latest.manifest.verification).toBeDefined();
  expect(existsSync(previous.directory)).toBe(true);
  expect((await buildFileArtifact(root, row)).generation).toBe(latest.generation);
  expect(existsSync(previous.directory)).toBe(false);
  expect(existsSync(staged.directory)).toBe(true);
  expect(readFileSync(join(exported.directory, previous.manifest.file), "utf8")).toBe("previous");
  expect(readFileSync(join(imported.directory, previous.manifest.file), "utf8")).toBe("previous");
});

test("CI verifies distinct profile packages and refuses incomplete or changed release transfers", async () => {
  const root = webFixture();
  const storage = mkdtempSync(join(tmpdir(), "workbench-ci-release-"));
  scratch.push(root, storage);
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", storage);
  vi.stubEnv("WORKBENCH_CACHE_HOME", storage);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  vi.stubEnv("GITLAB_TOKEN", "test-token");
  writeFileSync(join(root, "fixture.txt"), "payload");
  const catalog = configuration(artifactHost());
  const variant = { target: "workstation", kind: "release", recipe: "sample", formats: ["archive"] };
  const profile = catalog.profiles.standard;
  const taggedRecipe = {
    ...catalog.recipes.sample,
    build: [
      "{node}",
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], process.argv[2] || 'snapshot')",
      "{artifact}",
      "{tag}",
    ],
    verify: [
      "{node}",
      "-e",
      "if (require('node:fs').readFileSync(process.argv[1], 'utf8') !== (process.argv[2] || 'snapshot')) process.exit(3)",
      "{artifact}",
      "{tag}",
    ],
  };
  writeFileSync(
    join(root, "workbench/profiles.toml"),
    stringify({
      ...catalog,
      recipes: { ...catalog.recipes, second: taggedRecipe },
      profiles: {
        ...catalog.profiles,
        alias: { ...profile, variants: [variant] },
        second: { ...profile, variants: [{ ...variant, recipe: "second" }] },
        manual: { ...profile, variants: [{ ...variant, ci_skip_reason: "requires operator inspection" }] },
      },
      destinations: { release: { kind: "gitlab", host: "https://gitlab.example.test", project: "team/demo" } },
      publication: {
        tag: {
          refs: ["v*"],
          profiles: ["standard", "alias", "second"],
          targets: ["workstation", "linux"],
          destination: "release",
        },
      },
    }),
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "Add release recipes");
  const tag = "v1.0.0";
  git(root, "tag", tag);
  const plan = plannedCIPackages(root);
  expect(plan.excluded).toEqual([{ id: "manual.workstation.archive.sample", reason: "requires operator inspection" }]);
  const selected = plan.selected.filter(({ row }) => row.target === "workstation").map(({ id }) => id);
  expect(selected).toEqual(["alias.workstation.archive.sample", "second.workstation.archive.second"]);
  const reports = join(storage, "checks");
  const checkedTag = "v0.9.0";
  git(root, "tag", checkedTag);
  await verifyCIPackages(root, selected, reports, checkedTag);
  const { packages: outcomes } = JSON.parse(readFileSync(join(reports, "packages.json"), "utf8")) as {
    packages: { id: string; status: string; directory: string; sha256: string }[];
  };
  expect(outcomes.map(({ id, status }) => [id, status])).toEqual(selected.map((id) => [id, "verified"]));
  expect(new Set(outcomes.map(({ directory }) => directory)).size).toBe(2);
  const transfers = join(storage, "transfers");
  const built = await packageCIRelease(root, tag, "workstation", join(transfers, "workstation"), reports);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(publishCIRelease(root, tag, transfers)).rejects.toThrow(/linux[\\/]release\.json/);
  const receipt = join(built, "release.json");
  const index = JSON.parse(readFileSync(receipt, "utf8")) as {
    revision: string;
    files: { variant: string; directory: string }[];
  };
  expect(index.files.map(({ variant }) => variant)).toEqual([
    "standard.workstation.archive",
    "second.workstation.archive",
  ]);
  const manifests = index.files.map(
    ({ directory }) =>
      JSON.parse(readFileSync(join(built, directory, "workbench-artifact.json"), "utf8")) as {
        file: string;
        sha256: string;
        releaseTag?: string;
        verification: { source?: string };
      },
  );
  expect(manifests[0]).toMatchObject({ sha256: outcomes[0]?.sha256, verification: { source: "transfer" } });
  const versioned = required(manifests[1], "Tagged package manifest");
  const versionedDirectory = required(index.files[1], "Tagged package export").directory;
  expect(versioned.sha256).not.toBe(outcomes[1]?.sha256);
  expect(versioned.releaseTag).toBe(tag);
  expect(versioned.verification.source).toBeUndefined();
  expect(readFileSync(join(built, versionedDirectory, versioned.file), "utf8")).toBe(tag);
  index.revision = "0".repeat(40);
  writeFileSync(receipt, JSON.stringify(index));
  await expect(publishCIRelease(root, tag, transfers)).rejects.toThrow(/workstation: release transfer does not match/);
  expect(fetch).not.toHaveBeenCalled();
});

test("one profile resolves several kinds and the target determines the portable archive", () => {
  const catalog = decodeArtifactCatalog(configuration("windows-x64"), new Set(["demo"]));
  const selected = { profiles: ["standard"], kinds: ["development", "release"] };
  expect(artifactPlan(catalog, selected, "windows-x64").map(({ kind, archive }) => [kind, archive])).toEqual([
    ["release", "zip"],
    ["development", "zip"],
  ]);
  expect(artifactPlan(catalog, { ...selected, kinds: ["release"], target: "linux" }, "windows-x64")[0]?.archive).toBe(
    "tar.gz",
  );
  expect(() => artifactPlan(catalog, { ...selected, target: "linux" }, "windows-x64")).toThrow(
    /no development artifact/,
  );
  expect(() => artifactPlan(catalog, { ...selected, format: "directory" }, "windows-x64")).toThrow(/--format/);
  expect(() => decodeArtifactCatalog(configuration("windows-x64"), new Set(["other"]))).toThrow(/unknown project/);
});

test("all profiles selects matching outputs while explicit profiles reject missing kinds", () => {
  const config = configuration("windows-x64");
  const { standard } = config.profiles;
  const catalog = decodeArtifactCatalog(
    {
      ...config,
      profiles: {
        application: { ...standard, variants: standard.variants.filter(({ kind }) => kind === "release") },
        development: { ...standard, variants: standard.variants.filter(({ kind }) => kind === "development") },
      },
    },
    new Set(["demo"]),
  );
  const kinds = ["development", "release"];
  expect(
    artifactPlan(catalog, { all: true, kinds }, "windows-x64").map(({ profile, kind }) => [profile, kind]),
  ).toEqual([
    ["application", "release"],
    ["development", "development"],
  ]);
  expect(
    artifactPlan(catalog, { all: true, kinds: ["development"] }, "windows-x64").map(({ profile }) => profile),
  ).toEqual(["development"]);
  expect(() => artifactPlan(catalog, { all: true, kinds }, "linux-x64")).toThrow(
    /Configured profiles: no development artifact/,
  );
  expect(() => artifactPlan(catalog, { profiles: ["application"], kinds }, "windows-x64")).toThrow(
    /application: no development artifact/,
  );
});

test("native archives relocate tool inputs and include dependency caches only for development", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-native-archive-"));
  scratch.push(root);
  const cache = join(root, "source-cache");
  for (const [path, content] of [
    ["authentication/signer", "pinned upstream signature"],
    ["downloads/jdk.tar.gz", "upstream distribution"],
    ["go-mod/cache/module.zip", "dependency archive"],
    ["toolchains/java/previously-installed", "installed file"],
    ["builds/build-output", "built project"],
  ] as const) {
    mkdirSync(join(cache, path, ".."), { recursive: true });
    writeFileSync(join(cache, path), content);
  }
  for (const kind of ["toolchain", "development"] as const) {
    const archive = join(root, `${kind}.tar.gz`);
    const target = join(root, `${kind}-cache`);
    await writeNativeArchive(cache, archive, kind);
    await restoreNativeArchive(archive, target, kind);
    expect(readFileSync(join(target, "downloads/jdk.tar.gz"), "utf8")).toBe("upstream distribution");
    expect(readFileSync(join(target, "authentication/signer"), "utf8")).toBe("pinned upstream signature");
    expect(readdirSync(target).sort()).toEqual(
      kind === "toolchain" ? ["authentication", "downloads"] : ["authentication", "downloads", "go-mod"],
    );
    if (kind === "development")
      expect(readFileSync(join(target, "go-mod/cache/module.zip"), "utf8")).toBe("dependency archive");
  }
});

test("native archive restore refuses link entries even inside an allowed cache directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-native-archive-link-"));
  scratch.push(root);
  const archive = join(root, "native.tar.gz");
  const pack = tar.pack();
  const completed = pipeline(pack, createGzip(), createWriteStream(archive));
  pack.entry({ name: "downloads", type: "directory" });
  pack.entry({ name: "downloads/asset", type: "symlink", linkname: "../../outside" });
  pack.finalize();
  await completed;
  const target = join(root, "restored");
  await expect(restoreNativeArchive(archive, target, "toolchain")).rejects.toThrow(/native archive entry/);
  expect(readdirSync(join(target, "downloads"))).toEqual([]);
});

test.skipIf(!["linux-x64", "linux-arm64", "macos-arm64", "windows-x64"].includes(artifactHost()))(
  "directory release packaging preserves runnable output through verified transfer",
  async () => {
    const root = webFixture();
    const cache = mkdtempSync(join(tmpdir(), "workbench-release-directory-"));
    scratch.push(root, cache);
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    vi.stubEnv("WORKBENCH_STORAGE_ROOT", cache);
    vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
    writeFileSync(join(root, "fixture.txt"), "documented behavior");
    const settings = configuration(artifactHost());
    settings.profiles.standard.variants = settings.profiles.standard.variants.filter(({ kind }) => kind === "release");
    const { sample } = settings.recipes;
    const catalog = decodeArtifactCatalog(
      {
        ...settings,
        recipes: {
          sample: {
            ...sample,
            package: {},
            build: [
              "{node}",
              "-e",
              `const fs=require('node:fs'), path=require('node:path'), out=process.argv[1];
           fs.writeFileSync(path.join(out,'tool.cjs'), 'process.stdout.write("portable")', {mode:0o755});
           if (process.platform !== "win32") fs.symlinkSync('tool.cjs',path.join(out,'launcher.cjs'));`,
              "{output}",
            ],
            verify: [
              "{node}",
              "-e",
              `const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), out=process.argv[1];
           assert.notEqual(process.cwd(), process.argv[2]);
           const launcher = path.join(out, process.platform === "win32" ? "tool.cjs" : "launcher.cjs");
           if (process.platform !== "win32") {
             assert(fs.lstatSync(launcher).isSymbolicLink());
             assert.equal(fs.statSync(launcher).mode & 0o100, 0o100);
           }
           assert.equal(require('node:child_process').execFileSync(process.execPath,[launcher],{encoding:'utf8'}),'portable');`,
              "{artifact}",
              "{source}",
            ],
          },
        },
      },
      new Set(["demo"]),
    );
    const [planned] = artifactPlan(catalog, { profiles: ["standard"], kinds: ["release"] });
    const row = required(planned, "Directory release variant");
    const built = await buildFileArtifact(root, row);
    expect(built.manifest.file).toBe(process.platform === "linux" ? "artifact.tar.gz" : "artifact.zip");
    const sent = await exportFileArtifact(built, join(cache, "transfer"));
    const imported = await importFileArtifact(root, row, sent.directory, sent.manifestSha256);
    expect(imported.manifest.verification?.sha256).toBe(built.manifest.sha256);
  },
);

test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))(
  "a managed artifact uses frozen preparation inputs and verifies the authenticated export in a fresh checkout",
  async () => {
    const root = webFixture();
    const storage = mkdtempSync(join(tmpdir(), "workbench-store-artifact-"));
    scratch.push(root, storage);
    vi.stubEnv("WORKBENCH_STORAGE_ROOT", storage);
    vi.stubEnv("WORKBENCH_CACHE_HOME", storage);
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    vi.stubEnv("WORKBENCH_CONFIG_HOME", storage);
    writeFileSync(join(storage, "config.toml"), '[preparation]\nnix_store = "managed"\n');
    writeFileSync(join(root, "pin.txt"), "declared closure");
    const config = join(root, "workbench/config.toml");
    writeFileSync(join(root, "container.json"), "{}\n");
    writeFileSync(
      config,
      readFileSync(config, "utf8") +
        `\n[[development.profiles]]\nname = "store"\nbuilder = "nix"\nworkspace = "host"\ncontainer_config = "container.json"\n[development.profiles.offline]\ninputs = ["pin.txt", "prepare.mjs"]\npaths = ["."]\nprepare = [${JSON.stringify(process.execPath)}, "prepare.mjs", "{image}"]\n`,
    );
    const projects = join(root, "workbench/projects.toml");
    writeFileSync(
      projects,
      readFileSync(projects, "utf8") + '\n[[language_root]]\nlanguage = "typescript"\npath = "."\n',
    );
    writeFileSync(
      join(root, "prepare.mjs"),
      `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs';
      assert.notEqual(process.cwd(), ${JSON.stringify(root)});
      assert.equal(process.env.WORKBENCH_MANAGED_PROFILE_EXPORT, '1');
      assert.equal(process.env.WORKBENCH_PREPARATION_STORE, 'managed');
      const profile = { path: '.', profile: '/nix/store/' + 'a'.repeat(32) + '-fixture' };
      const header = Buffer.from(JSON.stringify({version:1, builder:'nix', architecture:process.arch, kind:'development', profiles:[profile]}));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(header.length);
      writeFileSync(process.argv[2], Buffer.concat([prefix, header, readFileSync('pin.txt')]));
    `,
    );
    const verified = join(storage, "verified.txt");
    writeFileSync(
      join(root, "verify.mjs"),
      `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs';
      const [source, artifact] = process.argv.slice(2);
      assert.notEqual(source, ${JSON.stringify(root)});
      assert.equal(process.env.WORKBENCH_OFFLINE, '1');
      assert.equal(process.env.WORKBENCH_PROJECT_ROOT, source);
      const expected = readFileSync(source + '/pin.txt', 'utf8');
      const content = readFileSync(artifact);
      assert.equal(content.subarray(4 + content.readUInt32BE()).toString('utf8'), expected);
      writeFileSync(${JSON.stringify(verified)}, expected);
    `,
    );
    writeFileSync(
      join(root, "workbench/profiles.toml"),
      stringify({
        schema_version: 1,
        targets: { local: { platform: artifactHost() } },
        recipes: {
          closure: {
            owner: "demo",
            store_profile: "store",
            verify: ["{node}", "{root}/verify.mjs", "{root}", "{artifact}"],
          },
        },
        profiles: {
          standard: {
            builder: "nix",
            projects: ["demo"],
            variants: [{ target: "local", kind: "development", recipe: "closure", formats: ["nix-export"] }],
          },
        },
      }),
    );
    const [row] = artifactPlan(artifactCatalog.readArtifactCatalog(root), {
      profiles: ["standard"],
      kinds: ["development"],
    });
    const selected = required(row, "Managed artifact variant");
    const staged = await buildFileArtifact(root, selected, undefined, true);
    expect(staged.manifest.verification).toBeUndefined();
    const sent = await exportFileArtifact(staged, join(storage, "send"), true);
    const received = await importFileArtifact(root, selected, sent.directory, sent.manifestSha256);
    expect(readFileSync(verified, "utf8")).toBe("declared closure");
    expect(received.manifest.verification?.platform).toBe(artifactHost());
    rmSync(verified);
    writeFileSync(join(root, "pin.txt"), "replaced closure");
    await expect(importFileArtifact(root, selected, sent.directory, sent.manifestSha256)).rejects.toThrow(
      /receiving project profile inputs/,
    );
    expect(() => readFileSync(verified)).toThrow(/ENOENT/);
  },
);

test("a guided profile is reusable and confirmation preserves concurrent catalog edits", () => {
  const root = webFixture();
  scratch.push(root);
  const path = join(root, "workbench/profiles.toml");
  const original = "# Keep existing recipes\n" + stringify(configuration(artifactHost()));
  writeFileSync(path, original);
  const { standard } = artifactCatalog.readArtifactCatalog(root).profiles;
  const template = required(standard, "Missing template profile");
  const guided = { ...template, variants: template.variants.filter(({ target }) => target === "workstation") };
  const pending = editArtifactProfile(root, "add", "guided", guided);
  expect(readFileSync(path, "utf8")).toBe(original);
  writeFileSync(path, original + "\n# Concurrent edit\n");
  expect(() => pending.apply()).toThrow(/file changed before replacement/);
  expect(readFileSync(path, "utf8")).toBe(original + "\n# Concurrent edit\n");

  editArtifactProfile(root, "add", "guided", guided).apply();
  const saved = artifactCatalog.readArtifactCatalog(root);
  expect(saved.profiles.guided).toEqual(guided);
  expect(saved.profiles.standard).toEqual(template);
  for (const kind of ["release", "development"]) {
    const selection = { kinds: [kind], target: "workstation" };
    expect(artifactPlan(saved, { ...selection, profiles: ["guided"] })).toEqual(
      artifactPlan(saved, { ...selection, profiles: ["standard"] }).map((row) => ({ ...row, profile: "guided" })),
    );
  }
  expect(readFileSync(path, "utf8")).toContain("# Concurrent edit");
});

test("an explicit file transfer authenticates the manifest, checks bytes, and verifies on the receiver", async () => {
  const root = webFixture();
  scratch.push(root);
  const storage = mkdtempSync(join(tmpdir(), "workbench-artifact-test-"));
  scratch.push(storage);
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", storage);
  vi.stubEnv("WORKBENCH_CACHE_HOME", storage);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  writeFileSync(join(root, "fixture.txt"), "payload");
  const catalog = decodeArtifactCatalog(configuration(artifactHost()), new Set(["demo"]));
  const row: ArtifactPlanEntry = required(
    artifactPlan(catalog, {
      profiles: ["standard"],
      kinds: ["release"],
      target: "workstation",
    })[0],
    "Fixture release",
  );

  git(root, "add", "fixture.txt");
  git(root, "commit", "-qm", "Add artifact fixture");
  const committed = await buildFileArtifact(root, row, undefined, true);
  expect(committed.manifest.revision).toBe(git(root, "rev-parse", "HEAD").trim());
  writeFileSync(join(root, "uncommitted.txt"), "working copy");
  const candidate = await buildFileArtifact(root, row, undefined, true);
  expect(candidate.manifest.revision).toBeNull();
  expect(candidate.directory).not.toBe(committed.directory);
  expect(candidate.manifest.sha256).toBe(committed.manifest.sha256);
  expect(candidate.manifest.verification).toBeUndefined();
  const destination = join(storage, "transfers", "exported");
  await expect(exportFileArtifact(candidate, destination)).rejects.toThrow(/explicitly opt in/);
  const exported = await exportFileArtifact(candidate, destination, true);
  const retained = await buildFileArtifact(root, row, undefined, true);
  expect(retained.directory).toBe(candidate.directory);
  expect(await exportFileArtifact(retained, destination, true)).toEqual(exported);
  const receiver = join(storage, "receiver");
  git(root, "clone", "--quiet", root, receiver);
  writeFileSync(join(receiver, "uncommitted.txt"), "working copy");
  const received = await importFileArtifact(receiver, row, exported.directory, exported.manifestSha256);
  expect(received.manifest.verification?.platform).toBe(artifactHost());
  expect(inspectFileArtifactStates(receiver, [row]).get(row)).toMatchObject({
    state: "verified",
    artifact: { generation: received.generation },
  });
  expect(inspectFileArtifact(receiver, row)).toEqual(received);
  expect(inspectFileArtifact(receiver, row, undefined, received.generation)).toEqual(received);
  expect(() => inspectFileArtifact(receiver, row, undefined, "../outside")).toThrow(/Invalid artifact generation/);
  const reverified = await verifyFileArtifact(receiver, row);
  expect(reverified.generation).toBe(received.generation);
  const retransferred = await exportFileArtifact(reverified, join(storage, "re-exported"));
  expect(readFileSync(join(retransferred.directory, received.manifest.file), "utf8")).toBe("payload");
  expect(await importFileArtifact(receiver, row, exported.directory, exported.manifestSha256)).toEqual(reverified);
  await expect(importFileArtifact(receiver, row, exported.directory, "0".repeat(64))).rejects.toThrow(
    /supplied SHA-256/,
  );
  writeFileSync(join(receiver, "fixture.txt"), "changed recipe input");
  expect(inspectFileArtifactStates(receiver, [row]).get(row)?.state).toBe("outdated");
  expect(inspectFileArtifact(receiver, row)).toBeUndefined();
  const payload = join(exported.directory, candidate.manifest.file);
  writeFileSync(payload, "corrupt");
  await expect(exportFileArtifact(candidate, destination, true)).rejects.toThrow(/does not match its manifest/);
  expect(readFileSync(payload, "utf8")).toBe("corrupt");
  await expect(importFileArtifact(receiver, row, exported.directory, exported.manifestSha256)).rejects.toThrow(
    /does not match its manifest/,
  );
});

test("distinct verified bytes for one current recipe require an explicit generation", async () => {
  const root = webFixture();
  scratch.push(root);
  const storage = mkdtempSync(join(tmpdir(), "workbench-artifact-test-"));
  scratch.push(storage);
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", storage);
  vi.stubEnv("WORKBENCH_CACHE_HOME", storage);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  writeFileSync(join(root, "fixture.txt"), "payload");
  git(root, "add", "fixture.txt");
  git(root, "commit", "-qm", "Add artifact fixture");
  const alternate = join(storage, "producer");
  git(root, "clone", "--quiet", root, alternate);
  const config = configuration(artifactHost());
  config.recipes.sample.build[2] =
    "const fs=require('node:fs'); fs.writeFileSync(process.argv[2], fs.readFileSync(process.argv[1], 'utf8') + ':' + process.cwd())";
  config.recipes.sample.verify[2] =
    "const fs=require('node:fs'); if(!fs.readFileSync(process.argv[1], 'utf8').startsWith('payload:'))process.exit(3)";
  const catalog = decodeArtifactCatalog(config, new Set(["demo"]));
  const row = required(
    artifactPlan(catalog, { profiles: ["standard"], kinds: ["release"], target: "workstation" })[0],
    "Fixture release",
  );
  const first = await buildFileArtifact(root, row);
  const second = await buildFileArtifact(alternate, row);
  expect(second.manifest.inputs).toBe(first.manifest.inputs);
  expect(second.manifest.sha256).not.toBe(first.manifest.sha256);
  const delivery = await exportFileArtifact(second, join(storage, "exported"));
  const imported = await importFileArtifact(root, row, delivery.directory, delivery.manifestSha256);
  expect(inspectFileArtifactStates(root, [row]).get(row)).toMatchObject({
    state: "verified",
    generationChoices: [first.generation, imported.generation].sort(),
  });
  expect(() => inspectFileArtifact(root, row)).toThrow(/Select --generation/);
  expect(inspectFileArtifact(root, row, undefined, imported.generation)).toEqual(imported);
});

test("a changed verifier cannot inherit verification or approve a modified payload", async () => {
  const root = webFixture();
  scratch.push(root);
  const storage = mkdtempSync(join(tmpdir(), "workbench-artifact-verifier-"));
  scratch.push(storage);
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", storage);
  vi.stubEnv("WORKBENCH_CACHE_HOME", storage);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  writeFileSync(join(root, "fixture.txt"), "payload");
  const catalog = decodeArtifactCatalog(configuration(artifactHost()), new Set(["demo"]));
  const row = required(
    artifactPlan(catalog, { profiles: ["standard"], kinds: ["release"], target: "workstation" })[0],
    "Fixture release",
  );
  if ("offlineProfile" in row.definition) throw new Error("Expected a file recipe");

  expect(inspectFileArtifactStates(root, [row]).get(row)?.state).toBe("missing");
  const initial = await buildFileArtifact(root, row);
  expect(initial.manifest.verification).toBeDefined();
  expect(inspectFileArtifactStates(root, [row]).get(row)).toMatchObject({ state: "verified", artifact: initial });
  const revised: ArtifactPlanEntry = {
    ...row,
    definition: {
      ...row.definition,
      verify: ["{node}", "-e", "require('node:fs').writeFileSync(process.argv[1], 'changed')", "{artifact}"],
    },
  };
  const candidate = await buildFileArtifact(root, revised, undefined, true);
  expect(candidate.directory).toBe(initial.directory);
  expect(candidate.manifest.verification).toBeUndefined();
  await expect(exportFileArtifact(candidate, storage)).rejects.toThrow(/explicitly opt in/);
  await expect(buildFileArtifact(root, revised)).rejects.toThrow(/does not match its manifest/);
  expect(inspectFileArtifact(root, revised)?.manifest.verification).toBeUndefined();
  expect(inspectFileArtifactStates(root, [revised]).get(revised)?.state).toBe("unverified");
  expect(inspectFileArtifact(root, row)?.manifest.verification).toEqual(initial.manifest.verification);
  writeFileSync(join(root, "fixture.txt"), "updated inputs");
  expect(inspectFileArtifactStates(root, [row]).get(row)).toMatchObject({ state: "outdated", artifact: initial });
});

test("a changed verifier script requires fresh verification of the same release bytes", async () => {
  const root = webFixture();
  const storage = mkdtempSync(join(tmpdir(), "workbench-artifact-verifier-files-"));
  scratch.push(root, storage);
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", storage);
  vi.stubEnv("WORKBENCH_CACHE_HOME", storage);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  writeFileSync(join(root, "fixture.txt"), "payload");
  const script = join(root, "verify.mjs");
  writeFileSync(script, "console.log('first verifier');");
  const catalog = configuration(artifactHost());
  const recipe = catalog.recipes.sample;
  const buildLog = join(storage, "builds.txt");
  const decoded = decodeArtifactCatalog(
    {
      ...catalog,
      recipes: {
        sample: {
          ...recipe,
          build: [
            "{node}",
            "-e",
            "const fs = require('node:fs'); fs.copyFileSync(process.argv[1], process.argv[2]); fs.appendFileSync(process.argv[3], 'build\\n')",
            "{source}/fixture.txt",
            "{artifact}",
            buildLog,
          ],
          verify: ["{node}", "{root}/verify.mjs"],
          verify_inputs: ["verify.mjs"],
        },
      },
    },
    new Set(["demo"]),
  );
  const row = required(
    artifactPlan(decoded, { profiles: ["standard"], kinds: ["release"], target: "workstation" })[0],
    "Fixture release",
  );
  const initial = await buildFileArtifact(root, row);
  const verifier = required(initial.manifest.verification, "Initial verification").verifier;
  writeFileSync(script, "throw new Error('Verifier rejects the release');");
  expect(inspectFileArtifactStates(root, [row]).get(row)?.state).toBe("unverified");
  await expect(buildFileArtifact(root, row)).rejects.toThrow();
  expect(inspectFileArtifact(root, row)?.manifest.verification).toBeUndefined();

  writeFileSync(script, "import { writeFileSync } from 'node:fs'; writeFileSync(import.meta.filename, '/* edit */');");
  await expect(buildFileArtifact(root, row)).rejects.toThrow(/verifier inputs changed during verification/);
  expect(inspectFileArtifact(root, row)?.manifest.verification).toBeUndefined();

  writeFileSync(script, "console.log('replacement verifier');");
  const revised = await buildFileArtifact(root, row);
  expect(revised.generation).toBe(initial.generation);
  expect(revised.manifest.sha256).toBe(initial.manifest.sha256);
  expect(revised.manifest.verification?.verifier).not.toBe(verifier);
  expect(readFileSync(buildLog, "utf8")).toBe("build\n");
});
