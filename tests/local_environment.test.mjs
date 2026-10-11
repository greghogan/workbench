import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";

const distribution = resolve(import.meta.dirname, "..");
const temporary = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("temporary staged checks discard their external products while retaining working files", () => {
  const { root, web, ok } = fixture();
  writeFileSync(
    join(web, "check.cjs"),
    'const fs = require("node:fs"); fs.writeFileSync(process.env.WORKBENCH_BUILD_DIR + "/product", "built"); fs.writeFileSync("result", process.env.WORKBENCH_BUILD_DIR);',
  );
  vi.stubEnv("WORKBENCH_EPHEMERAL_CHECKOUT", "1");
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  ok("checks", "run", "--role", "test", "--environment", "native");
  expect(existsSync(readFileSync(join(web, "result"), "utf8"))).toBe(false);
  expect(existsSync(join(root, "workbench/config.toml"))).toBe(true);
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-local-")));
  temporary.push(root);
  const web = join(root, "web");
  const bin = join(root, "tools");
  const selected = join(root, "selected-tools");
  for (const path of [web, bin, selected]) mkdirSync(path);
  const invoke = (...args) =>
    spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        WORKBENCH_PROJECT_ROOT: root,
        WORKBENCH_DISTRIBUTION_ROOT: distribution,
        WORKBENCH_LOCAL_CONFIG_ROOT: undefined,
        WORKBENCH_SHELL_ENVIRONMENT: undefined,
        WORKBENCH_SHELL_ROOT: undefined,
      },
    });
  const ok = (...args) => {
    const result = invoke(...args);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result;
  };
  ok("setup-project", root);
  copyFileSync(join(distribution, "workbench/CHARTER.md"), join(root, "workbench/CHARTER.md"));
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="web"\n',
  );
  const config = join(root, "workbench/config.toml");
  writeFileSync(
    config,
    readFileSync(config, "utf8") + '\n[[check]]\nname="web"\nrole="test"\npath="web"\ncommand=["node", "check.cjs"]\n',
  );
  writeFileSync(join(web, ".node-version"), process.versions.node);
  writeFileSync(
    join(web, "check.cjs"),
    'require("node:fs").writeFileSync("result", process.env.WORKBENCH_SHELL_ENVIRONMENT || "host");\n',
  );
  for (const path of ["flake.nix", "flake.lock"]) writeFileSync(join(web, path), "{}\n");
  ok("sync");
  const local = (text) => writeFileSync(join(root, "workbench/local.toml"), text);
  const script = (path, body) => {
    writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
  };
  return { root, web, bin, selected, invoke, ok, local, script };
}

test("local selection is narrow, explicit commands override it, and setup ignores the preference", () => {
  const { root, web, invoke, ok, local } = fixture();
  local('[checks]\nenvironment="guix"\n');
  // No channels/manifest exist: a local selection must fail rather than fall back to native tools.
  expect(invoke("checks", "run").status).not.toBe(0);
  expect(existsSync(join(web, "result"))).toBe(false);
  ok("checks", "run", "--environment", "native");
  expect(readFileSync(join(web, "result"), "utf8")).toBe("host");
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["check-ignore", "workbench/local.toml"], { cwd: root }).status).toBe(0);
  for (const text of [
    '[checks]\nenvironment="none"\n',
    '[checks]\nenvironment="nix-docker"\n',
    '[checks]\nenvironment="native"\ncommand=["false"]\n',
    "[ci]\nenvironments=[]\n",
  ]) {
    local(text);
    rmSync(join(web, "result"));
    expect(invoke("checks", "run", "--role", "test").status).not.toBe(0);
    expect(existsSync(join(web, "result"))).toBe(false);
    expect(invoke("checks", "run", "--role", "test", "--environment", "native").status).not.toBe(0);
    expect(existsSync(join(web, "result"))).toBe(false);
    local('[checks]\nenvironment="guix"\n');
    ok("checks", "run", "--role", "test", "--environment", "native");
  }
});

test("native shell commands retain literal arguments, working files, and the selected context", () => {
  const { web, ok, local } = fixture();
  local('[checks]\nenvironment="native"\n');
  const literal = "$(touch unwanted); ' quoted";
  ok(
    "shell",
    "--path",
    "web",
    "--",
    "node",
    "-e",
    'require("node:fs").writeFileSync("argument", process.argv[1]);',
    literal,
  );
  expect(readFileSync(join(web, "argument"), "utf8")).toBe(literal);
  expect(existsSync(join(web, "unwanted"))).toBe(false);
  ok("shell", "--path", "web", "--", "bash", "-c", "workbench checks run --role test --path web");
  expect(readFileSync(join(web, "result"), "utf8")).toBe("native");
});

test.skipIf(process.platform === "win32")(
  "managed shells reuse selected tools and reject switching or crossing roots",
  () => {
    const { root, web, bin, selected, ok, invoke, local, script } = fixture();
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    script(
      join(bin, "nix"),
      `echo entered >> ${quote(join(root, "entries"))}\nwhile [ "$1" != --command ]; do shift; done\nshift\nexport PATH=${quote(selected)}:$PATH\nexec "$@"`,
    );
    script(
      join(selected, "node"),
      `if [ "$1" = --version ]; then echo v99.0.0; else exec ${quote(process.execPath)} "$@"; fi`,
    );
    local('[checks]\nenvironment="nix"\n');
    ok("shell", "--path", "web", "--", "bash", "-c", "workbench checks run --role test --path web");
    expect(readFileSync(join(web, "result"), "utf8")).toBe("nix");
    expect(readFileSync(join(root, "entries"), "utf8")).toBe("entered\n");
    rmSync(join(web, "result"));
    const failure = invoke(
      "shell",
      "--path",
      "web",
      "--",
      "bash",
      "-c",
      "workbench checks run --role test --environment native",
    );
    expect(failure.status).not.toBe(0);
    expect(failure.stderr).toMatch(/exit it before/);
    expect(existsSync(join(web, "result"))).toBe(false);
    const config = join(root, "workbench/config.toml");
    writeFileSync(
      config,
      readFileSync(config, "utf8") +
        '\n[[check]]\nname="other root"\nrole="test"\npath="."\ncommand=["node", "-e", "process.exit(7)"]\n',
    );
    const other = invoke("shell", "--path", "web", "--", "bash", "-c", "workbench checks run --role test");
    expect(other.status).not.toBe(0);
    expect(other.stderr).toMatch(/exit it before/);
    expect(existsSync(join(web, "result"))).toBe(false);
  },
);
