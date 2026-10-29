import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "smol-toml";
import { editToml } from "./toml-edit.js";
import { readExecutableIdentity } from "./executable-identity.js";
import { toolSpecification } from "./tool-pin.js";
import { required } from "./invariants.js";
import type { ConsumerScenarios } from "./consumer-integration-scenarios.js";
import { distributionSourceFile } from "./distribution-identity.js";
import type { VerifiedWorkbenchPackage } from "./package-verify.js";
import {
  consumerCommandDiagnostics,
  type ConsumerCommands,
  type ConsumerInvocation,
} from "./consumer-integration-runner.js";
import { windowsBatchArgument } from "./windows-batch.js";
import { npmCommand } from "./npm-command.js";

/** Exercise the executable selected by PATH, including npm's native Windows command shim. */
export function consumerPathCommand(
  args: string[],
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
): string[] | ConsumerInvocation {
  return platform === "win32"
    ? {
        command: [
          environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
          "/d",
          "/s",
          "/c",
          `workbench.cmd ${args.map(windowsBatchArgument).join(" ")}`,
        ],
        windowsVerbatimArguments: true,
      }
    : ["workbench", ...args];
}

/** These are disposable homes: launcher/completion installation must never reach the developer's settings. */
export function consumerInstallationEnvironment(root: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const userconfig = join(root, "npm-user.conf"),
    globalconfig = join(root, "npm-global.conf");
  writeFileSync(userconfig, "");
  writeFileSync(globalconfig, "");
  return {
    ...base,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData/Local"),
    APPDATA: join(home, "AppData/Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    WORKBENCH_CONFIG_HOME: join(root, "config"),
    WORKBENCH_DATA_HOME: join(root, "data"),
    WORKBENCH_CACHE_HOME: join(root, "cache"),
    WORKBENCH_STATE_HOME: join(root, "state"),
    npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_ignore_scripts: "true",
  };
}

/** Real npm/Git acquisition stays local; the same archive supplies every installation scenario. */
export async function exerciseConsumerInstallations(
  installed: VerifiedWorkbenchPackage,
  base: NodeJS.ProcessEnv,
  commands: ConsumerCommands,
  scenarios: ConsumerScenarios,
  sourceManifest: string,
): Promise<void> {
  const root = join(installed.temporary, "installation space 雪");
  mkdirSync(root, { recursive: true });
  const env = consumerInstallationEnvironment(root, base);
  const guard = join(root, "deny-network.cjs");
  writeFileSync(
    guard,
    "require('node:net').Socket.prototype.connect = function () { throw new Error('Installation fixture attempted external network access'); };\n",
  );
  env.NODE_OPTIONS = `--require ${JSON.stringify(guard)}`;
  const npm = npmCommand({ sdkOnly: true });
  const run = (name: string, args: string[], cwd: string, environment = env) =>
    commands.run(name, consumerPathCommand(args, environment), cwd, environment);
  const query = (name: string, args: string[], cwd: string, environment = env) =>
    commands.capture(name, consumerPathCommand(args, environment), cwd, environment);
  const git = (name: string, args: string[], cwd: string, environment = env) =>
    commands.capture(name, ["git", ...args], cwd, environment);
  const prefixBin = process.platform === "win32" ? installed.prefix : join(installed.prefix, "bin");
  const charter = join(installed.directory, "tests/fixtures/records/CHARTER.md");
  const task = async (name: string, project: string, environment: NodeJS.ProcessEnv) => {
    const titles = [
      `${name} preserves spaces and Unicode 雪`,
      `${name} literal "quotes" & | < > ^ %WORKBENCH_FIXTURE_EXPANSION% ! (group) \\`,
    ];
    const nested = join(project, "nested directory 雪");
    mkdirSync(nested, { recursive: true });
    const tasks = join(project, "workbench/tasks");
    for (const [index, title] of titles.entries()) {
      await run(`${name}-task-${String(index)}`, ["record", "add", "task", title], nested, {
        ...environment,
        WORKBENCH_FIXTURE_EXPANSION: "must-remain-literal",
      });
      assert.ok(
        readdirSync(tasks).some(
          (file) => file.endsWith(".md") && readFileSync(join(tasks, file), "utf8").includes(title),
        ),
        "The PATH-selected command must write the requested task into the consuming project",
      );
    }
    await run(`${name}-sync`, ["sync"], nested, environment);
    await run(`${name}-validate`, ["validate"], nested, environment);
  };
  const project = async (name: string, environment: NodeJS.ProcessEnv) => {
    const path = join(root, name);
    await run(`${name}-init`, ["init", path, "--records-only", "--no-workbench-collection"], root, environment);
    cpSync(charter, join(path, "workbench/CHARTER.md"));
    await task(name, path, environment);
    return path;
  };
  await scenarios.run("installation-system-prefix", async () => {
    const environment = { ...env, PATH: [prefixBin, env.PATH].join(delimiter) };
    await project("system-prefix", environment);
  });

  const source = join(root, "source"),
    repository = "https://workbench-installation.invalid/workbench.git";
  const userBin =
    process.platform === "win32" ? join(env.LOCALAPPDATA ?? "", "workbench/bin") : join(env.HOME ?? "", ".local/bin");
  const userEnv: NodeJS.ProcessEnv = {
    ...env,
    PATH: [userBin, ...(env.PATH ?? "").split(delimiter).filter((path) => resolve(path) !== resolve(prefixBin))].join(
      delimiter,
    ),
  };
  const selected = async (name: string, cwd: string, environment: NodeJS.ProcessEnv, revision: string) => {
    const identity = readExecutableIdentity(JSON.parse(await query(name, ["executable", "--json"], cwd, environment)));
    assert.equal(
      toolSpecification({ repository: identity.repository, revision: identity.revision }),
      toolSpecification({ repository, revision }),
    );
    return identity.directory;
  };
  const fixture = await scenarios.run("installation-user-launcher", async () => {
    cpSync(installed.directory, source, { recursive: true });
    // Git acquisition must exercise the source manifest, including its development dependencies/lifecycle scripts.
    writeFileSync(join(source, "package.json"), sourceManifest);
    // A local Git fixture has its own immutable identity, independent of the release candidate's provenance.
    rmSync(join(source, distributionSourceFile), { force: true });
    await git("install-git-init", ["init", "--quiet"], source);
    const original = readFileSync(join(source, "README.md"), "utf8");
    const revisions: string[] = [];
    for (const marker of ["installation-revision-A", "installation-revision-B"]) {
      writeFileSync(join(source, "README.md"), `${original}\n${marker}\n`);
      await git(`install-${marker}-stage`, ["add", "."], source);
      await git(`install-${marker}-commit`, ["commit", "--quiet", "-m", marker], source);
      const revision = (await git(`install-${marker}-revision`, ["rev-parse", "HEAD"], source)).trim();
      revisions.push(revision);
    }
    const first = required(revisions[0], "First fixture revision"),
      second = required(revisions[1], "Second fixture revision");
    const count = Number(userEnv.GIT_CONFIG_COUNT ?? "0");
    Object.assign(userEnv, {
      GIT_CONFIG_COUNT: String(count + 2),
      [`GIT_CONFIG_KEY_${String(count)}`]: `url.${pathToFileURL(source).href}.insteadOf`,
      [`GIT_CONFIG_VALUE_${String(count)}`]: repository,
      [`GIT_CONFIG_KEY_${String(count + 1)}`]: "protocol.file.allow",
      [`GIT_CONFIG_VALUE_${String(count + 1)}`]: "always",
    });
    await commands.run(
      "install-cold-npm-exec",
      [
        npm.command,
        ...npm.prefix,
        "exec",
        "--yes",
        `--package=git+${repository}#${first}`,
        "--",
        "workbench",
        "install",
        "--user",
      ],
      root,
      { ...userEnv, npm_config_ignore_scripts: undefined },
    );
    assert.ok(
      existsSync(join(userBin, process.platform === "win32" ? "workbench.cmd" : "workbench")),
      "Installation must create the native user command",
    );
    await selected("install-user-default", root, userEnv, first);
    const consumer = await project("user-launcher", userEnv);
    return { first, second, consumer };
  });
  await scenarios.run(
    "installation-project-pin-and-offline-cache",
    async () => {
      const { first, second, consumer } = required(fixture, "Successful user launcher prerequisite");
      const config = join(consumer, "workbench/config.toml");
      const pin = (revision: string) => {
        const contents = readFileSync(config, "utf8"),
          values = parse(contents);
        values.tool = { repository, revision };
        writeFileSync(config, editToml(contents, values));
      };
      pin(second);
      const acquired = await selected("install-project-revision-B", consumer, userEnv, second);
      await task("project-pin", consumer, userEnv);
      await selected("install-default-still-A", root, userEnv, first);
      renameSync(source, join(root, "unavailable-source"));
      const offline = { ...userEnv, npm_config_offline: "true", WORKBENCH_OFFLINE: "1" };
      assert.equal(
        await selected("install-offline-project-B", join(consumer, "nested directory 雪"), offline, second),
        acquired,
        "Offline dispatch must reuse the acquired revision",
      );
      await selected("install-offline-default-A", root, offline, first);
      const tasks = join(consumer, "workbench/tasks"),
        before = readdirSync(tasks).sort();
      pin("f".repeat(40));
      const rejected = await commands.run(
        "install-missing-revision-rejected",
        consumerPathCommand(["record", "add", "task", "Must not be created"], offline),
        consumer,
        offline,
        true,
      );
      const diagnostic = consumerCommandDiagnostics(rejected).stderr;
      assert.ok(
        diagnostic.includes(repository) && diagnostic.includes("f".repeat(40)),
        "Rejection must identify the unavailable exact repository and revision",
      );
      assert.deepEqual(readdirSync(tasks).sort(), before, "An unavailable pin must not execute another revision");
      pin(second);
    },
    ["installation-user-launcher"],
  );
}
