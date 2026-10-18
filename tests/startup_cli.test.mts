import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { stringify } from "smol-toml";
import { synchronize } from "../src/sync.ts";

const distribution = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function nodeAt(destination: string) {
  mkdirSync(join(destination, ".."), { recursive: true });
  try {
    linkSync(process.execPath, destination);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !["EXDEV", "EPERM", "EACCES"].includes(String(error.code)))
      throw error;
    copyFileSync(process.execPath, destination, constants.COPYFILE_FICLONE);
  }
}

test.each([
  { projectPin: false, bootstrap: false },
  { projectPin: true, bootstrap: false },
  { projectPin: false, bootstrap: true },
])("startup uses a capable runtime while check roots select their own pins: %j", ({ projectPin, bootstrap }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-startup-cli-")));
  temporary.push(root);
  const installed = join(root, "distribution");
  for (const directory of ["bin", "bundle"])
    cpSync(join(distribution, directory), join(installed, directory), { recursive: true });
  for (const directory of ["scripts", "languages"]) mkdirSync(join(installed, directory), { recursive: true });
  mkdirSync(join(root, "workbench"));
  writeFileSync(join(installed, "languages/index.toml"), "schema_version=1\nlanguages=[]\n");
  writeFileSync(join(installed, ".node-version"), projectPin || bootstrap ? process.versions.node : "99.0.0");
  if (projectPin) writeFileSync(join(root, ".node-version"), process.versions.node);
  const digest = "a".repeat(64),
    platform = `${process.platform}-${process.arch}`;
  writeFileSync(
    join(installed, "scripts/native-assets.json"),
    JSON.stringify({
      node: {
        [process.versions.node]: {
          [platform]: {
            url: "https://example.invalid/node.tar.gz",
            sha256: digest,
            format: "tar",
            strip: 1,
            bin: "bin",
            authenticationUnavailable: {
              reason: "Synthetic installed test SDK",
              source: "https://example.invalid",
              checked: "2026-10-18",
            },
          },
        },
      },
    }),
  );
  const cache = join(root, "cache"),
    installation = join(cache, "toolchains/node", process.versions.node, platform, digest.slice(0, 16));
  const node = process.platform === "win32" ? "node.exe" : "node";
  const selected = join(installation, "bin", node),
    runtime = join(root, "installed-node", node);
  nodeAt(runtime);
  if (projectPin || bootstrap) {
    nodeAt(selected);
    writeFileSync(join(installation, ".workbench-artifact"), digest + "\n");
  }
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="fixture"\npath="."\n');
  const resultFile = join(root, "result.json");
  writeFileSync(
    join(root, "workbench/config.toml"),
    stringify({
      schema_version: 1,
      markdown: { wrap_width: 120 },
      compatibility: { required: false },
      citations: { library_dir: "library/citations" },
      check: [
        {
          name: "Fixture check",
          role: "test",
          command: [
            "node",
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({runtime:process.execPath,argument:process.argv[1]}))`,
            "C:\\users\\literal $HOME 'quoted' and spaces",
          ],
        },
      ],
    }),
  );
  cpSync(resolve(import.meta.dirname, "fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
  expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);
  synchronize(root, false);
  const trace = join(root, "trace.jsonl"),
    preload = join(root, "trace.cjs");
  writeFileSync(
    preload,
    `${bootstrap ? `if(process.execPath===${JSON.stringify(runtime)}) Object.defineProperty(process.versions,'node',{value:'18.20.8'});` : ""}
require('node:fs').appendFileSync(${JSON.stringify(trace)},JSON.stringify({runtime:process.execPath,argv:process.argv.slice(1)})+'\\n');`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKBENCH_CACHE_HOME: cache,
    WORKBENCH_DATA_HOME: join(root, "data"),
    WORKBENCH_STATE_HOME: join(root, "state"),
    WORKBENCH_CONFIG_HOME: join(root, "config"),
    WORKBENCH_STORAGE_EXTERNAL: "false",
    NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
  };
  for (const name of [
    "WORKBENCH_COMPATIBILITY_RUNTIME",
    "WORKBENCH_COMPATIBILITY_VERSION",
    "GUIX_ENVIRONMENT",
    "IN_NIX_SHELL",
    "WORKBENCH_SHELL_ENVIRONMENT",
    "WORKBENCH_SHELL_ROOT",
    "WORKBENCH_PROJECT_ROOT",
    "WORKBENCH_DISTRIBUTION_ROOT",
    "WORKBENCH_PREPARED",
    "WORKBENCH_DEVCONTAINER",
  ])
    Reflect.deleteProperty(env, name);
  const result = spawnSync(runtime, [join(installed, "bin/workbench.mjs"), "check", "--role", "test", "--no-cache"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const launches = readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { argv: string[]; runtime: string });
  const cli = launches.filter((entry) => entry.argv[0] === join(installed, "bin/workbench.mjs"));
  expect(cli.map((entry) => entry.runtime)).toEqual(bootstrap ? [runtime, selected, selected] : [runtime, runtime]);
  expect(required(cli.at(-1), "Expected fixture value").argv[1]).toBe("checks-session");
  expect(JSON.parse(readFileSync(resultFile, "utf8"))).toEqual({
    runtime: projectPin || bootstrap ? selected : runtime,
    argument: "C:\\users\\literal $HOME 'quoted' and spaces",
  });
  if (!projectPin && !bootstrap) expect(existsSync(join(cache, "toolchains/node"))).toBe(false);
});
