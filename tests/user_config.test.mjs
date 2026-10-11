import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";

const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "workbench-user-config-"));
  temporary.push(directory);
  const config = join(directory, "global/config.toml");
  const env = {
    ...process.env,
    WORKBENCH_CONFIG_HOME: join(directory, "global"),
    WORKBENCH_CACHE_HOME: join(directory, "cache"),
    WORKBENCH_PROJECT_ROOT: join(directory, "project"),
  };
  mkdirSync(env.WORKBENCH_PROJECT_ROOT);
  const run = (...args) =>
    spawnSync(process.execPath, [resolve("bundle/main.cjs"), ...args], {
      cwd: env.WORKBENCH_PROJECT_ROOT,
      env,
      encoding: "utf8",
    });
  const ok = (...args) => {
    const result = run(...args);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  return { directory, config, env, run, ok };
}

test("global configuration inspects defaults without initialization and round-trips validated changes", () => {
  const { config, directory, run, ok } = fixture();
  expect(ok("config", "get", "storage.external")).toBe("false");
  expect(ok("config")).toMatch(/\| SCOPE\s+\| SECTION\s+\| KEY\s+\| VALUE/);
  expect(existsSync(config)).toBe(false);
  ok("config", "set", "storage.external", "true");
  const root = join(directory, "fast disk");
  ok("config", "set", "storage.root", root);
  expect(ok("config", "get", "storage.external")).toBe("true");
  expect(ok("config", "get", "storage.root")).toBe(root);
  const before = readFileSync(config, "utf8");
  for (const args of [
    ["storage.external", "yes"],
    ["storage.root", "relative"],
    ["storage.unknown", "true"],
  ])
    expect(run("config", "set", ...args).status).not.toBe(0);
  expect(readFileSync(config, "utf8")).toBe(before);
  ok("config", "unset", "storage.external");
  expect(ok("config", "get", "storage.external")).toBe("false");
  expect(ok("config", "get", "storage.root")).toBe(root);
  writeFileSync(config, "[storage]\nunknown=true\n");
  expect(run("config", "set", "storage.external", "true").status).not.toBe(0);
  expect(readFileSync(config, "utf8")).toContain("unknown=true");
});

test("global inspection and completion work despite invalid project configuration and do not write files", () => {
  const { config, env, ok } = fixture();
  mkdirSync(join(env.WORKBENCH_PROJECT_ROOT, "workbench"));
  writeFileSync(join(env.WORKBENCH_PROJECT_ROOT, "workbench/config.toml"), "invalid = [");
  expect(ok("config", "get", "storage.external")).toBe("false");
  expect(ok("complete", "--", "config", "set", "storage.external", "")).toBe("false\ntrue");
  expect(ok("complete", "--", "checks", "r")).toBe("run");
  expect(ok("complete", "--", "checks", "run", "--env")).toBe("--environment");
  expect(ok("complete", "--", "config", "get", "storage.")).toBe("storage.external\nstorage.root");
  expect(ok("complete", "--", "")).not.toMatch(/dependency-setup|native-exec|complete\n/);
  expect(existsSync(config)).toBe(false);
});

test("project choices and local overrides are scoped, validated, and separate from automation", () => {
  const { env, run, ok } = fixture();
  const project = env.WORKBENCH_PROJECT_ROOT;
  mkdirSync(join(project, "workbench"));
  const config = join(project, "workbench/config.toml");
  writeFileSync(
    config,
    'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[checks]\nenvironment="native"\n',
  );
  const automation = join(project, "workbench/automation.toml");
  const instructions = '# Agent-managed\n[review]\npaths=["sensitive"]\n';
  writeFileSync(automation, instructions);
  expect(ok("config", "get", "bundle.compression")).toBe("brotli");
  expect(ok("complete", "--", "config", "set", "bundle.compression", "")).toBe("brotli\nzlib\nzstd");
  ok("config", "set", "bundle.compression", "zstd");
  expect(ok("config", "get", "bundle.compression")).toBe("zstd");
  ok("config", "unset", "bundle.compression");
  expect(ok("config", "get", "bundle.compression")).toBe("brotli");
  ok("config", "set", "markdown.wrap_width", "100");
  expect(ok("config", "get", "markdown.wrap_width")).toBe("100");
  ok("config", "set", "ci.operating_systems", '["linux", "macos"]');
  expect(JSON.parse(ok("config", "get", "ci.operating_systems"))).toEqual(["linux", "macos"]);
  ok("config", "set", "storage.external", "true");
  ok("config", "--scope", "local", "set", "storage.external", "false");
  expect(ok("config", "get", "storage.external")).toBe("false");
  expect(ok("config", "get", "storage.external", "--scope", "global")).toBe("true");
  expect(JSON.parse(ok("paths", "--environment", "native")).external).toBe(false);
  ok("config", "set", "checks.environment", "guix", "--scope", "local");
  expect(ok("config", "get", "checks.environment")).toBe("guix");
  expect(ok("config", "get", "checks.environment", "--scope", "project")).toBe("native");
  ok("config", "unset", "storage.external", "--scope", "local");
  expect(ok("config", "get", "storage.external")).toBe("true");
  expect(JSON.parse(ok("paths", "--environment", "native")).external).toBe(true);
  expect(ok("config")).toMatch(/\| project\s+\| markdown\s+\| wrap_width\s+\| 100/);
  expect(ok("config")).not.toContain("sensitive");
  expect(readFileSync(automation, "utf8")).toBe(instructions);
  const before = readFileSync(config, "utf8");
  for (const args of [
    ["set", "storage.external", "true", "--scope", "project"],
    ["set", "markdown.wrap_width", "80", "--scope", "local"],
    ["set", "review.paths", '["other"]'],
    ["set", "checks.environment", "invalid"],
    ["set", "bundle.compression", "invalid"],
    ["set", "ci.operating_systems", '["plan9"]'],
    ["set", "ci.operating_systems", "[]"],
    ["set", "ci.environments", '["guix", "guix"]'],
    ["set", "citations.library_dir", "../outside"],
    ["unset", "compatibility.required"],
  ])
    expect(run("config", ...args).status).not.toBe(0);
  expect(readFileSync(config, "utf8")).toBe(before);
  expect(ok("complete", "--", "config", "set", "--scope", "local", "")).toBe(
    "checks.environment\ncollections.directories\ndevelopment.profile\nstorage.external\nstorage.root",
  );
  expect(ok("complete", "--empty", "--", "config", "set", "storage.external")).toBe("false\ntrue");
  expect(readFileSync(join(project, "workbench/.gitignore"), "utf8")).toContain("/local.toml");
});

test.skipIf(process.platform === "win32")(
  "Bash completion produces real config values through its installed function",
  () => {
    const { directory, env, ok } = fixture();
    const script = join(directory, "completion.bash");
    writeFileSync(script, ok("completion", "bash"));
    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "workbench"), '#!/bin/sh\nexec "$NODE" "$CLI" "$@"\n', { mode: 0o755 });
    const shell = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        'source "$COMPLETION"; COMP_WORDS=(workbench config set storage.external ""); COMP_CWORD=4; _workbench_complete; printf "%s\\n" "${COMPREPLY[@]}"',
      ],
      {
        env: {
          ...env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          NODE: process.execPath,
          CLI: resolve("bundle/main.cjs"),
          COMPLETION: script,
        },
        encoding: "utf8",
      },
    );
    expect(shell.status, shell.stderr).toBe(0);
    expect(shell.stdout.trim()).toBe("false\ntrue");
  },
);
