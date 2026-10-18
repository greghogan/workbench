import { configuredCheck, checkPlan } from "./fixtures/checks.mjs";
import { required } from "../src/invariants.ts";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "smol-toml";
import {
  checkBaseEnvironment,
  checkHostPath,
  nativeCheckEnvironment,
  checkConfigurationFiles,
} from "../src/check-environment.ts";
import { runCommand } from "../src/checks.ts";
import { checkFingerprint } from "../src/check-inputs.ts";
import { withDevelopmentSelection } from "../src/environments.ts";
import { configFromData } from "../src/core.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn((command: string, args: readonly string[] = [], options?: SpawnSyncOptionsWithStringEncoding) =>
      command === process.execPath && args.length === 1 && args[0] === "--version"
        ? { status: 0, stdout: `${process.version}\n`, stderr: "" }
        : actual.spawnSync(command, args, options),
    ),
  };
});
const distribution = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(languages: string[] = [], pass: string[] = []) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "workbench-check-contract-"))),
    root = join(base, "project");
  temporary.push(base);
  mkdirSync(join(root, "workbench"), { recursive: true });
  writeFileSync(
    join(root, "workbench/config.toml"),
    stringify({
      schema_version: 1,
      markdown: { wrap_width: 120 },
      compatibility: { required: false },
      checks: { pass_environment: pass },
    }),
  );
  writeFileSync(
    join(root, "workbench/projects.toml"),
    stringify({
      project: [{ id: "fixture", path: "." }],
      language_root: languages.map((language) => ({ language, path: "." })),
    }),
  );
  for (const [key, val] of Object.entries({
    WORKBENCH_DISTRIBUTION_ROOT: distribution,
    WORKBENCH_CACHE_HOME: join(base, "cache"),
    WORKBENCH_CONFIG_HOME: join(base, "config"),
    WORKBENCH_DATA_HOME: join(base, "data"),
    WORKBENCH_STATE_HOME: join(base, "state"),
    WORKBENCH_STORAGE_EXTERNAL: "false",
    WORKBENCH_STORAGE_ROOT: undefined,
    WORKBENCH_LOCAL_CONFIG_ROOT: undefined,
    WORKBENCH_EPHEMERAL_CHECKOUT: undefined,
  }))
    vi.stubEnv(key, val);
  return { base, root };
}

test("native tools receive the declared environment rather than the caller environment", () => {
  const { root } = fixture([], ["APPLICATION_MODE"]);
  vi.stubEnv("CODEX_SESSION_ID", "private-session");
  vi.stubEnv("UNDECLARED_RESOURCE_LIMIT", "1234");
  vi.stubEnv("UNDECLARED_SECRET", "not passed");
  vi.stubEnv("MSYSTEM", "UCRT64");
  vi.stubEnv("APPLICATION_MODE", "literal value with $ and spaces");
  const output = join(root, "environment.json");
  runCommand(
    root,
    "environment fixture",
    [
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env)); require('node:fs').writeFileSync('arguments.json',JSON.stringify(process.argv.slice(1)))`,
      "C:\\users\\literal $HOME 'quoted'",
    ],
    "native",
    root,
  );
  const actual = JSON.parse(readFileSync(output, "utf8")) as Record<string, string>;
  expect(JSON.parse(readFileSync(join(root, "arguments.json"), "utf8"))).toEqual(["C:\\users\\literal $HOME 'quoted'"]);
  expect(actual.APPLICATION_MODE).toBe("literal value with $ and spaces");
  expect(actual.MSYSTEM).toBe("UCRT64");
  expect(JSON.stringify(vi.mocked(spawnSync).mock.calls.map(([command, args]) => [command, args]))).not.toContain(
    "literal value with $ and spaces",
  );
  for (const name of ["CODEX_SESSION_ID", "UNDECLARED_RESOURCE_LIMIT", "UNDECLARED_SECRET"])
    expect(actual).not.toHaveProperty(name);
  expect(actual.WORKBENCH_PROJECT_ROOT).toBe(root);
  expect(process.env.CODEX_SESSION_ID).toBe("private-session");
});

test("language settings are scoped to their registered root and generated selections remain authoritative", () => {
  const { root } = fixture(["typescript"]);
  vi.stubEnv("NODE_OPTIONS", "--no-warnings");
  vi.stubEnv("RUSTFLAGS", "-C opt-level=2");
  vi.stubEnv("GOFLAGS", "-tags=custom");
  const env = nativeCheckEnvironment(root, root, {}, 2);
  expect(env).not.toHaveProperty("NODE_OPTIONS");
  for (const name of ["RUSTFLAGS", "GOFLAGS", "CARGO_BUILD_JOBS", "GOMAXPROCS"]) expect(env).not.toHaveProperty(name);
  expect(env.WORKBENCH_CPU_BUDGET).toBe("2");
  expect(env.UV_THREADPOOL_SIZE).toBe("2");
  writeFileSync(
    join(root, "workbench/projects.toml"),
    stringify({ project: [{ id: "fixture", path: "." }], language_root: [{ language: "go", path: "." }] }),
  );
  const go = nativeCheckEnvironment(root, root, {}, 2);
  expect(go.GOFLAGS).toBe("-p=2");
  expect(go.GOTOOLCHAIN).toBe("local");
  expect(go.GOENV).toBe("off");
  expect(go).not.toHaveProperty("NODE_OPTIONS");
});

test("Python checks retain their managed interpreter location without forwarding it to other languages", () => {
  const { base, root } = fixture(["python"]);
  const location = join(base, "managed-python"),
    cache = join(base, "python-downloads");
  vi.stubEnv("UV_PYTHON_INSTALL_DIR", location);
  vi.stubEnv("UV_PYTHON_CACHE_DIR", cache);
  expect(checkBaseEnvironment(root, root)).toMatchObject({
    UV_PYTHON_INSTALL_DIR: location,
    UV_PYTHON_CACHE_DIR: cache,
  });
  writeFileSync(
    join(root, "workbench/projects.toml"),
    stringify({ project: [{ id: "fixture", path: "." }], language_root: [{ language: "typescript", path: "." }] }),
  );
  expect(checkBaseEnvironment(root, root)).not.toHaveProperty("UV_PYTHON_INSTALL_DIR");
  expect(checkBaseEnvironment(root, root)).not.toHaveProperty("UV_PYTHON_CACHE_DIR");
});

test("Python build storage appends cache options only to declared caller test options", () => {
  const { root } = fixture(["python"]);
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  vi.stubEnv("PYTEST_ADDOPTS", "--ignore=tests");
  const generated = nativeCheckEnvironment(root, root).PYTEST_ADDOPTS;
  expect(generated).toContain("-o cache_dir=");
  expect(generated).not.toContain("--ignore=tests");
  const { root: explicit } = fixture(["python"], ["PYTEST_ADDOPTS"]);
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  expect(nativeCheckEnvironment(explicit, explicit).PYTEST_ADDOPTS).toContain("--ignore=tests -o cache_dir=");
});

test("Rust checks retain isolated manager locations and the Windows SDK linker contract", () => {
  const { base, root } = fixture(["rust"]);
  const settings = {
    CARGO_HOME: join(base, "cargo"),
    RUSTUP_HOME: join(base, "rustup"),
    CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER: join(base, "sdk", "link.exe"),
    LIB: join(base, "sdk", "lib"),
  };
  for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
  expect(checkBaseEnvironment(root, root)).toMatchObject(settings);
});

test.each([
  ["c", ["CC", "CXX", "CFLAGS", "CPPFLAGS", "LDFLAGS", "CPATH", "C_INCLUDE_PATH", "LIBRARY_PATH"]],
  ["cpp", ["CXXFLAGS", "CPLUS_INCLUDE_PATH", "LD_LIBRARY_PATH", "CMAKE_PREFIX_PATH", "PKG_CONFIG_PATH"]],
  [
    "rust",
    ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTDOCFLAGS", "CARGO_INCREMENTAL", "RUSTC_WRAPPER", "CROSS_BUILD_OPTS"],
  ],
  ["typescript", ["NODE_ENV", "NODE_OPTIONS"]],
  ["javascript", ["NODE_ENV", "NODE_OPTIONS"]],
  ["python", ["PYTHONPATH", "PYTHONHASHSEED", "PYTEST_ADDOPTS"]],
  ["go", ["GOFLAGS", "GOOS", "GOARCH", "CGO_ENABLED", "CC", "CXX", "CGO_CFLAGS", "CGO_LDFLAGS"]],
  ["java", ["MAVEN_OPTS", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS"]],
  ["ruby", ["RUBYOPT", "RUBYLIB", "CFLAGS", "LDFLAGS"]],
  ["php", ["PHPRC", "PHP_INI_SCAN_DIR"]],
] satisfies [string, string[]][])(
  "%s ignores ambient build overrides unless the project declares them",
  (language, names) => {
    const { root } = fixture([language]);
    const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !names.includes(name)));
    const caller = { ...clean, ...Object.fromEntries(names.map((name) => [name, "user-specific override"])) };
    expect(checkBaseEnvironment(root, root, caller)).toEqual(checkBaseEnvironment(root, root, clean));
    const { root: explicit } = fixture([language], names);
    for (const name of names)
      expect(checkBaseEnvironment(explicit, explicit, caller)[name]).toBe("user-specific override");
  },
);

test("agent compiler selections and terminal include paths produce identical check inputs and child environments", () => {
  const { root } = fixture(["c", "cpp"]);
  expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);
  const names = ["CC", "CXX", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "LIBRARY_PATH"];
  for (const name of names) vi.stubEnv(name, undefined);
  vi.stubEnv("CC", "agent-cc");
  vi.stubEnv("CXX", "agent-cxx");
  const plan = checkPlan(root, [configuredCheck({ command: [process.execPath, "-e", "process.exit(0)"] })]);
  const before = checkFingerprint(root, {}, plan);
  vi.stubEnv("CC", undefined);
  vi.stubEnv("CXX", undefined);
  for (const name of names.slice(2)) vi.stubEnv(name, "/user/include-or-libraries");
  expect(checkFingerprint(root, {}, plan)).toEqual(before);
  const output = join(root, "child.json");
  const command = [
    process.execPath,
    "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env))`,
  ];
  runCommand(root, "compiler environment fixture", command, "native", root);
  const child = JSON.parse(readFileSync(output, "utf8")) as Record<string, string>;
  for (const name of names) expect(child).not.toHaveProperty(name);
  const delegated = spawnSync(
    process.execPath,
    [join(distribution, "bin/workbench.mjs"), "native-exec", root, "--", ...command],
    { cwd: root, encoding: "utf8" },
  );
  expect(delegated.status, delegated.stderr).toBe(0);
  const delegatedChild = JSON.parse(readFileSync(output, "utf8")) as Record<string, string>;
  for (const name of names) expect(delegatedChild).not.toHaveProperty(name);
  mkdirSync(join(root, ".devcontainer"));
  writeFileSync(join(root, ".devcontainer/devcontainer.json"), "{}");
  vi.stubEnv("WORKBENCH_DEVCONTAINER", "1");
  runCommand(root, "inside native container fixture", command, "devcontainer", root);
  const containerChild = JSON.parse(readFileSync(output, "utf8")) as Record<string, string>;
  for (const name of names) expect(containerChild).not.toHaveProperty(name);
});

test("unrelated PATH additions and profile symlink spelling do not select a different host tool environment", () => {
  const { base, root } = fixture();
  const empty = join(base, "unrelated-agent-bin");
  mkdirSync(empty);
  const original = checkHostPath(process.env);
  const source = { ...process.env, PATH: empty + delimiter + (process.env.PATH ?? ""), CODEX_THREAD_ID: "another" };
  expect(checkHostPath(source)).toBe(original);
  expect(checkBaseEnvironment(root, root, source)).toEqual(checkBaseEnvironment(root, root));
});

test("resolved host utilities preserve caller precedence rather than whichever utility was enumerated first", () => {
  const { base } = fixture();
  const preferred = join(base, "preferred"),
    fallback = join(base, "fallback");
  mkdirSync(preferred);
  mkdirSync(fallback);
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const [directory, name] of [
    [preferred, "gpg"],
    [fallback, "git"],
    [fallback, "gpg"],
  ] as const)
    writeFileSync(join(required(directory, "Fixture value directory"), name + suffix), "fixture", { mode: 0o755 });
  const paths = checkHostPath({ PATH: [preferred, fallback].join(delimiter) }).split(delimiter);
  expect(paths.indexOf(preferred)).toBeGreaterThanOrEqual(0);
  expect(paths.indexOf(preferred)).toBeLessThan(paths.indexOf(fallback));
});

test.skipIf(process.platform !== "win32")("Windows checks retain SDK tools through the restricted host PATH", () => {
  const { base } = fixture(["cpp"]);
  const sdk = join(base, "sdk"),
    linker = join(base, "linker");
  mkdirSync(sdk);
  mkdirSync(linker);
  for (const name of ["rc.exe", "mt.exe"]) writeFileSync(join(sdk, name), "fixture");
  writeFileSync(join(linker, "link.exe"), "fixture");
  const paths = checkHostPath({ PATH: [sdk, linker].join(delimiter) }).split(delimiter);
  expect(paths).toContain(sdk);
  expect(paths).toContain(linker);
});

test.skipIf(process.platform !== "win32")(
  "Git hooks and callers select the same Windows Git and temporary paths",
  () => {
    const { base, root } = fixture();
    const result = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const binary = resolve(result.stdout.trim(), "../../bin/git.exe");
    const wrapper = resolve(binary, "../../../cmd/git.exe");
    const initial = checkBaseEnvironment(root, root, { ...process.env, PATH: dirname(wrapper), TMPDIR: base });
    const hook = checkBaseEnvironment(root, root, {
      ...process.env,
      PATH: dirname(binary),
      TMPDIR: base.replaceAll("\\", "/"),
    });
    expect(initial).toEqual(hook);
  },
);

test.skipIf(process.platform !== "win32")("checks and hooks share Git tools despite an earlier separate MSYS", () => {
  const { base, root } = fixture();
  const result = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  const binary = resolve(result.stdout.trim(), "../../bin/git.exe");
  const wrapper = resolve(binary, "../../../cmd/git.exe");
  const utilities = resolve(binary, "../../../usr/bin");
  const separate = join(base, "msys", "usr", "bin");
  mkdirSync(separate, { recursive: true });
  for (const name of ["sh.exe", "bash.exe", "env.exe", "curl.exe"])
    writeFileSync(join(separate, name), "separate installation");
  const callerPath = [separate, dirname(wrapper), process.env.PATH].join(delimiter);
  const before = checkBaseEnvironment(root, root, { ...process.env, MSYSTEM: undefined, PATH: callerPath });
  const hook = checkBaseEnvironment(root, root, {
    ...process.env,
    MSYSTEM: basename(dirname(dirname(binary))).toUpperCase(),
    PATH: [dirname(binary), utilities, callerPath].join(delimiter),
  });
  expect(before).toEqual(hook);
  expect(required(before.PATH, "Expected fixture value: before.PATH").split(delimiter)).not.toContain(separate);
});

test("exact-name forwarding distinguishes unset and empty values and rejects patterns or duplicate names", () => {
  const { root } = fixture([], ["MY_INPUT"]);
  expect(checkBaseEnvironment(root, root, { ...process.env, MY_INPUT: undefined })).not.toHaveProperty("MY_INPUT");
  expect(checkBaseEnvironment(root, root, { ...process.env, MY_INPUT: "" }).MY_INPUT).toBe("");
  for (const names of [["CUSTOM_*"], ["A", "a"], ["INVALID=NAME"]] as const)
    expect(() =>
      configFromData({ schema_version: 1, checks: { pass_environment: names } }, undefined, "config.toml"),
    ).toThrow(/environment/);
});

test("agent locale overrides do not change the native tool environment unless explicitly declared", () => {
  const { root } = fixture();
  const terminal = { ...process.env, LC_ALL: undefined, LC_CTYPE: undefined, LANGUAGE: undefined };
  const agent = { ...terminal, LC_ALL: "C", LC_CTYPE: "C.UTF-8", LANGUAGE: "de" };
  const expected = checkBaseEnvironment(root, root, terminal);
  expect(checkBaseEnvironment(root, root, agent)).toEqual(expected);
  expect(expected.LANG).toBe(process.env.LANG);
  for (const name of ["LC_ALL", "LC_CTYPE", "LANGUAGE"]) expect(expected).not.toHaveProperty(name);
  const { root: explicit } = fixture([], ["LC_ALL", "LC_CTYPE", "LANGUAGE"]);
  expect(checkBaseEnvironment(explicit, explicit, agent)).toMatchObject({
    LC_ALL: "C",
    LC_CTYPE: "C.UTF-8",
    LANGUAGE: "de",
  });
});

test("Cargo ancestor discovery ignores absent candidates and discovers newly created configuration", () => {
  const { base, root } = fixture(["rust"]);
  const env = checkBaseEnvironment(root, root);
  const config = join(base, ".cargo/config.toml");
  const before = checkConfigurationFiles(root, root, env);
  expect(before).not.toContain(config);
  expect(before).not.toContain(join(root, ".cargo/config.toml"));
  mkdirSync(join(base, ".cargo"));
  writeFileSync(config, "[build]\njobs = 2\n");
  expect(checkConfigurationFiles(root, root, env)).toContain(config);
  rmSync(config);
  expect(checkConfigurationFiles(root, root, env)).toEqual(before);
});

test("user tool configuration bytes invalidate evidence without changing source or printing their contents", () => {
  const { base, root } = fixture(["java"]);
  const home = join(base, "home");
  mkdirSync(join(home, ".m2"), { recursive: true });
  vi.stubEnv("HOME", home);
  const settings = join(home, ".m2/settings.xml");
  writeFileSync(settings, "first settings");
  expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);
  const plan = checkPlan(root, [
    configuredCheck({ name: "fixture", role: "test", command: [process.execPath, "-e", "process.exit(0)"] }),
  ]);
  const env = nativeCheckEnvironment(root, root);
  expect(checkConfigurationFiles(root, root, env)).toContain(settings);
  const before = checkFingerprint(root, {}, plan);
  writeFileSync(settings, "changed private settings");
  const after = checkFingerprint(root, {}, plan);
  expect(after.components.source).toBe(before.components.source);
  expect(after.components.environment).not.toBe(before.components.environment);
  expect(JSON.stringify(after)).not.toContain("private settings");
});

test("default and explicit native selection provide the same environment across agent and terminal contexts", () => {
  const { root } = fixture();
  const file = join(root, "workbench/config.toml");
  writeFileSync(
    file,
    readFileSync(file, "utf8") +
      '\n[development]\ndefault="native"\n[[development.profiles]]\nname="native"\nbuilder="native"\nworkspace="host"\n',
  );
  const explicit = withDevelopmentSelection(root, "native", undefined, () => nativeCheckEnvironment(root, root));
  vi.stubEnv("CODEX_SESSION_ID", "agent-session");
  vi.stubEnv("UNDECLARED_RESOURCE_LIMIT", "100000000");
  const implicit = withDevelopmentSelection(root, undefined, undefined, () => nativeCheckEnvironment(root, root));
  expect(implicit).toEqual(explicit);
});

test("additional configuration file inputs resolve only declared tool variables and detect missing files", () => {
  const { root, base } = fixture([], ["BUILD_SETTINGS_HOME"]);
  vi.stubEnv("BUILD_SETTINGS_HOME", base);
  const file = join(root, "workbench/config.toml");
  writeFileSync(file, readFileSync(file, "utf8") + 'environment_files=["${BUILD_SETTINGS_HOME}/extra.toml"]\n');
  const env = nativeCheckEnvironment(root, root);
  expect(checkConfigurationFiles(root, root, env)).toContain(join(base, "extra.toml"));
  delete env.BUILD_SETTINGS_HOME;
  expect(() => checkConfigurationFiles(root, root, env)).toThrow(/not in the tool environment/);
});
