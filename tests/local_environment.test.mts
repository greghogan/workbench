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
const temporary: string[] = [];
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
  ok("check", "--role", "test", "--environment", "native");
  expect(existsSync(readFileSync(join(web, "result"), "utf8"))).toBe(false);
  expect(existsSync(join(root, "workbench/config.toml"))).toBe(true);
});

test("staged native checks select their own pnpm storage while retaining the caller's shell context", () => {
  const { root, web } = fixture();
  copyFileSync(join(distribution, ".pnpmfile.cjs"), join(web, ".pnpmfile.cjs"));
  writeFileSync(
    join(web, "check.cjs"),
    `require("node:fs").writeFileSync("result", JSON.stringify({
  shellRoot: process.env.WORKBENCH_SHELL_ROOT,
  storageProject: process.env.WORKBENCH_STORAGE_PROJECT,
  storage: require("./.pnpmfile.cjs").hooks.updateConfig({}),
}));\n`,
  );
  const result = spawnSync(
    process.execPath,
    [join(distribution, "bundle/main.cjs"), "check", "--role", "test", "--environment", "native"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        WORKBENCH_PROJECT_ROOT: root,
        WORKBENCH_DISTRIBUTION_ROOT: distribution,
        WORKBENCH_LOCAL_CONFIG_ROOT: undefined,
        WORKBENCH_SHELL_ENVIRONMENT: "native",
        WORKBENCH_SHELL_ROOT: root,
        WORKBENCH_STORAGE_PROJECT: root,
        WORKBENCH_STORAGE_EXTERNAL: "true",
        WORKBENCH_EPHEMERAL_CHECKOUT: "1",
      },
    },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const received = JSON.parse(readFileSync(join(web, "result"), "utf8")) as {
    shellRoot: string;
    storageProject: string;
    storage: { virtualStoreType: string; storeDir: string; virtualStoreDir: string };
  };
  expect(received.shellRoot).toBe(root);
  expect(received.storageProject).toBe(web);
  expect(received.storage.virtualStoreType).toBe("project");
  expect(existsSync(received.storage.storeDir)).toBe(true);
  expect(existsSync(received.storage.virtualStoreDir)).toBe(false);
  expect(existsSync(join(root, "workbench/config.toml"))).toBe(true);
});

test.skipIf(process.platform === "win32").each([false, true])(
  "Nix Docker receives artifact paths in its selected writable storage (external: %s)",
  (external) => {
    const { root, web, bin, ok } = fixture();
    const output = join(root, "runtime-exports.json");
    const docker = join(bin, "docker");
    writeFileSync(
      docker,
      `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const exports = Object.fromEntries(args.slice(args.lastIndexOf('env') + 1).filter(value => /^[A-Z_]+=/.test(value)).map(value => {
  const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)];
}));
writeFileSync(process.env.TEST_RUNTIME_EXPORTS, JSON.stringify(exports));
const command = args.slice(args.lastIndexOf('sh'));
const child = spawnSync(command[0], command.slice(1), {
  stdio: 'inherit',
  env: {...process.env, ...exports, WORKBENCH_BUILD_DIR: process.cwd() + '/fake-build'},
});
process.exit(child.status ?? 1);\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("WORKBENCH_CI_DOCKER", docker);
    vi.stubEnv("TEST_RUNTIME_EXPORTS", output);
    vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", String(external));
    ok("check", "--role", "test", "--environment", "nix-docker");
    expect(existsSync(join(web, "result"))).toBe(true);
    const received = JSON.parse(readFileSync(output, "utf8")) as Record<string, string>;
    const paths = JSON.parse(ok("paths", "--path", "web", "--environment", "nix-docker").stdout) as {
      directory: string;
    };
    expect(received.WORKBENCH_DIST_DIR).toBe(external ? join(paths.directory, "dist") : "/work/web/dist");
    expect(received.WORKBENCH_BUILD_DIR).toBe(external ? paths.directory : "/work/web/build");
    expect(received.WORKBENCH_STORAGE_PROJECT).toBe("/work/web");
  },
);

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-local-")));
  temporary.push(root);
  const web = join(root, "web");
  const bin = join(root, "tools");
  const selected = join(root, "selected-tools");
  for (const path of [web, bin, selected]) mkdirSync(path);
  const invoke = (...args: string[]) =>
    spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${String(process.env.PATH)}`,
        WORKBENCH_PROJECT_ROOT: root,
        WORKBENCH_DISTRIBUTION_ROOT: distribution,
        WORKBENCH_LOCAL_CONFIG_ROOT: undefined,
        WORKBENCH_SHELL_ENVIRONMENT: undefined,
        WORKBENCH_SHELL_ROOT: undefined,
      },
    });
  const ok = (...args: string[]) => {
    const result = invoke(...args);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result;
  };
  ok("setup-project", root);
  copyFileSync(resolve(import.meta.dirname, "fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
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
  const local = (text: string | NodeJS.ArrayBufferView) => {
    writeFileSync(join(root, "workbench/local.toml"), text);
  };
  const script = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
  };
  return { root, web, bin, selected, invoke, ok, local, script };
}

test("local selection is narrow, explicit commands override it, and setup ignores the preference", () => {
  const { root, web, invoke, ok, local } = fixture();
  local('[checks]\nenvironment="guix"\n');
  // No channels/manifest exist: a local selection must fail rather than fall back to native tools.
  expect(invoke("pre-commit").status).not.toBe(0);
  expect(existsSync(join(web, "result"))).toBe(false);
  ok("check", "--environment", "native");
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
    expect(invoke("check", "--role", "test").status).not.toBe(0);
    expect(existsSync(join(web, "result"))).toBe(false);
    expect(invoke("check", "--role", "test", "--environment", "native").status).not.toBe(0);
    expect(existsSync(join(web, "result"))).toBe(false);
    local('[checks]\nenvironment="guix"\n');
    ok("check", "--role", "test", "--environment", "native");
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
  ok("shell", "--path", "web", "--", "bash", "-c", "workbench check --role test --path web");
  expect(readFileSync(join(web, "result"), "utf8")).toBe("native");
});

test.each(["plain", "no-color"])(
  "%s presentation survives a prepared shell without becoming check-environment input",
  (mode) => {
    vi.stubEnv("WORKBENCH_PLAIN", "0");
    vi.stubEnv("NO_COLOR", mode === "no-color" ? "0" : "");
    const { web, ok, local } = fixture();
    local('[checks]\nenvironment="native"\n');
    ok(
      ...(mode === "plain" ? ["--plain"] : []),
      "shell",
      "--path",
      "web",
      "--",
      "node",
      "-e",
      'require("node:fs").writeFileSync("presentation.json",JSON.stringify({plain:process.env.WORKBENCH_PLAIN,noColor:process.env.NO_COLOR}));',
    );
    expect(JSON.parse(readFileSync(join(web, "presentation.json"), "utf8"))).toEqual({
      plain: mode === "plain" ? "1" : "0",
      noColor: "1",
    });
  },
);

test.skipIf(process.platform === "win32")(
  "managed shells reuse selected tools and reject switching or crossing roots",
  () => {
    const { root, web, bin, selected, ok, invoke, local, script } = fixture();
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    script(
      join(bin, "nix"),
      `echo entered >> ${quote(join(root, "entries"))}\nwhile [ "$1" != --command ]; do shift; done\nshift\nexport PATH=${quote(selected)}:$PATH\nexec "$@"`,
    );
    script(
      join(selected, "node"),
      `if [ "$1" = --version ]; then echo v99.0.0; else exec ${quote(process.execPath)} "$@"; fi`,
    );
    local('[checks]\nenvironment="nix"\n');
    ok("shell", "--path", "web", "--", "bash", "-c", "workbench check --role test --path web");
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
      "workbench check --role test --environment native",
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
    const other = invoke("shell", "--path", "web", "--", "bash", "-c", "workbench check --role test");
    expect(other.status).not.toBe(0);
    expect(other.stderr).toMatch(/exit it before/);
    expect(existsSync(join(web, "result"))).toBe(false);
  },
);

test.skipIf(process.platform === "win32")(
  "Guix shell bootstrap retains its selected runtime when entry clears the host variable",
  () => {
    const { root, web, bin, ok, local, script } = fixture();
    writeFileSync(join(root, "channels.scm"), "fixture\n");
    writeFileSync(join(web, "manifest.scm"), "fixture\n");
    script(
      join(bin, "guix"),
      `while [ "$1" != shell ]; do shift; done
shift
while [ "$1" != -- ]; do shift; done
shift
unset WORKBENCH_DISTRIBUTION_ROOT
exec "$@"`,
    );
    local('[checks]\nenvironment="guix"\n');
    ok("shell", "--path", "web", "--", "bash", "-c", "workbench check --role test --path web");
    expect(readFileSync(join(web, "result"), "utf8")).toBe("guix");
  },
);
