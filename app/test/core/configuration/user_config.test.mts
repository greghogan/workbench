import { showConfiguration } from "../../../src/cli/configuration-output.ts";
import { type ConfigScope, setConfiguration } from "../../../src/core/configuration/config-command.ts";
import { required } from "../../../src/core/runtime/invariants.ts";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { parse } from "smol-toml";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "workbench-user-config-")));
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
  const { config, directory, ok, set, get } = fixture();
  expect(ok("config", "get", "storage.external")).toBe("false");
  expect(ok("config")).toMatch(/\| OPTION\s+\| VALUE/);
  expect(existsSync(config)).toBe(false);
  ok("config", "set", "storage.external", "true");
  const root = join(directory, "fast disk");
  set("storage.root", root);
  expect(get("storage.external")).toBe("true");
  expect(get("storage.root")).toBe(root);
  const before = readFileSync(config, "utf8");
  for (const [key, value] of [
    ["storage.external", "yes"],
    ["storage.root", "relative"],
    ["storage.unknown", "true"],
  ] as const)
    expect(() => {
      set(key, value);
    }).toThrow();
  expect(readFileSync(config, "utf8")).toBe(before);
  ok("config", "unset", "storage.external");
  expect(get("storage.external")).toBe("false");
  expect(get("storage.root")).toBe(root);
  writeFileSync(config, "[storage]\nunknown=true\n");
  expect(() => {
    set("storage.external", "true");
  }).toThrow();
  expect(readFileSync(config, "utf8")).toContain("unknown=true");
});

test("global updates retain comments without creating empty option groups", () => {
  const { config, set, unset, directory } = fixture();
  mkdirSync(join(directory, "global"), { recursive: true });
  writeFileSync(config, "# Personal limits\n[execution] # scheduling\nmax_jobs = 2 # preferred\n");
  set("execution.max_jobs", "5", "global");
  expect(parse(readFileSync(config, "utf8"))).toEqual({ execution: { max_jobs: 5 } });
  unset("execution.max_jobs", "global");
  const contents = readFileSync(config, "utf8");
  expect(parse(contents)).toEqual({});
  for (const comment of ["# Personal limits", "# scheduling", "# preferred"]) expect(contents).toContain(comment);
  set("storage.external", "true", "global");
  expect(parse(readFileSync(config, "utf8"))).toEqual({ storage: { external: true } });
});

test("managed image stores are independently enabled in personal settings", () => {
  const { config, ok, get, set } = fixture();
  expect(get("preparation.nix_store")).toBe("disabled");
  expect(get("preparation.guix_store")).toBe("disabled");
  set("preparation.nix_store", "managed", "global");
  set("preparation.guix_store", "system", "global");
  expect(parse(readFileSync(config, "utf8"))).toEqual({ preparation: { nix_store: "managed", guix_store: "system" } });
  expect(() => {
    set("preparation.nix_store", "auto");
  }).toThrow();
  expect(() => {
    set("preparation.nix_store", "managed", "local");
  }).toThrow();
  expect(ok("complete", "--", "config", "set", "preparation.nix_store", "")).toBe("disabled\nmanaged\nsystem");
});

test("plain preference round-trips globally and flags and environment override presentation without writing preferences", () => {
  const { config, env, ok, set } = fixture();
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
  expect(() => {
    set("terminal.plain", "true", "local");
  }).toThrow();
  expect(() => {
    set("terminal.plain", "true", "project");
  }).toThrow();
  expect(() => {
    set("terminal.plain", "maybe");
  }).toThrow();
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

test("scoped project and local inspection do not read unrelated global preferences", () => {
  const { config, env, ok, set, get } = fixture();
  ok("setup-project", env.WORKBENCH_PROJECT_ROOT);
  set("execution.cpus_per_job", "4", "local");
  mkdirSync(join(config, ".."), { recursive: true });
  writeFileSync(config, "invalid = [");
  expect(get(undefined, "project")).toContain("markdown.wrap_width");
  expect(get("markdown.wrap_width", "project")).toBe("120");
  expect(get(undefined, "local")).toMatch(/execution\.cpus_per_job\s*\|\s*4\s*\|\s*local/);
  expect(() => {
    get();
  }).toThrow();
});

test("configuration overview reports one effective value and its overriding scope", () => {
  const { env, ok, set, get, unset } = fixture();
  ok("setup-project", env.WORKBENCH_PROJECT_ROOT);
  set("execution.cpus_per_job", "8");
  set("execution.cpus_per_job", "4", "local");
  const output = get();
  expect(output.match(/OPTION/g)).toHaveLength(1);
  expect(output.match(/execution\.cpus_per_job/g)).toHaveLength(1);
  expect(output).toMatch(/execution\.cpus_per_job\s*\|\s*4\s*\|\s*local/);
  expect(get(undefined, "global")).toMatch(/execution\.cpus_per_job\s*\|\s*8\s*\|\s*global/);
  unset("execution.cpus_per_job", "local");
  expect(get()).toMatch(/execution\.cpus_per_job\s*\|\s*8\s*\|\s*global/);
});

test("configuration reports built-in defaults and describes omitted contextual options", () => {
  const { env, ok, get, set, unset } = fixture();
  ok("setup-project", env.WORKBENCH_PROJECT_ROOT);
  expect(ok("config", "get", "review.signed_commits")).toBe("false");
  expect(get("checks.allow_empty")).toBe("false");
  expect(get("checks.inputs")).toBe("[]");
  expect(get("records.archive_group_size")).toBe("1296");
  expect(get("commit.body_width")).toBe("72");
  expect(get()).toMatch(/review\.signed_commits\s*\|\s*false\s*\|\s*default/);
  expect(get()).toContain("Archival disabled");
  expect(get()).not.toContain("<unset>");

  set("diagnostics.level", "warn");
  expect(get("diagnostics.server_level")).toBe("warn");
  set("review.signed_commits", "true");
  expect(get()).toMatch(/review\.signed_commits\s*\|\s*true\s*\|\s*project/);
  unset("review.signed_commits");
  expect(get("review.signed_commits")).toBe("false");
});

test("configuration shows complete nested values and uses the terminal width before wrapping", () => {
  const { env, ok, set, get } = fixture();
  ok("setup-project", env.WORKBENCH_PROJECT_ROOT);
  const skills = Array.from({ length: 300 }, (_, index) => `skill-${String(index)}`);
  const cache = { artifacts: { llvm: "download", gcc: "download", rust: "cache" } };
  const storage = join(env.WORKBENCH_PROJECT_ROOT, "long-directory-name-".repeat(6));
  set("skills.enabled", JSON.stringify(skills));
  set("storage.root", storage);
  set("ci.cache", JSON.stringify(cache));
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  try {
    for (const columns of [80, storage.length + 100]) {
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
      const output = get();
      expect(output).not.toMatch(/<\d+ (?:items?|fields?)>/);
      expect(output).toContain("local.toml (not created)");
      expect(output).toContain("workbench config get <option>");
      const values = new Map<string, string>();
      let key = "";
      for (const line of output.split("\n").filter((line) => line.startsWith("|"))) {
        expect(line.length).toBeLessThanOrEqual(columns);
        const cells = line.split("|");
        const name = cells[1]?.trim();
        if (name) key = name;
        values.set(key, (values.get(key) ?? "") + (cells[2]?.trim() ?? ""));
      }
      expect(JSON.parse(values.get("skills.enabled") ?? "null")).toEqual(skills);
      expect(JSON.parse(values.get("ci.cache") ?? "null")).toEqual(cache);
      expect(values.get("storage.root")).toBe(storage);
      if (columns > 80) {
        expect(output).toContain(storage);
        expect(output).toContain(JSON.stringify(cache));
      }
    }
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, "columns", descriptor);
    else Reflect.deleteProperty(process.stdout, "columns");
  }
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
    ["set", "skills.enabled", '["review-changes"]', "--scope", "local"],
    ["set", "skills.enabled", '["review-changes"]', "--scope", "project"],
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
    "checks.environment\ncollections.directories\ndevelopment.profile\ndevelopment.workspace\nexecution.cpus_per_job\nexecution.max_jobs\nlogs.check_max_age_days\nlogs.check_max_bytes\nlogs.compression\nstorage.external\nstorage.root",
  );
  expect(ok("complete", "--empty", "--", "config", "set", "storage.external")).toBe("false\ntrue");
  expect(readFileSync(join(project, "workbench/.gitignore"), "utf8")).toContain("/local.toml");
});

test("log policies round-trip through scoped configuration without permitting invalid codecs or budgets", () => {
  const { config, env, ok, set, get } = fixture();
  ok("setup-project", env.WORKBENCH_PROJECT_ROOT);
  set("logs.compression", "gzip", "global");
  expect(ok("complete", "--", "config", "set", "logs.compression", "")).toBe("auto\ngzip\nnone\nzstd");
  set("logs.compression", "none", "local");
  expect(get("logs.compression")).toBe("none");
  expect(get("logs.compression", "global")).toBe("gzip");
  set("logs.server_max_bytes", "123456", "global");
  set("logs.prune_interval_seconds", "7200", "global");
  expect(get("logs.server_max_bytes")).toBe("123456");
  expect(get("logs.prune_interval_seconds")).toBe("7200");
  const before = readFileSync(config, "utf8");
  for (const [name, value, scope] of [
    ["logs.compression", "brotli", "global"],
    ["logs.cli_max_bytes", "-1", "global"],
    ["logs.server_rotate_hours", "1.5", "global"],
    ["logs.server_max_bytes", "1", "local"],
  ] as const)
    expect(() => {
      set(name, value, scope);
    }).toThrow();
  expect(readFileSync(config, "utf8")).toBe(before);
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
