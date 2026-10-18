import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { stringify } from "smol-toml";
import { afterEach, expect, test, vi } from "vitest";
import { configureDirenv, direnvWatchPaths } from "../src/direnv.ts";
import { buildPaths } from "../src/builds.ts";

const pathsOutput = (text: string) => (JSON.parse(text) as { variables: Record<string, string> }).variables;
const distribution = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
const initialConfig =
  'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[citations]\nlibrary_dir="library/citations"\n';
const hasDirenv = process.platform !== "win32" && spawnSync("direnv", ["version"]).status === 0;
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "workbench-direnv-")));
  temporary.push(base);
  const root = join(base, "project space's");
  const rust = join(root, "components/rust root");
  const python = join(root, "components/python");
  const config = join(base, "config");
  for (const directory of [join(root, "workbench"), rust, python, config]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, "workbench/config.toml"), initialConfig + '[checks]\nenvironment="native"\n');
  writeFileSync(
    join(root, "workbench/projects.toml"),
    stringify({
      project: [{ id: "widget", path: "." }],
      language_root: [
        { language: "typescript", path: "." },
        { language: "rust", path: "components/rust root" },
        { language: "python", path: "components/python" },
        { language: "javascript", path: "components/python" },
      ],
    }),
  );
  writeFileSync(join(config, "config.toml"), stringify({ storage: { external: true, root: join(base, "cache") } }));
  vi.stubEnv("WORKBENCH_CONFIG_HOME", config);
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(base, "cache"));
  vi.stubEnv("WORKBENCH_PROJECT_ROOT", root);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  vi.stubEnv("WORKBENCH_LOCAL_CONFIG_ROOT", undefined);
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", undefined);
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", undefined);
  const env = { ...process.env };
  for (const name of Object.keys(env).filter((key) => key.startsWith("DIRENV_"))) Reflect.deleteProperty(env, name);
  Object.assign(env, {
    DIRENV_CONFIG: join(base, "direnv"),
    DIRENV_LOG_FORMAT: "",
    WORKBENCH_TEST_NODE: process.execPath,
    WORKBENCH_TEST_CLI: join(distribution, "bundle/main.cjs"),
  });
  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "workbench"), '#!/bin/sh\nexec "$WORKBENCH_TEST_NODE" "$WORKBENCH_TEST_CLI" "$@"\n', {
    mode: 0o755,
  });
  env.PATH = `${bin}${delimiter}${String(env.PATH)}`;
  // A pipe on stdin can make Bash load host startup files as a remote shell.
  // These fixtures supply no input and must keep the declared tool environment.
  const run = (command: string, args: readonly string[], cwd = root) =>
    spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ok = (command: string, args: readonly string[], cwd = root) => {
    const result = run(command, args, cwd);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const cli = (...args: string[]) => ok(process.execPath, [required(env.WORKBENCH_TEST_CLI, "Fixture CLI"), ...args]);
  const activate = () => {
    for (const directory of [root, rust, python]) ok("direnv", ["allow", directory]);
  };
  return { base, root, rust, python, config, bin, env, run, ok, cli, activate };
}

test("direnv setup is opt-in and composes once per build root, preserving custom code and personal files", () => {
  const { root, rust, python } = fixture();
  const before = 'export SHARED="existing"\nwatch_file .envrc.local\nsource_env_if_exists .envrc.local\n';
  const nestedBefore = "source_up\nsource_env_if_exists .envrc.local\n";
  const personal = 'export PERSONAL="kept verbatim"\n';
  writeFileSync(join(root, ".envrc"), before);
  writeFileSync(join(rust, ".envrc"), nestedBefore);
  writeFileSync(join(root, ".envrc.local"), personal);
  writeFileSync(join(root, ".gitignore"), "# Existing ignores\nprivate/\n");
  if (process.platform !== "win32") chmodSync(join(root, ".envrc"), 0o640);
  configureDirenv(root);
  expect(readFileSync(join(root, ".envrc.local"), "utf8")).toBe(personal);
  const hook = readFileSync(join(root, ".envrc"), "utf8");
  expect(hook.replace(/# >>> Workbench direnv >>>[\s\S]*?# <<< Workbench direnv <<<\n\n/, "")).toBe(before);
  expect(
    readFileSync(join(rust, ".envrc"), "utf8").replace(
      /# >>> Workbench direnv >>>[\s\S]*?# <<< Workbench direnv <<<\n\n/,
      "",
    ),
  ).toBe(nestedBefore);
  const snapshots = [root, rust, python].flatMap((directory) =>
    [".envrc", ".envrc.local"].map((name) => [join(directory, name), readFileSync(join(directory, name))] as const),
  );
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  expect(ignore).toBe("# Existing ignores\nprivate/\n.direnv/\n.envrc.local\n");
  configureDirenv(root);
  for (const [path, contents] of snapshots) expect(readFileSync(path)).toEqual(contents);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(ignore);
  if (process.platform !== "win32") {
    expect(statSync(join(root, ".envrc")).mode & 0o777).toBe(0o640);
    expect(statSync(join(rust, ".envrc.local")).mode & 0o777).toBe(0o600);
  }
});

test.each([
  "# >>> Workbench direnv >>>\nmissing end\n",
  "# <<< Workbench direnv <<<\n",
  "# >>> Workbench direnv >>>\n# <<< Workbench direnv <<<\n# <<< Workbench direnv <<<\n",
  "if test -f .envrc.local; then source .envrc.local; fi\n",
])("ambiguous existing hooks fail before modifying any root (%s)", (contents) => {
  const { root, python } = fixture();
  writeFileSync(join(python, ".envrc"), contents);
  expect(() => {
    configureDirenv(root);
  }).toThrow(/direnv block|separate/);
  expect(existsSync(join(root, ".envrc"))).toBe(false);
  expect(existsSync(join(root, ".envrc.local"))).toBe(false);
  expect(existsSync(join(root, ".gitignore"))).toBe(false);
  expect(readFileSync(join(python, ".envrc"), "utf8")).toBe(contents);
});

test.each([".envrc", ".envrc.local", ".gitignore"])("setup rejects non-files at %s before writing hooks", (name) => {
  const { root } = fixture();
  mkdirSync(join(root, name));
  expect(() => {
    configureDirenv(root);
  }).toThrow(/regular file/);
  expect(existsSync(join(root, "components/rust root/.envrc"))).toBe(false);
});

test.skipIf(process.platform === "win32").each([".envrc", ".envrc.local", ".gitignore"])(
  "setup rejects redirected %s without writing to another location",
  (name) => {
    const { base, root } = fixture();
    const target = join(base, "outside");
    writeFileSync(target, "preserve\n");
    symlinkSync(target, join(root, name));
    expect(() => {
      configureDirenv(root);
    }).toThrow(/real project path/);
    expect(readFileSync(target, "utf8")).toBe("preserve\n");
    expect(existsSync(join(root, "components/rust root/.envrc"))).toBe(false);
  },
);

test("direnv watches use the selected container definition and the same tool inputs as build identity", () => {
  const { root } = fixture();
  writeFileSync(
    join(root, "workbench/config.toml"),
    initialConfig +
      '[development]\ndefault="custom"\n[[development.profiles]]\nname="custom"\nbuilder="native"\nworkspace="devcontainer"\ncontainer_config=".devcontainer/custom/devcontainer.json"\n',
  );
  const paths = buildPaths(root, root, "devcontainer", {}, false);
  const watches = direnvWatchPaths(root, paths);
  expect(watches).toContain(join(root, ".devcontainer/custom/devcontainer.json"));
  expect(watches).toContain(join(root, ".devcontainer/custom/Dockerfile"));
  expect(watches).not.toContain(join(root, ".devcontainer/Dockerfile"));
  mkdirSync(join(root, ".devcontainer/custom"), { recursive: true });
  writeFileSync(join(root, ".devcontainer/custom/Dockerfile"), "FROM example\n");
  expect(buildPaths(root, root, "devcontainer", {}, false).identity.fingerprint).not.toBe(paths.identity.fingerprint);
});

test("the setup CLI only creates hooks when requested and derives completion from the option", () => {
  const { root, cli, run, env } = fixture();
  expect(cli("complete", "--", "setup", "--d")).toBe("--direnv");
  cli("setup-project", root);
  expect(existsSync(join(root, ".envrc"))).toBe(false);
  expect(existsSync(join(root, ".envrc.local"))).toBe(false);
  writeFileSync(join(root, "workbench/CHARTER.md"), "Fixture project intent.\n");
  const init = run("git", ["init", "--quiet"]);
  expect(init.status, init.stderr).toBe(0);
  cli("setup", "--direnv");
  expect(existsSync(join(root, ".envrc"))).toBe(true);
  const invalid = run(process.execPath, [
    required(env.WORKBENCH_TEST_CLI, "Fixture CLI"),
    "paths",
    "--shell",
    "--direnv",
  ]);
  expect(invalid.status).not.toBe(0);
  expect(invalid.stderr).toMatch(/not both/);
});

test.skipIf(!hasDirenv)("real direnv switches independent roots and restores their own settings", () => {
  const { root, rust, python, ok, activate, cli } = fixture();
  writeFileSync(join(root, ".envrc"), 'export ROOT_ONLY="from parent"\n');
  writeFileSync(join(rust, ".envrc.local"), 'export PERSONAL="rust override"\nexport RUST_ONLY="present"\n');
  writeFileSync(join(python, ".envrc.local"), 'export PERSONAL="python override"\n');
  configureDirenv(root);
  activate();
  const result = ok("bash", [
    "--noprofile",
    "--norc",
    "-eu",
    "-c",
    `
for directory in "$1" "$2" "$3" "$1"; do
  cd "$directory"
  exports=$(direnv export bash)
  eval "$exports"
  "$WORKBENCH_TEST_NODE" -e 'console.log(JSON.stringify({cargo:process.env.CARGO_TARGET_DIR,pnpm:process.env.PNPM_CONFIG_VIRTUAL_STORE_DIR,venv:process.env.UV_PROJECT_ENVIRONMENT,personal:process.env.PERSONAL,rootOnly:process.env.ROOT_ONLY,rustOnly:process.env.RUST_ONLY}))'
done
`,
    "direnv-test",
    root,
    rust,
    python,
  ]);
  const [initialRoot, first, second, restoredRoot] = result
    .split("\n")
    .map((text) => JSON.parse(text) as Record<string, string>);
  expect(initialRoot).toEqual({
    pnpm: pathsOutput(cli("paths")).PNPM_CONFIG_VIRTUAL_STORE_DIR,
    rootOnly: "from parent",
  });
  expect(first).toEqual({
    cargo: pathsOutput(cli("paths", "--path", "components/rust root")).CARGO_TARGET_DIR,
    personal: "rust override",
    rustOnly: "present",
  });
  expect(second).toEqual({
    pnpm: pathsOutput(cli("paths", "--path", "components/python")).PNPM_CONFIG_VIRTUAL_STORE_DIR,
    venv: pathsOutput(cli("paths", "--path", "components/python")).UV_PROJECT_ENVIRONMENT,
    personal: "python override",
  });
  expect(restoredRoot).toEqual(initialRoot);
  const explicit = ok("direnv", ["exec", rust, process.execPath, "-e", "console.log(process.env.CARGO_TARGET_DIR)"]);
  expect(explicit).toBe(required(first, "Rust environment").cargo);
});

test.skipIf(!hasDirenv)("real direnv reloads storage preferences and tool inputs without an explicit reload", () => {
  const { base, root, rust, ok, activate, env } = fixture();
  configureDirenv(root);
  activate();
  env.WORKBENCH_TEST_CONFIG = join(base, "config/config.toml");
  env.WORKBENCH_TEST_CACHE = join(base, "new cache");
  const result = ok("bash", [
    "--noprofile",
    "--norc",
    "-eu",
    "-c",
    `
cd "$1"
exports=$(direnv export bash)
eval "$exports"
printf '%s\n' "$CARGO_TARGET_DIR"
# Direnv tracks modification times in seconds; advance them without relying on sleeps.
"$WORKBENCH_TEST_NODE" -e 'const fs=require("fs"), path=process.env.WORKBENCH_TEST_CONFIG, time=Math.floor(fs.statSync(path).mtimeMs/1000)+2; fs.writeFileSync(path,"[storage]\\nexternal=true\\nroot="+JSON.stringify(process.env.WORKBENCH_TEST_CACHE)+"\\n"); fs.utimesSync(path,time,time)'
exports=$(direnv export bash)
eval "$exports"
printf '%s\n' "$CARGO_TARGET_DIR"
printf 'changed tool inputs\n' > Cargo.lock
exports=$(direnv export bash)
eval "$exports"
printf '%s\n' "$CARGO_TARGET_DIR"
"$WORKBENCH_TEST_NODE" -e 'const fs=require("fs"), path=process.env.WORKBENCH_TEST_CONFIG, time=Math.floor(fs.statSync(path).mtimeMs/1000)+2; fs.writeFileSync(path,"[storage]\\nexternal=false\\n"); fs.utimesSync(path,time,time)'
exports=$(direnv export bash)
eval "$exports"
"$WORKBENCH_TEST_NODE" -e 'console.log(process.env.CARGO_TARGET_DIR ?? "unset")'
`,
    "direnv-test",
    rust,
  ]);
  const [first, second, third, fourth] = result.split("\n");
  expect(first).toContain(join(base, "cache"));
  expect(second).toContain(join(base, "new cache"));
  expect(third).toContain(join(base, "new cache"));
  expect(third).not.toBe(second);
  expect(fourth).toBe("unset");
});

test.skipIf(!hasDirenv)("roots can explicitly share settings without loading the parent root's environment", () => {
  const { root, rust, python, ok, activate, cli } = fixture();
  writeFileSync(join(root, ".envrc.shared"), 'export SHARED="common setting"\n');
  writeFileSync(join(root, ".envrc"), 'source_env .envrc.shared\nexport ROOT_ONLY="parent"\n');
  writeFileSync(join(root, ".envrc.local"), 'export SHARED="parent personal setting"\n');
  for (const directory of [rust, python]) writeFileSync(join(directory, ".envrc"), "source_env ../../.envrc.shared\n");
  writeFileSync(join(rust, ".envrc.local"), 'export SHARED="Rust personal setting"\n');
  configureDirenv(root);
  activate();
  const inspect = (directory: string): unknown =>
    JSON.parse(
      ok("direnv", [
        "exec",
        directory,
        process.execPath,
        "-e",
        "console.log(JSON.stringify({cargo:process.env.CARGO_TARGET_DIR,venv:process.env.UV_PROJECT_ENVIRONMENT,shared:process.env.SHARED,rootOnly:process.env.ROOT_ONLY}))",
      ]),
    );
  expect(inspect(rust)).toEqual({
    cargo: pathsOutput(cli("paths", "--path", "components/rust root")).CARGO_TARGET_DIR,
    shared: "Rust personal setting",
  });
  expect(inspect(python)).toEqual({
    venv: pathsOutput(cli("paths", "--path", "components/python")).UV_PROJECT_ENVIRONMENT,
    shared: "common setting",
  });
});

test.skipIf(!hasDirenv)("repository example hooks add the launcher directly without loading the parent hook", () => {
  const { root, rust, bin, env, ok, cli } = fixture();
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/workbench"), readFileSync(join(bin, "workbench")), { mode: 0o755 });
  writeFileSync(join(root, ".envrc"), 'export ROOT_ONLY="parent"\n');
  writeFileSync(
    join(rust, ".envrc"),
    readFileSync(join(distribution, "examples/languages/rust/.envrc"), "utf8").replace("../../../bin", "../../bin"),
  );
  env.PATH = required(env.PATH, "Expected fixture value: env.PATH")
    .split(delimiter)
    .filter((entry) => entry !== bin)
    .join(delimiter);
  configureDirenv(root);
  ok("direnv", ["allow", rust]);
  const result: unknown = JSON.parse(
    ok("direnv", [
      "exec",
      rust,
      process.execPath,
      "-e",
      'console.log(JSON.stringify({cargo:process.env.CARGO_TARGET_DIR,pnpm:process.env.PNPM_CONFIG_VIRTUAL_STORE_DIR,rootOnly:process.env.ROOT_ONLY,firstPath:process.env.PATH.split(require("node:path").delimiter)[0]}))',
    ]),
  );
  expect(result).toEqual({
    cargo: pathsOutput(cli("paths", "--path", "components/rust root")).CARGO_TARGET_DIR,
    firstPath: join(root, "bin"),
  });
});

test.skipIf(!hasDirenv)(
  "a failed Workbench export never evaluates partial output or executes the requested command",
  () => {
    const { root, bin, run, activate } = fixture();
    configureDirenv(root);
    activate();
    writeFileSync(
      join(bin, "workbench"),
      '#!/bin/sh\nprintf "%s\\n" "export WORKBENCH_TEST_UNEXPECTED=partial"\nexit 42\n',
      { mode: 0o755 },
    );
    const result = run("direnv", ["exec", root, process.execPath, "-e", 'console.log("command executed")']);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("command executed");
  },
);
