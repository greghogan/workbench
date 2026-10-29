import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { editToml } from "./toml-edit.js";
import { parse as parseYaml } from "yaml";
import type { VerifiedWorkbenchPackage } from "./package-verify.js";
import type { ConsumerCommands } from "./consumer-integration-runner.js";
import type { ConsumerScenarios } from "./consumer-integration-scenarios.js";
import { record, records, string } from "../scripts/values.mjs";
import { standaloneTools } from "./toolchains.js";
import { resolveNativeTool } from "./native-installation.js";
import { verifyInstalledTool } from "./native-tools.js";

/** Exercise the installed archive's public CLI; no Git host, registry, or account is contacted. */
export async function exerciseCIHosting(
  installed: VerifiedWorkbenchPackage,
  source: string,
  environment: NodeJS.ProcessEnv,
  commands: ConsumerCommands,
  scenarios: ConsumerScenarios,
): Promise<void> {
  const root = join(installed.temporary, "CI examples 雪"),
    language = "writer's notes";
  const env = { ...environment, WORKBENCH_DISTRIBUTION_ROOT: installed.directory, WORKBENCH_EPHEMERAL_CHECKOUT: "1" };
  const cli = (name: string, args: string[]) =>
    commands.capture(`ci-${name}`, [process.execPath, installed.launcher, ...args], root, env);
  const git = (name: string, args: string[]) => commands.run(`ci-${name}`, ["git", ...args], root, env);
  await scenarios.run("ci-workflows", async () => {
    mkdirSync(root, { recursive: true });
    await cli("init", ["init", root, "--records-only"]);
    for (const directory of ["workbench", "bin", language]) mkdirSync(join(root, directory), { recursive: true });
    cpSync(join(installed.directory, "tests/fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    writeFileSync(
      join(root, "workbench/projects.toml"),
      `[[project]]\nid="ci-example"\npath="."\n[[language_root]]\nlanguage="javascript"\npath=${JSON.stringify(language)}\nci_compatibility=false\n`,
    );
    const configPath = join(root, "workbench/config.toml"),
      original = readFileSync(configPath, "utf8"),
      config = parseToml(original);
    config.ci = {
      operating_systems: ["linux", "macos", "windows"],
      environments: [],
      architectures: { linux: ["x64", "arm64"] },
    };
    config.check = [
      {
        name: "observable behavior",
        path: language,
        role: "test",
        requires_setup: false,
        command: ["node", "-e", "require('node:fs').writeFileSync('check-ran','passed')"],
      },
    ];
    writeFileSync(configPath, editToml(original, config));
    writeFileSync(
      join(root, "bin/workbench.mjs"),
      "// Source-checkout launcher fixture; commands use the installed archive.\n",
    );
    writeFileSync(join(root, ".gitignore"), readFileSync(join(root, ".gitignore"), "utf8") + "\n**/check-ran\n");
    cpSync(join(installed.directory, ".node-version"), join(root, language, ".node-version"));
    writeFileSync(
      join(root, language, "package.json"),
      JSON.stringify({ name: "ci-fixture", version: "1.0.0", private: true, engines: { node: ">=18.20.8" } }),
    );
    await git("init", ["init", "--quiet"]);
    await git("github-remote", ["remote", "add", "origin", "git@github.com:owner/project.git"]);
    await git("gitlab-remote", ["remote", "add", "gitlab", "git@gitlab.com:team/nested/project.git"]);
    await cli("register", ["project", "add", "."]);
    const before = readFileSync(join(root, "workbench/config.toml"), "utf8");
    await cli("preview", ["ci", "setup", "--remote", "origin", "--plan"]);
    assert.equal(readFileSync(join(root, "workbench/config.toml"), "utf8"), before);
    assert.equal(existsSync(join(root, ".github/workflows/workbench.yml")), false);
    await cli("github-setup", ["ci", "setup", "--remote", "origin"]);
    await cli("gitlab-setup", ["ci", "setup", "--remote", "gitlab"]);
    await cli("github-plan", ["ci", "pipeline", "--destination", "origin", "--output", ".workbench-ci/github.json"]);
    await cli("gitlab-plan", ["ci", "pipeline", "--destination", "gitlab", "--output", ".workbench-ci/gitlab.yml"]);
    const github = record(JSON.parse(readFileSync(join(root, ".workbench-ci/github.json"), "utf8")), "GitHub matrix");
    const gitlab = record(parseYaml(readFileSync(join(root, ".workbench-ci/gitlab.yml"), "utf8")), "GitLab pipeline");
    for (const group of records(github.include, "GitHub platforms")) {
      const id = string(group.id, "Group identity");
      assert.ok(gitlab[`prepare-${id}`]);
      assert.ok(
        Object.values(gitlab).some(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "needs" in value &&
            JSON.stringify(value.needs).includes(`prepare-${id}`),
        ),
      );
    }
    await cli("gitlab-local-validation", ["ci", "validate", "--destination", "gitlab"]);
    await cli("sync", ["sync"]);
    await git("stage-fixture", ["add", "."]);
    await git("commit-fixture", ["-c", "core.hooksPath=", "commit", "--quiet", "-m", "Fixture"]);
  });
  await scenarios.run(
    "ci-generated-workflow-lint",
    async () => {
      const version = standaloneTools(source).get("actionlint");
      assert.ok(version, "The development environment must declare actionlint");
      const tool = { name: "actionlint", version, source: "declared development actionlint" };
      const selected = resolveNativeTool(installed.directory, source, tool);
      assert.equal(selected.provider, "artifact");
      verifyInstalledTool(source, tool, selected.asset, selected.destination, environment);
      await commands.run(
        "ci-actionlint",
        [
          join(selected.destination, selected.asset.bin, `actionlint${process.platform === "win32" ? ".exe" : ""}`),
          "-shellcheck=",
          "-pyflakes=",
          ".github/workflows/workbench.yml",
          ".github/workflows/workbench-platform.yml",
        ],
        root,
        env,
      );
    },
    ["ci-workflows"],
  );
  await scenarios.run(
    "ci-native-preparation-and-operation",
    async () => {
      const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
      const groups = records(
        record(JSON.parse(readFileSync(join(root, ".workbench-ci/github.json"), "utf8")), "matrix").include,
        "groups",
      );
      const group = groups.find((group) => group.os === os && group.architecture === process.arch);
      assert.ok(group, "The host must have a native configured group");
      const id = string(group.id, "group");
      await cli("prepare", ["ci", "prepare", id, "--destination", "origin", "--output", ".workbench-ci/prepared"]);
      assert.equal(existsSync(join(root, language, "check-ran")), false, "Preparation must not execute project tests");
      await cli("operations", [
        "ci",
        "pipeline",
        "--destination",
        "origin",
        "--group",
        id,
        "--output",
        ".workbench-ci/operations.json",
      ]);
      const jobs = records(
        record(JSON.parse(readFileSync(join(root, ".workbench-ci/operations.json"), "utf8")), "matrix").include,
        "operations",
      );
      for (const job of jobs)
        await cli("run", [
          "ci",
          "run",
          id,
          string(job.id, "operation"),
          "--destination",
          "origin",
          "--prepared",
          ".workbench-ci/prepared/prepared.json",
        ]);
      assert.equal(readFileSync(join(root, language, "check-ran"), "utf8"), "passed");
    },
    ["ci-workflows"],
  );
}
