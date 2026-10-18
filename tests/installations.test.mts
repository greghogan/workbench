import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test, vi } from "vitest";
import { installLauncher } from "../src/installation-commands.ts";
import { toolSpecification, readToolPin, executingToolPin } from "../src/launcher.ts";
import { distribution, consumer } from "./fixtures/adoption.mjs";
import { installationFixtures, pin } from "./fixtures/installations.mjs";

const { fixture, temporary } = installationFixtures();

test("an installed user launcher rejects unsupported Node before invoking npm", () => {
  const root = fixture();
  const file = installLauncher(root, { directory: join(root, "bin"), ...pin });
  const result = spawnSync(
    process.execPath,
    ["-e", `Object.defineProperty(process.versions,'node',{value:'18.20.7'}); require(${JSON.stringify(file)});`],
    { cwd: root, env: { ...process.env, npm_execpath: join(root, "npm-cli.js") }, encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Node.js 18.20.8 or newer is required to bootstrap Workbench");
  expect(result.stderr).not.toContain("Cannot locate npm-cli.js");
  expect(result.stdout).toBe("");
});

test("a user launcher selects exact project revisions and preserves arguments and working directory", async () => {
  const root = fixture();
  const file = installLauncher(root, { directory: join(root, "bin"), ...pin });
  const fakeNpm = join(root, "npm-cli.mjs"),
    output = join(root, "invocation.json");
  writeFileSync(
    fakeNpm,
    `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.INVOCATION, JSON.stringify({argv:process.argv.slice(2), cwd:process.cwd(), spec:process.env.WORKBENCH_EXECUTING_SPEC}));`,
  );
  const project = await consumer();
  temporary.push(project);
  const selected = { ...pin, revision: "b".repeat(40) };
  writeFileSync(
    join(project, "workbench/config.toml"),
    readFileSync(join(project, "workbench/config.toml"), "utf8") +
      `\n[tool]\nrepository="${selected.repository}"\nrevision="${selected.revision}"\n`,
  );
  const nested = join(project, "nested");
  mkdirSync(nested);
  const result = spawnSync(process.execPath, [file, "record", "add", "task", "literal $HOME and spaces"], {
    cwd: nested,
    env: { ...process.env, npm_execpath: fakeNpm, INVOCATION: output },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const invocation = JSON.parse(readFileSync(output, "utf8")) as { cwd: string; spec: string; argv: string[] };
  expect(invocation.cwd).toBe(nested);
  expect(invocation.spec).toBe(toolSpecification(selected));
  expect(invocation.argv).toEqual([
    "exec",
    "--yes",
    `--package=${toolSpecification(selected)}`,
    "--",
    "workbench",
    "record",
    "add",
    "task",
    "literal $HOME and spaces",
  ]);
});

test("launcher installation installs completion for the detected shell", () => {
  const root = fixture();
  vi.stubEnv("SHELL", "/bin/bash");
  installLauncher(root, { directory: join(root, "bin"), ...pin });
  const completion = join(root, "data/bash-completion/completions/workbench");
  expect(readFileSync(completion, "utf8")).toContain("complete -o default -F _workbench_complete workbench");
  expect(existsSync(join(root, ".bashrc"))).toBe(false);
});

test("launcher installation preserves unrelated executables and can update only its own launcher", () => {
  const root = fixture(),
    directory = join(root, "bin");
  mkdirSync(directory);
  const file = join(directory, process.platform === "win32" ? "workbench.cjs" : "workbench");
  writeFileSync(file, "user-owned command");
  expect(() => installLauncher(root, { directory, ...pin })).toThrow(/preserving/);
  expect(readFileSync(file, "utf8")).toBe("user-owned command");
  rmSync(file);
  installLauncher(root, { directory, ...pin });
  installLauncher(root, { directory, ...pin, revision: "c".repeat(40) });
  expect(readFileSync(file, "utf8")).toContain("c".repeat(40));
  if (process.platform !== "win32") chmodSync(file, 0o755);
  expect((process.env.PATH ?? "").split(delimiter)).not.toContain(directory);
});

test("tool pins reject moving branches and do not depend on a collection declaration", () => {
  const root = fixture();
  mkdirSync(join(root, "workbench"));
  writeFileSync(
    join(root, "workbench/config.toml"),
    `[tool]\nrepository="${pin.repository}"\nrevision="${pin.revision}"\n`,
  );
  expect(readToolPin(root)).toEqual(pin);
  expect(() => toolSpecification({ ...pin, revision: "main" })).toThrow(/immutable/);
  expect(() => toolSpecification({ ...pin, repository: "https://forge.example/repo.git\necho secret" })).toThrow();
});

test.each([
  ["https://github.com/example/workbench.git", "git+https://github.com/example/workbench.git"],
  ["https://gitlab.com/team/subgroup/workbench.git", "git+https://gitlab.com/team/subgroup/workbench.git"],
  ["https://forge.example:8443/tools/workbench.git", "git+https://forge.example:8443/tools/workbench.git"],
  ["https://forge.example", "git+https://forge.example/"],
  [
    "ssh://developer@forge.example:2222/team/workbench.git",
    "git+ssh://developer@forge.example:2222/team/workbench.git",
  ],
  ["git+https://forge.example/team/workbench.git", "git+https://forge.example/team/workbench.git"],
  ["git+ssh://git@[::1]:2222/team/workbench.git", "git+ssh://git@[::1]:2222/team/workbench.git"],
])("tool pins normalize repository URL %s", (repository, expected) => {
  expect(toolSpecification({ repository, revision: pin.revision })).toBe(`${expected}#${pin.revision}`);
  const revision = "b".repeat(64);
  expect(toolSpecification({ repository, revision })).toBe(`${expected}#${revision}`);
});

test.each([
  "http://forge.example/team/workbench.git",
  "git://forge.example/team/workbench.git",
  "file:///tmp/workbench",
  "github:example/workbench",
  "@workbench/cli",
  "--package=other",
  "https://",
  "ssh:///team/workbench.git",
  "https://forge.example/team/workbench.git#main",
  "https://forge.example/team/workbench.git?token=secret",
  "https://token@forge.example/team/workbench.git",
  "ssh://git:secret@forge.example/team/workbench.git",
  "https://forge.example\\team/workbench.git",
])("tool pins reject invalid or ambiguous repository source %s", (repository) => {
  expect(() => toolSpecification({ repository, revision: pin.revision })).toThrow(/tool/);
});

test.each([
  "git+https://forge.example/team/workbench.git",
  "git+ssh://developer@forge.example:2222/team/workbench.git",
])("executing pin comes from npm metadata for %s", (repository) => {
  const root = fixture(),
    distribution = join(root, "node_modules/@workbench/cli");
  mkdirSync(distribution, { recursive: true });
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({ packages: { "node_modules/@workbench/cli": { resolved: `${repository}#${pin.revision}` } } }),
  );
  vi.stubEnv("WORKBENCH_EXECUTING_SPEC", `git+https://different.example/workbench.git#${"c".repeat(40)}`);
  expect(executingToolPin(distribution)).toEqual({ repository, revision: pin.revision });
});

test.each([
  ["https://forge.example/team/workbench.git", "npm"],
  ["ssh://developer@forge.example:2222/team/workbench.git", "npm"],
  ["https://forge.example/team/workbench.git", "package"],
  ["ssh://developer@forge.example:2222/team/workbench.git", "package"],
])("the acquired launcher recognizes its pinned URL without invoking npm again: %s (%s)", (repository, source) => {
  const root = fixture(),
    acquired = join(root, source === "npm" ? "node_modules/@workbench/cli" : "package"),
    project = join(root, "project"),
    runner = join(root, "run.mjs");
  mkdirSync(join(acquired, "bundle"), { recursive: true });
  mkdirSync(join(project, "workbench"), { recursive: true });
  const specification = toolSpecification({ ...pin, repository });
  if (source === "npm")
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/@workbench/cli": { resolved: specification } } }),
    );
  else
    writeFileSync(
      join(acquired, "workbench-source.json"),
      JSON.stringify({ schema_version: 1, repository, revision: pin.revision }),
    );
  writeFileSync(
    join(project, "workbench/config.toml"),
    `[tool]\nrepository="${repository}"\nrevision="${pin.revision}"\n`,
  );
  writeFileSync(
    join(acquired, "bundle/main.cjs"),
    "console.log(JSON.stringify({argv:process.argv.slice(2),spec:process.env.WORKBENCH_EXECUTING_SPEC}));\n",
  );
  writeFileSync(
    runner,
    `import {createRequire} from 'node:module'; const launcher=createRequire(import.meta.url)(${JSON.stringify(join(distribution, "bundle/launcher.cjs"))}); await launcher.launch(process.argv.slice(2),undefined,${JSON.stringify(acquired)});\n`,
  );
  const result = spawnSync(process.execPath, [runner, "literal argument"], {
    cwd: project,
    env: {
      ...process.env,
      npm_execpath: join(root, "npm-cli.js"),
      WORKBENCH_EXECUTING_SPEC: `git+https://different.example/workbench.git#${"c".repeat(40)}`,
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ argv: ["literal argument"], spec: specification });
});

test("packaged identity agrees with npm metadata and overrides inherited dispatch context", () => {
  const root = fixture(),
    acquired = join(root, "node_modules/@workbench/cli");
  mkdirSync(acquired, { recursive: true });
  writeFileSync(join(acquired, "workbench-source.json"), JSON.stringify({ schema_version: 1, ...pin }));
  vi.stubEnv("WORKBENCH_EXECUTING_SPEC", `git+https://different.example/workbench.git#${"c".repeat(40)}`);
  expect(executingToolPin(acquired)).toEqual({ ...pin, repository: `git+${pin.repository}` });
  const lock = join(root, "package-lock.json");
  writeFileSync(
    lock,
    JSON.stringify({ packages: { "node_modules/@workbench/cli": { resolved: toolSpecification(pin) } } }),
  );
  expect(executingToolPin(acquired)).toEqual({ ...pin, repository: `git+${pin.repository}` });
  writeFileSync(
    lock,
    JSON.stringify({
      packages: {
        "node_modules/@workbench/cli": { resolved: toolSpecification({ ...pin, revision: "c".repeat(40) }) },
      },
    }),
  );
  expect(() => executingToolPin(acquired)).toThrow(/source identity conflicts with npm/);
});

test("an invalid packaged repository does not fall back to inherited dispatch context", () => {
  const root = fixture();
  writeFileSync(
    join(root, "workbench-source.json"),
    JSON.stringify({ schema_version: 1, ...pin, repository: "https://token@forge.example/workbench.git" }),
  );
  vi.stubEnv("WORKBENCH_EXECUTING_SPEC", toolSpecification(pin));
  expect(() => executingToolPin(root)).toThrow(/tool/);
});

test.each([[null], [42], [[]], [{}]])("invalid npm metadata supplies no executing pin: %j", (resolved) => {
  const root = fixture(),
    acquired = join(root, "node_modules/@workbench/cli");
  mkdirSync(acquired, { recursive: true });
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({ packages: { "node_modules/@workbench/cli": { resolved } } }),
  );
  expect(executingToolPin(acquired)).toBeUndefined();
});

test("executing pin validates the inherited source and commit when npm metadata is unavailable", () => {
  const root = fixture();
  vi.stubEnv("WORKBENCH_EXECUTING_SPEC", toolSpecification(pin));
  expect(executingToolPin(root)).toEqual({ ...pin, repository: `git+${pin.repository}` });
  for (const invalid of [
    `${pin.repository}#main`,
    `${pin.repository}#${pin.revision}#extra`,
    `https://token@forge.example/workbench.git#${pin.revision}`,
  ]) {
    vi.stubEnv("WORKBENCH_EXECUTING_SPEC", invalid);
    expect(executingToolPin(root)).toBeUndefined();
  }
});
