import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { afterEach, expect, test } from "vitest";
import { consumerInstallationEnvironment, consumerPathCommand } from "../src/consumer-integration-installation.ts";
import { ConsumerCommands } from "../src/consumer-integration-runner.ts";
import { windowsBatchArgument } from "../src/windows-batch.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("installation fixtures isolate user homes and npm configuration without changing the caller", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-installation-env-"));
  roots.push(root);
  const base = {
    HOME: "/actual-home",
    USERPROFILE: "C:\\actual-home",
    APPDATA: "C:\\settings",
    npm_config_userconfig: "/actual-npmrc",
    GIT_CONFIG_COUNT: "4",
    PATH: "/selected-tools",
    GIT_AUTHOR_NAME: "Fixture",
  };
  const snapshot = { ...base },
    env = consumerInstallationEnvironment(root, base);
  expect(base).toEqual(snapshot);
  for (const name of [
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "WORKBENCH_CONFIG_HOME",
    "WORKBENCH_DATA_HOME",
    "WORKBENCH_CACHE_HOME",
    "WORKBENCH_STATE_HOME",
    "npm_config_cache",
    "npm_config_userconfig",
    "npm_config_globalconfig",
  ])
    expect(env[name]).toContain(root);
  expect(readFileSync(env.npm_config_userconfig ?? "", "utf8")).toBe("");
  expect(env.GIT_CONFIG_COUNT).toBe("4");
  expect(env.GIT_AUTHOR_NAME).toBe("Fixture");
  expect(env.PATH).toBe("/selected-tools");
});

test("PATH invocation uses the platform's executable or native command shim", () => {
  const args = ["init", "project with spaces 雪", "--records-only"];
  expect(consumerPathCommand(args, {}, "linux")).toEqual(["workbench", ...args]);
  expect(consumerPathCommand(args, {}, "darwin")).toEqual(["workbench", ...args]);
  expect(consumerPathCommand(args, { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32")).toEqual({
    command: [
      "C:\\Windows\\System32\\cmd.exe",
      "/d",
      "/s",
      "/c",
      `workbench.cmd ${args.map(windowsBatchArgument).join(" ")}`,
    ],
    windowsVerbatimArguments: true,
  });
});

test.skipIf(process.platform !== "win32")(
  "the native Windows batch shim preserves literal arguments through both parsers",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "workbench-shim space 雪-"));
    roots.push(root);
    writeFileSync(join(root, "echo.cjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
    writeFileSync(join(root, "workbench.cmd"), '@node "%~dp0echo.cjs" %*\r\n');
    const args = [
      "",
      "spaces and Unicode 雪",
      'embedded "quote"',
      "A&B|C<D>E",
      "^caret!bang",
      "%WORKBENCH_FIXTURE_EXPANSION%",
      "(group)",
      "trailing slash\\",
      'slash\\"quote',
    ];
    const env = {
      ...process.env,
      PATH: [root, process.env.PATH].join(delimiter),
      WORKBENCH_FIXTURE_EXPANSION: "must-remain-literal",
    };
    const commands = new ConsumerCommands(root, new AbortController().signal);
    const output = await commands.capture("literal-shim", consumerPathCommand(args, env), root, env);
    expect(JSON.parse(output)).toEqual(args);
  },
);

test("batch encoding handles empty arguments and protects shell syntax", () => {
  expect(windowsBatchArgument("")).toBe('""');
  expect(windowsBatchArgument("A&B")).toContain("^^^&");
  expect(windowsBatchArgument("trailing\\")).toContain("trailing\\\\");
  expect(windowsBatchArgument('a"b')).toContain('\\^^^"');
});
