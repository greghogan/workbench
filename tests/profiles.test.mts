import { required } from "../src/invariants.ts";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
import { detectedCompletionShell, installCompletion } from "../src/completion.ts";
import { buildPaths, distributionDirectory, prepareBuild, withBuildLock } from "../src/builds.ts";
import { inspectBuildCache, pruneBuildCache } from "../src/build-cache.ts";

const temporary: string[] = [];
const hostPlatform = required(Object.getOwnPropertyDescriptor(process, "platform"), "Platform descriptor");
afterEach(() => {
  Object.defineProperty(process, "platform", hostPlatform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-profiles-")));
  temporary.push(root);
  mkdirSync(join(root, "workbench"));
  mkdirSync(join(root, "app"));
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="go"\npath="app"\n',
  );
  const config: {
    schema_version: number;
    markdown: { wrap_width: number };
    compatibility: { required: boolean };
    development: {
      default: string;
      profiles: { name: string; builder: string; workspace: string; container_config?: string; compiler?: string }[];
    };
    release?: { profiles: ReturnType<typeof profile>[] };
  } = {
    schema_version: 1,
    markdown: { wrap_width: 120 },
    compatibility: { required: false },
    development: {
      default: "native",
      profiles: [
        { name: "native", builder: "native", workspace: "host" },
        { name: "nix", builder: "nix", workspace: "host", container_config: ".devcontainer/nix/devcontainer.json" },
        {
          name: "guix",
          builder: "guix",
          workspace: "host",
          container_config: ".devcontainer/guix/devcontainer.json",
        },
      ],
    },
  };
  const save = () => {
    writeFileSync(join(root, "workbench/config.toml"), stringify(config));
  };
  save();
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", resolve("."));
  vi.stubEnv("WORKBENCH_LOCAL_CONFIG_ROOT", undefined);
  vi.stubEnv("WORKBENCH_PROFILE_CONTEXT", undefined);
  vi.stubEnv("WORKBENCH_WORKSPACE_CONTEXT", undefined);
  vi.stubEnv("WORKBENCH_DEVELOPMENT_PROFILE", undefined);
  vi.stubEnv("WORKBENCH_SHELL_ENVIRONMENT", undefined);
  vi.stubEnv("WORKBENCH_SHELL_ROOT", undefined);
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "false");
  const bins = join(root, "clients");
  mkdirSync(bins);
  if (process.platform !== "win32") symlinkSync("/usr/bin/env", join(bins, "env"));
  // These fixture programs do only tiny filesystem operations; no installed host tools enter them.
  vi.stubEnv("PATH", bins);
  const profile = (
    name: string,
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
  await useDevelopment(root, "nix", "devcontainer");
  expect(executionPreference(root)).toBe("devcontainer");
  expect(
    required(selectedDevelopmentProfile(root), "Expected fixture value: selectedDevelopmentProfile(root)").builder,
  ).toBe("nix");
  expect(executionPreference(root, "native")).toBe("native");
  expect(executionPreference(root, undefined, "nix")).toBe("devcontainer");
  withDevelopmentSelection(
    root,
    undefined,
    "nix",
    () => {
      expect(executionPreference(root)).toBe("nix");
    },
    "host",
  );
  expect(() => executionPreference(root, "native", "nix")).toThrow(/select --profile or --environment/);
  expect(() => selectedDevelopmentProfile(root, "missing")).toThrow(/unknown development profile/);
  expect(readConfig(root).development).toEqual(config.development);
  expect(readFileSync(join(root, "workbench/.gitignore"), "utf8")).toContain("/local.toml");
  withDevelopmentSelection(root, "devcontainer", undefined, () => {
    expect(selectedDevelopmentProfile(root)).toBeUndefined();
  });
  expect(
    required(selectedDevelopmentProfile(root), "Expected fixture value: selectedDevelopmentProfile(root)").name,
  ).toBe("nix");
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
      config.development.profiles.push(required(config.development.profiles[0], "Native profile"));
    },
    () => {
      required(config.development.profiles[0], "Expected fixture value: config.development.profiles[0]").compiler =
        "gcc";
    },
    () => {
      required(config.development.profiles[0], "Expected fixture value: config.development.profiles[0]").workspace =
        "other";
    },
    () => {
      required(
        config.development.profiles[2],
        "Expected fixture value: config.development.profiles[2]",
      ).container_config = "../escape.json";
    },
    () => {
      required(
        config.development.profiles[0],
        "Expected fixture value: config.development.profiles[0]",
      ).container_config = "../config.json";
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
    for (const key of Object.keys(config)) Reflect.deleteProperty(config, key);
    Object.assign(config, structuredClone(valid));
    mutate();
    save();
    expect(() => readConfig(root)).toThrow();
  }
});

test.skipIf(process.platform === "win32").each(["native", "nix", "guix"])(
  "external %s release artifacts are reported and pruned as owned build products",
  async (builder) => {
    // Managed portable artifacts target Linux; these fixture recipes only exercise filesystem coordination.
    if (builder !== "native") Object.defineProperty(process, "platform", { ...hostPlatform, value: "linux" });
    const { root, config, save, profile } = fixture();
    const cache = realpathSync(mkdtempSync(join(tmpdir(), "workbench-release-cache-")));
    temporary.push(cache);
    vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
    vi.stubEnv("WORKBENCH_STORAGE_ROOT", cache);
    const selected = { ...profile("portable"), builder, format: builder === "native" ? "directory" : "portable" };
    config.release = { profiles: [selected] };
    writeFileSync(join(root, "channels.scm"), "fixture locked input\n");
    for (const file of ["flake.nix", "flake.lock", "manifest.scm"])
      writeFileSync(join(root, "app", file), "fixture locked input\n");
    save();
    const paths = buildPaths(root, root, "native", {}, false);
    const output = required(releasePlan(root)[0], "Expected fixture value: releasePlan(root)[0]").output;
    expect(output).toBe(join(distributionDirectory(paths), "releases/portable"));
    expect(existsSync(paths.directory)).toBe(false);
    prepareBuild(paths);
    withBuildLock(paths, () => {
      expect(() => {
        prepareReleases(root);
      }).toThrow(/another build or cleanup/);
    });
    const before = required(
      inspectBuildCache(root).entries.find((entry) => entry.directory === paths.directory),
      "Expected fixture value: inspectBuildCache(root).entries.find((entry) => entry.directory === paths.directory)",
    ).bytes;
    prepareReleases(root);
    expect(readFileSync(join(output, "count"), "utf8")).toBe("3");
    expect(JSON.parse(readFileSync(join(output, "workbench-release.json"), "utf8"))).toMatchObject({
      verified: true,
      builder,
    });
    expect(
      (JSON.parse(readFileSync(join(output, "workbench-release.json"), "utf8")) as { inputs: unknown[] }).inputs,
    ).toContainEqual({
      path: "channels.scm",
      sha256: createHash("sha256").update("fixture locked input\n").digest("hex"),
    });
    expect(existsSync(join(root, "dist"))).toBe(false);
    const dependency = join(paths.dependencies, "keep.txt");
    writeFileSync(dependency, "installed dependency");
    const report = inspectBuildCache(root);
    expect(
      required(
        report.entries.find((entry) => entry.directory === paths.directory),
        "Expected fixture value: report.entries.find((entry) => entry.directory === paths.directory)",
      ).bytes - before,
    ).toBe(readFileSync(join(output, "count")).length + readFileSync(join(output, "workbench-release.json")).length);
    await pruneBuildCache(report, false, true);
    expect(existsSync(output)).toBe(false);
    expect(readFileSync(dependency, "utf8")).toBe("installed dependency");
  },
);

test.skipIf(process.platform === "win32")("root release recipes reuse the coordinator's ownership lock", () => {
  const { root, config, save, profile } = fixture();
  // A root release snapshots these helpers as source; retain a real file rather than an escaping tool symlink.
  const env = join(root, "clients/env");
  rmSync(env);
  writeFileSync(env, '#!/bin/sh\nexec /usr/bin/env "$@"\n', { mode: 0o755 });
  const registry = join(root, "workbench/projects.toml");
  writeFileSync(registry, readFileSync(registry, "utf8") + '\n[[language_root]]\nlanguage="go"\npath="."\n');
  config.release = { profiles: [{ ...profile("root"), path: "." }] };
  save();
  prepareReleases(root);
  expect(
    readFileSync(
      join(required(releasePlan(root)[0], "Expected fixture value: releasePlan(root)[0]").output, "count"),
      "utf8",
    ),
  ).toBe("3");
});

test.skipIf(process.platform === "win32")(
  "release preparation defaults to all profiles, verifies relocated copies, and records immutable output identities",
  () => {
    const { root, config, save, profile } = fixture();
    config.release = { profiles: [profile("first"), profile("second")] };
    save();
    const reference = join(root, "default-file-mode");
    writeFileSync(reference, "");
    const expectedMode = lstatSync(reference).mode & 0o777;
    expect(releasePlan(root).map((p) => p.name)).toEqual(["first", "second"]);
    expect(releasePlan(root, ["second"]).map((p) => p.name)).toEqual(["second"]);
    expect(() => releasePlan(root, ["second"], true)).toThrow(/select profile names or --all/);
    expect(() => releasePlan(root, ["missing"])).toThrow(/unknown release/);
    prepareReleases(root);
    for (const name of ["first", "second"]) {
      const path = join(root, `dist/releases/${name}`);
      const receipt = JSON.parse(readFileSync(join(path, "workbench-release.json"), "utf8")) as {
        source: { configurationSha256: string };
        artifacts: unknown[];
      };
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
          mode: expectedMode,
          size: 1,
          sha256: createHash("sha256").update("3").digest("hex"),
        },
      ]);
    }
    expect(readdirSync(join(root, "dist/releases")).sort()).toEqual(["first", "second"]);
    expect(() => {
      prepareReleases(root, ["first"]);
    }).toThrow(/already exists/);
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
    expect(() => {
      prepareReleases(root);
    }).toThrow(/2 profile/);
    expect(readdirSync(join(root, "dist/releases"))).toEqual([]);
    mkdirSync(join(root, "dist/releases/.active"));
    expect(() => {
      prepareReleases(root);
    }).toThrow(/already be active/);
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
    expect(() => {
      prepareReleases(root);
    }).toThrow(/3 profile/);
    expect(readdirSync(join(root, "dist/releases"))).toEqual(["good"]);
    config.release.profiles = [
      { ...profile("foreign"), platform: process.arch === "arm64" ? "linux-x64" : "linux-arm64" },
    ];
    save();
    expect(() => {
      prepareReleases(root);
    }).toThrow(/no automatic emulation/);
    expect(readdirSync(join(root, "dist/releases"))).toEqual(["good"]);
    config.release.profiles = [
      profile("escape", `require('node:fs').symlinkSync('/etc/passwd', process.env.WORKBENCH_RELEASE_OUTPUT+'/count')`),
    ];
    save();
    expect(() => {
      prepareReleases(root);
    }).toThrow(/link escapes/);
    config.release.profiles = [];
    save();
    expect(() => {
      prepareReleases(root);
    }).toThrow(/no release profiles/);
  },
);

test("shell detection selects supported completion formats without assuming a Unix shell", () => {
  for (const shell of ["bash", "zsh", "fish"])
    expect(detectedCompletionShell({ SHELL: `/bin/${shell}` }, "linux")).toBe(shell);
  expect(detectedCompletionShell({ SHELL: "/usr/bin/pwsh" }, "linux")).toBe("powershell");
  expect(detectedCompletionShell({}, "win32")).toBe("powershell");
  expect(detectedCompletionShell({ SHELL: "/bin/unknown" }, "linux")).toBeUndefined();
});

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
  const zsh = installCompletion("zsh", join(root, "zsh"));
  expect(readFileSync(zsh, "utf8").split("\n")[0]).toBe("#compdef workbench");
  expect(installCompletion("zsh", join(root, "zsh"))).toBe(zsh);
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
    const receipt = JSON.parse(readFileSync(join(root, "dist/releases/linked/workbench-release.json"), "utf8")) as {
      artifacts: { path: string }[];
    };
    expect(receipt.artifacts.find((file: { path: string }) => file.path === "alias")).toMatchObject({
      type: "symlink",
      mode: lstatSync(join(root, "dist/releases/linked/alias")).mode & 0o777,
    });
  },
);
