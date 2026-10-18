import type { ConfigScope } from "../src/config-command.ts";
import { required } from "../src/invariants.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { parse } from "smol-toml";

import { setConfiguration, showConfiguration } from "../src/config-command.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "workbench-user-config-"));
  temporary.push(directory);
  const config = join(directory, "global/config.toml");
  const env: NodeJS.ProcessEnv & { WORKBENCH_PROJECT_ROOT: string } = {
    ...process.env,
    WORKBENCH_CONFIG_HOME: join(directory, "global"),
    WORKBENCH_CACHE_HOME: join(directory, "cache"),
    WORKBENCH_PROJECT_ROOT: join(directory, "project"),
  };
  mkdirSync(env.WORKBENCH_PROJECT_ROOT);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [resolve("bundle/main.cjs"), ...args], {
      cwd: env.WORKBENCH_PROJECT_ROOT,
      env,
      encoding: "utf8",
    });
  const ok = (...args: string[]) => {
    const result = run(...args);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  // Exercise validation combinations through the real configuration API, independently of CLI routing.
  const set = (key: string, value: string | undefined, scope?: ConfigScope) => {
    setConfiguration(env.WORKBENCH_PROJECT_ROOT, key, value, scope);
  };
  const unset = (key: string, scope?: ConfigScope) => {
    set(key, undefined, scope);
  };
  const get = (key?: string, scope?: ConfigScope) => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      showConfiguration(env.WORKBENCH_PROJECT_ROOT, scope, key);
      return output.mock.calls
        .map(([value]) => String(value))
        .join("\n")
        .trim();
    } finally {
      output.mockRestore();
    }
  };
  for (const name of ["WORKBENCH_CONFIG_HOME", "WORKBENCH_CACHE_HOME"]) vi.stubEnv(name, env[name]);
  return { directory, config, env, run, ok, set, unset, get };
}

test("global configuration inspects defaults without initialization and round-trips validated changes", () => {
  const { config, directory, run, ok } = fixture();
  expect(ok("config", "get", "storage.external")).toBe("false");
  expect(ok("config")).toMatch(/\| OPTION\s+\| VALUE/);
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
  ] as const)
    expect(run("config", "set", ...args).status).not.toBe(0);
  expect(readFileSync(config, "utf8")).toBe(before);
  ok("config", "unset", "storage.external");
  expect(ok("config", "get", "storage.external")).toBe("false");
  expect(ok("config", "get", "storage.root")).toBe(root);
  writeFileSync(config, "[storage]\nunknown=true\n");
  expect(run("config", "set", "storage.external", "true").status).not.toBe(0);
  expect(readFileSync(config, "utf8")).toContain("unknown=true");
});

test("plain preference round-trips globally and flags and environment override presentation without writing preferences", () => {
  const { config, env, run, ok } = fixture();
  delete env.WORKBENCH_PLAIN;
  expect(ok("config", "get", "terminal.plain")).toBe("false");
  ok("config", "set", "terminal.plain", "true");
  expect(ok("config", "get", "terminal.plain")).toBe("true");
  expect(ok("config", "--scope", "global")).toContain("OPTION: terminal.plain\nVALUE: true");
  const saved = readFileSync(config, "utf8");
  expect(ok("--no-plain", "config", "--scope", "global")).toContain("| OPTION");
  expect(ok("config", "--scope", "global", "--no-plain")).toContain("| OPTION");
  env.WORKBENCH_PLAIN = "0";
  expect(ok("config", "--scope", "global")).toContain("| OPTION");
  expect(ok("--plain", "config", "--scope", "global")).toContain("OPTION: terminal.plain");
  expect(ok("config", "--scope", "global", "--plain")).toContain("OPTION: terminal.plain");
  expect(readFileSync(config, "utf8")).toBe(saved);
  expect(run("config", "set", "terminal.plain", "true", "--scope", "local").status).not.toBe(0);
  expect(run("config", "set", "terminal.plain", "true", "--scope", "project").status).not.toBe(0);
  expect(run("config", "set", "terminal.plain", "maybe").status).not.toBe(0);
  expect(ok("complete", "--", "config", "set", "terminal.plain", "")).toBe("false\ntrue");
  ok("config", "unset", "terminal.plain");
  expect(ok("config", "get", "terminal.plain")).toBe("false");
});

test("global inspection and completion work despite invalid project configuration and do not write files", () => {
  const { config, env, ok } = fixture();
  mkdirSync(join(env.WORKBENCH_PROJECT_ROOT, "workbench"));
  writeFileSync(join(env.WORKBENCH_PROJECT_ROOT, "workbench/config.toml"), "invalid = [");
  expect(ok("config", "get", "storage.external")).toBe("false");
  expect(ok("complete", "--", "config", "set", "storage.external", "")).toBe("false\ntrue");
  expect(ok("complete", "--", "check", "m")).toBe("matrix");
  expect(ok("complete", "--", "check", "--li")).toBe("--list");
  expect(ok("complete", "--", "check", "--env")).toBe("--environment");
  expect(ok("complete", "--", "config", "get", "storage.")).toBe("storage.external\nstorage.root");
  expect(ok("complete", "--", "")).not.toMatch(/dependency-setup|native-exec|complete\n/);
  expect(existsSync(config)).toBe(false);
});

test("configuration overview bounds nested values and wraps paths while get remains lossless", () => {
  const { env, ok, set, get } = fixture();
  ok("setup-project", env.WORKBENCH_PROJECT_ROOT);
  const skills = Array.from({ length: 300 }, (_, index) => `skill-${String(index)}`);
  const cache = { artifacts: { llvm: "download", gcc: "download", rust: "cache" } };
  const storage = join(env.WORKBENCH_PROJECT_ROOT, "long-directory-name-".repeat(10));
  set("skills.enabled", JSON.stringify(skills));
  set("storage.root", storage);
  set("ci.cache", JSON.stringify(cache));
  const output = get();
  expect(output).toContain("<300 items>");
  expect(output).toContain("<1 field>");
  expect(output).toContain("local.toml (not created)");
  expect(output).toContain("workbench config get <option>");
  for (const line of output.split("\n").filter((line) => /^[+|]/.test(line)))
    expect(line.length).toBeLessThanOrEqual(80);
  expect(JSON.parse(get("skills.enabled"))).toEqual(skills);
  expect(JSON.parse(get("ci.cache"))).toEqual(cache);
  expect(get("storage.root")).toBe(storage);
  expect(existsSync(join(env.WORKBENCH_PROJECT_ROOT, "workbench/local.toml"))).toBe(false);
});

test("project data policy supports setup, completion, all choices, and unsetting without modifying existing data", () => {
  const { env, ok, set, unset, get } = fixture();
  const root = env.WORKBENCH_PROJECT_ROOT;
  ok("setup-project", root);
  const path = join(root, "workbench/config.toml");
  expect(parse(readFileSync(path, "utf8")).compatibility).toEqual({ required: false, data: "ask" });
  expect(get("compatibility.data")).toBe("ask");
  expect(ok("complete", "--", "config", "set", "compatibility.data", "")).toBe("ask\ndelete\nmigrate");
  const dataPath = join(root, "data.bin");
  const data = Buffer.from([0, 3, 255, 1]);
  writeFileSync(dataPath, data);
  for (const required of [false, true]) {
    set("compatibility.required", String(required));
    for (const policy of ["ask", "migrate", "delete"]) {
      set("compatibility.data", policy);
      expect(get("compatibility.data")).toBe(policy);
      expect(parse(readFileSync(path, "utf8")).compatibility).toEqual({ required, data: policy });
      expect(readFileSync(dataPath)).toEqual(data);
    }
  }
  ok("setup-project", root);
  expect(get("compatibility.data")).toBe("delete");
  const before = readFileSync(path, "utf8");
  for (const args of [
    ["compatibility.data", "discard"],
    ["compatibility.data", "true"],
    ["compatibility.data", "delete", "--scope", "local"],
    ["compatibility.data", "delete", "--scope", "global"],
  ] as const) {
    expect(() => {
      set(required(args[0], "Expected fixture value"), args[1], args[3]);
    }).toThrow(/ask or migrate or delete|not an option/);
    expect(readFileSync(path, "utf8")).toBe(before);
  }
  unset("compatibility.data");
  expect(get("compatibility.data")).toBe("ask");
  expect(parse(readFileSync(path, "utf8")).compatibility).toEqual({ required: true });
  expect(readFileSync(dataPath)).toEqual(data);
});

test("project choices and local overrides are scoped, validated, and separate from automation", () => {
  const { env, ok, set, unset, get } = fixture();
  const project = env.WORKBENCH_PROJECT_ROOT;
  mkdirSync(join(project, "workbench"));
  const config = join(project, "workbench/config.toml");
  writeFileSync(
    config,
    'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[checks]\nenvironment="native"\n',
  );
  const automation = join(project, "workbench/automation.toml");
  const instructions = "# Agent-managed sensitive automation\n";
  writeFileSync(automation, instructions);
  expect(get("bundle.compression")).toBe("brotli");
  expect(ok("complete", "--", "config", "set", "bundle.compression", "")).toBe("brotli\nzlib\nzstd");
  set("bundle.compression", "zstd");
  expect(get("bundle.compression")).toBe("zstd");
  unset("bundle.compression");
  expect(get("bundle.compression")).toBe("brotli");
  set("markdown.wrap_width", "100");
  expect(get("markdown.wrap_width")).toBe("100");
  set("ci.operating_systems", '["linux", "macos"]');
  expect(JSON.parse(get("ci.operating_systems"))).toEqual(["linux", "macos"]);
  set("storage.external", "true");
  ok("config", "--scope", "local", "set", "storage.external", "false");
  expect(get("storage.external")).toBe("false");
  expect(get("storage.external", "global")).toBe("true");
  expect((JSON.parse(ok("paths", "--environment", "native")) as { external: boolean }).external).toBe(false);
  set("checks.environment", "guix", "local");
  expect(get("checks.environment")).toBe("guix");
  expect(get("checks.environment", "project")).toBe("native");
  unset("storage.external", "local");
  expect(get("storage.external")).toBe("true");
  expect((JSON.parse(ok("paths", "--environment", "native")) as { external: boolean }).external).toBe(true);
  expect(ok("config")).toMatch(/\| markdown\.wrap_width\s+\| 100/);
  expect(ok("config")).not.toContain("sensitive");
  expect(readFileSync(automation, "utf8")).toBe(instructions);
  const before = readFileSync(config, "utf8");
  for (const args of [
    ["set", "storage.external", "true", "--scope", "project"],
    ["set", "markdown.wrap_width", "80", "--scope", "local"],
    ["set", "skills.enabled", '["workbench-review"]', "--scope", "local"],
    ["set", "skills.enabled", '["workbench-review"]', "--scope", "project"],
    ["set", "check_suite", "[]"],
    ["set", "checks.environment", "invalid"],
    ["set", "bundle.compression", "invalid"],
    ["set", "ci.operating_systems", '["plan9"]'],
    ["set", "ci.operating_systems", "[]"],
    ["set", "ci.environments", '["guix", "guix"]'],
    ["set", "citations.library_dir", "../outside"],
    ["unset", "compatibility.required"],
  ] as const)
    expect(() => {
      set(required(args[1], "Expected fixture value"), args[0] === "set" ? args[2] : undefined, args[4]);
    }).toThrow();
  expect(readFileSync(config, "utf8")).toBe(before);
  expect(ok("complete", "--", "config", "set", "--scope", "local", "")).toBe(
    "checks.environment\ncollections.directories\ndevelopment.profile\ndevelopment.workspace\nexecution.cpus_per_job\nexecution.max_jobs\nstorage.external\nstorage.root",
  );
  expect(ok("complete", "--empty", "--", "config", "set", "storage.external")).toBe("false\ntrue");
  expect(readFileSync(join(project, "workbench/.gitignore"), "utf8")).toContain("/local.toml");
});

test("commit styles and shared prefix restrictions round-trip through project configuration", () => {
  const { env, run, ok, set, unset, get } = fixture();
  const root = env.WORKBENCH_PROJECT_ROOT;
  ok("setup-project", root);
  const config = join(root, "workbench/config.toml");
  expect(ok("complete", "--", "config", "set", "commit.style", "")).toBe("area\nconventional\nplain\nunrestricted");
  expect(ok("complete", "--", "config", "set", "commit.")).toBe(
    "commit.body_width\ncommit.prefixes\ncommit.style\ncommit.subject_width",
  );
  for (const style of ["conventional", "plain", "area", "unrestricted"]) {
    set("commit.style", style);
    expect(get("commit.style")).toBe(style);
  }
  set("commit.prefixes", '["deps", "docs"]');
  expect(JSON.parse(get("commit.prefixes"))).toEqual(["deps", "docs"]);
  expect(
    required(
      (parse(readFileSync(config, "utf8")) as { commit?: { prefixes?: string[] } }).commit,
      'Expected fixture value: parse(readFileSync(config, "utf8")).commit',
    ).prefixes,
  ).toEqual(["deps", "docs"]);
  const message = join(root, "message.txt");
  for (const style of ["conventional", "area"]) {
    set("commit.style", style);
    writeFileSync(message, "deps: update dependencies\n");
    ok("commit", "check", message);
    writeFileSync(message, "fix: repair input handling\n");
    const rejected = run("commit", "check", message);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/must be one of: deps, docs/);
  }
  const before = readFileSync(config, "utf8");
  for (const args of [
    ["commit.style", "plan"],
    ["commit.prefixes", "[]"],
    ["commit.prefixes", '["fix", "FIX"]'],
    ["commit.prefixes", '["two words"]'],
    ["commit.prefixes", '["fix"]', "--scope", "global"],
    ["commit.prefixes", '["fix"]', "--scope", "local"],
  ] as const)
    expect(() => {
      set(required(args[0], "Expected fixture value"), args[1], args[3]);
    }).toThrow();
  expect(readFileSync(config, "utf8")).toBe(before);
  unset("commit.prefixes");
  expect(get("commit.prefixes")).toBe("<unset>");
  expect(
    required(
      (parse(readFileSync(config, "utf8")) as { commit?: { prefixes?: string[] } }).commit,
      'Expected fixture value: parse(readFileSync(config, "utf8")).commit',
    ).prefixes,
  ).toBeUndefined();
  writeFileSync(message, "parser: update subsystem\n");
  ok("commit", "check", message);
  set("commit.style", "conventional");
  writeFileSync(message, "fix: repair input handling\n");
  ok("commit", "check", message);
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
          PATH: `${bin}${delimiter}${String(process.env.PATH)}`,
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

test.skipIf(process.platform === "win32" || spawnSync("zsh", ["--version"]).status !== 0).each([
  ["pre-", ["--", "pre-commit", "pre-push"]],
  ["no-matching-command", ["unexpected-fallback"]],
])("installed Zsh completion handles %s on its first autoload invocation", (prefix, expected) => {
  const { directory, env, ok } = fixture();
  // Gate commands are visible only inside a registered project.
  mkdirSync(join(env.WORKBENCH_PROJECT_ROOT, "workbench"));
  writeFileSync(join(env.WORKBENCH_PROJECT_ROOT, "workbench/projects.toml"), '[[project]]\nid="fixture"\npath="."\n');
  const completions = join(directory, "zsh");
  ok("completion", "install", "zsh", "--directory", completions);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "workbench"), '#!/bin/sh\nexec "$NODE" "$CLI" "$@"\n', { mode: 0o755 });
  const shell = spawnSync(
    "zsh",
    [
      "-f",
      "-c",
      'fpath=("$COMPLETIONS" $fpath); autoload -Uz _workbench; words=(workbench "$PREFIX"); CURRENT=2; compadd() { print -l -- "$@"; }; _files() { print unexpected-fallback; }; _workbench',
    ],
    {
      env: {
        ...env,
        PATH: `${bin}${delimiter}${String(process.env.PATH)}`,
        NODE: process.execPath,
        CLI: resolve("bundle/main.cjs"),
        COMPLETIONS: completions,
        PREFIX: prefix,
      },
      encoding: "utf8",
    },
  );
  expect(shell.status, shell.stderr).toBe(0);
  expect(shell.stdout.trim().split("\n")).toEqual(expected);
});
