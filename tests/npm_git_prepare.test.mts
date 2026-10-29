import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { npmCommand, npmRuntimeEnvironment } from "../src/npm-command.ts";
import { gitNullConfiguration } from "../src/windows-host.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("Git source preparation runs the explicit builder without running dependency lifecycle scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-npm-prepare-"));
  temporary.push(root);
  const dependency = join(root, "dependency"),
    source = join(root, "source"),
    consumer = join(root, "consumer");
  for (const directory of [dependency, source, consumer]) mkdirSync(directory);
  const marker = join(root, "dependency-script-ran");
  writeFileSync(
    join(dependency, "package.json"),
    JSON.stringify({ name: "fixture-install-hook", version: "1.0.0", scripts: { install: "node install.cjs" } }),
  );
  writeFileSync(
    join(dependency, "install.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
  );
  const env: NodeJS.ProcessEnv = {
    ...npmRuntimeEnvironment(),
    NODE_V8_COVERAGE: "",
    npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(root, "npmrc"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_offline: "true",
  };
  for (const key of Object.keys(env))
    if (
      ["NODE_OPTIONS", "npm_config_ignore_scripts", "npm_config_registry", "WORKBENCH_SUBPROCESS_COVERAGE"].includes(
        key,
      ) ||
      key.startsWith("GIT_")
    )
      Reflect.deleteProperty(env, key);
  writeFileSync(join(root, "npmrc"), "");
  env.GIT_CONFIG_GLOBAL = gitNullConfiguration;
  env.GIT_CONFIG_NOSYSTEM = "1";
  const npm = npmCommand({ environment: env });
  const run = (args: string[], cwd: string) =>
    execFileSync(npm.command, [...npm.prefix, ...args], { cwd, env, encoding: "utf8", stdio: "pipe" });
  const packed = JSON.parse(run(["pack", "--ignore-scripts", "--json", "--pack-destination", source], dependency)) as {
    filename: string;
  }[];
  const tarball = packed[0]?.filename;
  if (!tarball) throw new Error("Missing fixture archive");
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "fixture-source",
      version: "1.0.0",
      files: ["prepared.txt"],
      devDependencies: { "fixture-install-hook": `file:./${tarball}` },
      scripts: { prepare: "node prepare.cjs" },
    }),
  );
  writeFileSync(
    join(source, "prepare.cjs"),
    'require("node:fs").writeFileSync("prepared.txt", "explicit preparation ran");\n',
  );
  writeFileSync(join(source, ".npmrc"), readFileSync(new URL("../.npmrc", import.meta.url)));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { env, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Source fixture",
    "-c",
    "user.email=source@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Fixture",
  );
  const revision = git("rev-parse", "HEAD");
  writeFileSync(join(consumer, "package.json"), '{"private":true}\n');
  run(["install", "--save=false", `git+${pathToFileURL(source).href}#${revision}`], consumer);
  expect(readFileSync(join(consumer, "node_modules/fixture-source/prepared.txt"), "utf8")).toBe(
    "explicit preparation ran",
  );
  expect(existsSync(marker)).toBe(false);
  rmSync(join(source, ".npmrc"));
  git("add", "--update");
  git(
    "-c",
    "user.name=Source fixture",
    "-c",
    "user.email=source@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Control without lifecycle protection",
  );
  const control = join(root, "control");
  mkdirSync(control);
  writeFileSync(join(control, "package.json"), '{"private":true}\n');
  run(["install", "--save=false", `git+${pathToFileURL(source).href}#${git("rev-parse", "HEAD")}`], control);
  expect(readFileSync(marker, "utf8")).toBe("ran");
});
