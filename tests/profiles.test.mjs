import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "smol-toml";
import { readConfig } from "../src/core.ts";
import { executionPreference, selectedDevelopmentProfile, withDevelopmentSelection } from "../src/environments.ts";
import { inspectDevelopment, useDevelopment } from "../src/development.ts";
import { setConfiguration } from "../src/config-command.ts";
import { releasePlan, prepareReleases } from "../src/release-profiles.ts";
import { installCompletion } from "../src/completion.ts";

const temporary = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-profiles-"));
  temporary.push(root);
  mkdirSync(join(root, "workbench"));
  mkdirSync(join(root, "app"));
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="go"\npath="app"\n',
  );
  const config = {
    schema_version: 1,
    markdown: { wrap_width: 120 },
    compatibility: { required: false },
    development: {
      default: "native",
      profiles: [
        { name: "native", builder: "native", workspace: "host" },
        { name: "nix", builder: "nix", workspace: "host" },
        {
          name: "nix-container",
          builder: "nix",
          workspace: "devcontainer",
          container_config: ".devcontainer/nix/devcontainer.json",
        },
      ],
    },
  };
  const save = () => writeFileSync(join(root, "workbench/config.toml"), stringify(config));
  save();
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", resolve("."));
  vi.stubEnv("WORKBENCH_LOCAL_CONFIG_ROOT", undefined);
  vi.stubEnv("WORKBENCH_PROFILE_CONTEXT", undefined);
  vi.stubEnv("WORKBENCH_DEVELOPMENT_PROFILE", undefined);
  vi.stubEnv("WORKBENCH_SHELL_ENVIRONMENT", undefined);
  vi.stubEnv("WORKBENCH_SHELL_ROOT", undefined);
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "false");
  vi.stubEnv("WORKBENCH_REQUIRE_BENCHCTL", undefined);
  const bins = join(root, "clients");
  mkdirSync(bins);
  if (process.platform !== "win32") symlinkSync("/usr/bin/env", join(bins, "env"));
  // These fixture programs do only tiny filesystem operations; no installed host scheduler or tools enter them.
  vi.stubEnv("PATH", bins);
  const profile = (
    name,
    prepare = `require('node:fs').writeFileSync(process.env.WORKBENCH_RELEASE_OUTPUT + '/count', '3')`,
    verify = `const fs=require('node:fs'); if(fs.readFileSync(process.argv[1]+'/count','utf8')!=='3')process.exit(1); if(process.cwd().startsWith(process.argv[2]))process.exit(2)`,
  ) => ({
    name,
    path: "app",
    builder: "native",
    format: "directory",
    platform: `${process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
    prepare: [process.execPath, "-e", prepare],
    verify: [process.execPath, "-e", verify, "{artifact}", "{source}"],
  });
  return { root, config, save, profile };
}

test("development selection is local, validated, explicit, and independent of release and CI settings", async () => {
  const { root, config, save } = fixture();
  expect(inspectDevelopment(root).active).toBe("native");
  await useDevelopment(root, "nix-container");
  expect(executionPreference(root)).toBe("devcontainer");
  expect(selectedDevelopmentProfile(root).builder).toBe("nix");
  expect(executionPreference(root, "native")).toBe("native");
  expect(executionPreference(root, undefined, "nix")).toBe("nix");
  expect(() => executionPreference(root, "native", "nix")).toThrow(/select --profile or --environment/);
  expect(() => selectedDevelopmentProfile(root, "missing")).toThrow(/unknown development profile/);
  expect(readConfig(root).development).toEqual(config.development);
  expect(readFileSync(join(root, "workbench/.gitignore"), "utf8")).toContain("/local.toml");
  withDevelopmentSelection(root, "devcontainer", undefined, () =>
    expect(selectedDevelopmentProfile(root)).toBeUndefined(),
  );
  expect(selectedDevelopmentProfile(root).name).toBe("nix-container");
  setConfiguration(root, "checks.environment", "guix", "local");
  expect(selectedDevelopmentProfile(root)).toBeUndefined();
  expect(executionPreference(root)).toBe("guix");
  await useDevelopment(root, "native");
  expect(executionPreference(root)).toBe("native");
  config.development.default = "missing";
  save();
  expect(() => readConfig(root)).toThrow(/development.default/);
});

test("profile configuration rejects unknown fields, duplicate names, invalid workspace and format combinations", () => {
  const { root, config, save, profile } = fixture();
  const valid = structuredClone(config);
  for (const mutate of [
    () => {
      config.development.profiles.push(config.development.profiles[0]);
    },
    () => {
      config.development.profiles[0].compiler = "gcc";
    },
    () => {
      config.development.profiles[0].workspace = "other";
    },
    () => {
      config.development.profiles[2].container_config = "../escape.json";
    },
    () => {
      config.development.profiles[0].container_config = "config.json";
    },
    () => {
      config.release = { profiles: [{ ...profile("broken"), builder: "nix", format: "squashfs" }] };
    },
    () => {
      config.release = { profiles: [{ ...profile("broken"), verify: [] }] };
    },
    () => {
      config.release = { profiles: [{ ...profile("broken"), path: "../escape" }] };
    },
  ]) {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, structuredClone(valid));
    mutate();
    save();
    expect(() => readConfig(root)).toThrow();
  }
});

test.skipIf(process.platform === "win32")(
  "release preparation defaults to all profiles, verifies relocated copies, and records immutable output identities",
  () => {
    const { root, config, save, profile } = fixture();
    config.release = { profiles: [profile("first"), profile("second")] };
    save();
    expect(releasePlan(root).map((p) => p.name)).toEqual(["first", "second"]);
    expect(releasePlan(root, ["second"]).map((p) => p.name)).toEqual(["second"]);
    expect(() => releasePlan(root, ["second"], true)).toThrow(/select profile names or --all/);
    expect(() => releasePlan(root, ["missing"])).toThrow(/unknown release/);
    prepareReleases(root);
    for (const name of ["first", "second"]) {
      const path = join(root, `dist/releases/${name}`);
      const receipt = JSON.parse(readFileSync(join(path, "workbench-release.json"), "utf8"));
      expect(receipt).toMatchObject({ version: 1, verified: true, emulation: false, builder: "native" });
      expect(receipt.source.configurationSha256).toBe(
        createHash("sha256")
          .update(readFileSync(join(root, "workbench/config.toml")))
          .digest("hex"),
      );
      expect(receipt.artifacts).toEqual([
        {
          path: "count",
          type: "file",
          mode: 0o666 & ~process.umask(),
          size: 1,
          sha256: createHash("sha256").update("3").digest("hex"),
        },
      ]);
    }
    expect(readdirSync(join(root, "dist/releases")).sort()).toEqual(["first", "second"]);
    expect(() => prepareReleases(root, ["first"])).toThrow(/already exists/);
    expect(readFileSync(join(root, "dist/releases/first/count"), "utf8")).toBe("3");
  },
);

test.skipIf(process.platform === "win32")(
  "release receipts cannot be supplied by recipes and changing sources is rejected",
  () => {
    const { root, config, save, profile } = fixture();
    writeFileSync(join(root, "app/source.txt"), "original");
    config.release = {
      profiles: [
        profile(
          "reserved",
          "require('node:fs').writeFileSync(process.env.WORKBENCH_RELEASE_OUTPUT+'/workbench-release.json','forged')",
        ),
        profile(
          "unstable",
          "require('node:fs').writeFileSync('source.txt','changed'); require('node:fs').writeFileSync(process.env.WORKBENCH_RELEASE_OUTPUT+'/count','3')",
        ),
      ],
    };
    save();
    expect(() => prepareReleases(root)).toThrow(/2 profile/);
    expect(readdirSync(join(root, "dist/releases"))).toEqual([]);
    mkdirSync(join(root, "dist/releases/.active"));
    expect(() => prepareReleases(root)).toThrow(/already be active/);
    expect(existsSync(join(root, "dist/releases/.active"))).toBe(true);
  },
);

test.skipIf(process.platform === "win32")(
  "failed and mutated artifacts are rejected while independent releases still finish and locks are cleaned",
  () => {
    const { root, config, save, profile } = fixture();
    config.release = {
      profiles: [
        profile("bad", "process.exit(9)"),
        profile("changed", undefined, "require('node:fs').writeFileSync(process.argv[1]+'/count','changed')"),
        profile("permissions", undefined, "require('node:fs').chmodSync(process.argv[1]+'/count',0)"),
        profile("good"),
      ],
    };
    save();
    expect(() => prepareReleases(root)).toThrow(/3 profile/);
    expect(readdirSync(join(root, "dist/releases"))).toEqual(["good"]);
    config.release.profiles = [
      { ...profile("foreign"), platform: process.arch === "arm64" ? "linux-x64" : "linux-arm64" },
    ];
    save();
    expect(() => prepareReleases(root)).toThrow(/no automatic emulation/);
    expect(readdirSync(join(root, "dist/releases"))).toEqual(["good"]);
    config.release.profiles = [
      profile("escape", `require('node:fs').symlinkSync('/etc/passwd', process.env.WORKBENCH_RELEASE_OUTPUT+'/count')`),
    ];
    save();
    expect(() => prepareReleases(root)).toThrow(/link escapes/);
    config.release.profiles = [];
    save();
    expect(() => prepareReleases(root)).toThrow(/no release profiles/);
  },
);

test("completion installation preserves unrelated files and rejects symlinks while remaining idempotent", () => {
  const { root } = fixture();
  const directory = join(root, "completions");
  const path = installCompletion("bash", directory);
  const contents = readFileSync(path, "utf8");
  expect(installCompletion("bash", directory)).toBe(path);
  expect(readFileSync(path, "utf8")).toBe(contents);
  writeFileSync(path, "unrelated");
  expect(() => installCompletion("bash", directory)).toThrow(/unrelated/);
  expect(readFileSync(path, "utf8")).toBe("unrelated");
  expect(() => installCompletion("unknown", directory)).toThrow(/completion shell/);
  if (process.platform !== "win32") {
    rmSync(path);
    symlinkSync(join(root, "absent"), path);
    expect(() => installCompletion("bash", directory)).toThrow(/symlink/);
  }
  expect(existsSync(join(root, ".bashrc"))).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "relative internal artifact links remain valid in the independent verification copy",
  () => {
    const { root, config, save, profile } = fixture();
    config.release = {
      profiles: [
        profile(
          "linked",
          "const fs=require('node:fs');fs.writeFileSync(process.env.WORKBENCH_RELEASE_OUTPUT+'/count','3');fs.symlinkSync('count',process.env.WORKBENCH_RELEASE_OUTPUT+'/alias')",
          "const fs=require('node:fs');if(fs.readFileSync(process.argv[1]+'/alias','utf8')!=='3')process.exit(1);if(!fs.realpathSync(process.argv[1]+'/alias').startsWith(process.argv[1]))process.exit(2)",
        ),
      ],
    };
    save();
    prepareReleases(root);
    const receipt = JSON.parse(readFileSync(join(root, "dist/releases/linked/workbench-release.json"), "utf8"));
    expect(receipt.artifacts.find((file) => file.path === "alias")).toMatchObject({ type: "symlink", mode: 0o777 });
  },
);
