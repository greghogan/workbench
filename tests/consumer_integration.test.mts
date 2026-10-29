import { afterEach, expect, test, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { consumerEnvironment } from "../src/consumer-environment.ts";
import { consumerFault, consumerFaults, consumerSnapshot } from "../src/consumer-integration-fixtures.ts";
import { ConsumerCommands, consumerCommandDiagnostics } from "../src/consumer-integration-runner.ts";
import { ciTargets } from "../src/ci-targets.ts";
import { readCITargets, targetPhases } from "../scripts/ci-contract.mjs";
import { buildPaths } from "../src/builds.ts";

const repository = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-consumer-integration-test-"));
  temporary.push(root);
  return root;
}

test("integration runs once per native platform before release and survives --no-release", () => {
  const targets = ciTargets(repository);
  const integration = targets.filter((target) => target.phases.includes("integration"));
  expect(integration.map((target) => [target.path, target.os, target.architecture])).toEqual([
    [".", "linux", "x64"],
    [".", "linux", "arm64"],
    [".", "macos", "arm64"],
    [".", "windows", "x64"],
  ]);
  for (const target of integration) {
    expect(target.phases).toEqual(["native-install", "native-check", "integration", "release"]);
    expect(target.checks.some((check) => check.role === "integration")).toBe(true);
    expect(targetPhases({ kind: "native", release: false, integration: true })).toEqual([
      "native-install",
      "native-check",
      "integration",
    ]);
  }
  expect(readCITargets(JSON.parse(JSON.stringify(targets)))).toEqual(targets);
  expect(() => readCITargets([{ ...integration[0], integration: "yes" }])).toThrow(/Invalid CI target/);
});

test("consumer context isolates user and outer-gate settings, preserves authentication and CPU allocation", () => {
  const root = fixture();
  const env = consumerEnvironment(
    {
      temporary: root,
      directory: repository,
      launcher: join(repository, "bin/workbench.mjs"),
      prefix: join(root, "npm"),
      languages: [],
      environment: {
        ...process.env,
        WORKBENCH_PROJECT_ROOT: "/outer",
        WORKBENCH_TOOLCHAIN: "outer",
        WORKBENCH_CPU_BUDGET: "2",
        GIT_INDEX_FILE: "/outer/index",
        NODE_OPTIONS: "--bad-option",
        GH_TOKEN: "fixture-authentication",
        RUSTUP_HOME: "/user/rustup",
        CARGO_HOME: "/user/cargo",
        UV_PYTHON_INSTALL_DIR: "/user/python",
      },
    },
    { tools: join(root, "cache"), builds: join(root, "build-cache") },
  );
  expect(env.WORKBENCH_PROJECT_ROOT).toBeUndefined();
  expect(env.WORKBENCH_TOOLCHAIN).toBeUndefined();
  expect(env.GIT_INDEX_FILE).toBeUndefined();
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(env.GH_TOKEN).toBe("fixture-authentication");
  expect(env.WORKBENCH_CPU_BUDGET).toBe("2");
  for (const kind of ["CONFIG", "DATA", "STATE"]) expect(env[`WORKBENCH_${kind}_HOME`]).toContain(root);
  for (const name of ["RUSTUP_HOME", "CARGO_HOME", "UV_PYTHON_INSTALL_DIR"])
    expect(env[name]).toContain(join(root, "cache"));
});

test("consumer build outputs use isolated storage outside Unicode application paths", () => {
  const root = realpathSync.native(fixture()),
    project = join(root, "application space 雪");
  mkdirSync(join(project, "workbench"), { recursive: true });
  writeFileSync(
    join(project, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  writeFileSync(
    join(project, "workbench/projects.toml"),
    '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="rust"\npath="."\n',
  );
  const env = consumerEnvironment(
    {
      temporary: root,
      directory: repository,
      launcher: "unused",
      prefix: join(root, "npm"),
      languages: ["rust"],
      environment: process.env,
    },
    { tools: join(root, "cache"), builds: join(root, "build-cache") },
  );
  for (const [name, value] of Object.entries(env)) if (name.startsWith("WORKBENCH_")) vi.stubEnv(name, value);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", repository);
  const paths = buildPaths(project, project, "native");
  expect(paths.directory.startsWith(join(root, "build-cache"))).toBe(true);
  expect(paths.directory).not.toContain("application space 雪");
});

test("every shipped starter has a distinct behavioral fault and adoption snapshots cover exact bytes", () => {
  const root = fixture();
  const languages = parse(readFileSync(join(repository, "languages/index.toml"), "utf8")) as { languages: string[] };
  for (const language of languages.languages) {
    const metadata = parse(readFileSync(join(repository, `languages/${language}/config.toml`), "utf8")) as {
      reference: string;
    };
    const project = join(root, language);
    const source = consumerFaults[language];
    expect(source).toBeDefined();
    for (const path of [source?.path ?? "", "README.md"]) {
      const destination = join(project, path);
      mkdirSync(resolve(destination, ".."), { recursive: true });
      cpSync(join(repository, metadata.reference, path), destination);
    }
    const fault = consumerFault(language, project);
    expect(fault.broken).not.toBe(fault.original);
    expect(fault.path.startsWith(project)).toBe(true);
    expect(consumerSnapshot(project, ["README.md"])["README.md"]).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(() => consumerFault("unknown", root)).toThrow(/integration fault/);
});

test("commands retain redacted logs and distinguish test rejection, infrastructure failure and unexpected success", async () => {
  const root = fixture();
  vi.stubEnv("WORKBENCH_TEST_TOKEN", "consumer-integration-secret-value");
  const runner = new ConsumerCommands(root, new AbortController().signal);
  const rejected = await runner.run(
    "failure",
    [
      process.execPath,
      "-e",
      "console.log('stdout evidence'); console.error('token=consumer-integration-secret-value'); process.exitCode = 7;",
    ],
    root,
    process.env,
    true,
  );
  expect(rejected.status).toBe(7);
  expect(consumerCommandDiagnostics(rejected).stdout).toContain("stdout evidence");
  expect(runner.results[0]?.status).toBe(7);
  expect(readFileSync(runner.results[0]?.stdout ?? "", "utf8")).toContain("stdout evidence");
  expect(readFileSync(runner.results[0]?.stderr ?? "", "utf8")).not.toContain("consumer-integration-secret-value");
  await expect(runner.run("unexpected-success", [process.execPath, "-e", ""], root, process.env, true)).rejects.toThrow(
    /expected rejection/,
  );
  await expect(runner.run("missing", [join(root, "absent-executable")], root, process.env, true)).rejects.toThrow(
    /ENOENT/,
  );
});

test("cancelling a command drains logs and leaves a new command usable", async () => {
  const root = fixture(),
    controller = new AbortController();
  const runner = new ConsumerCommands(root, controller.signal);
  const ready = join(root, "ready");
  const running = runner.run(
    "cancel",
    [
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`,
    ],
    root,
    process.env,
  );
  const rejected = expect(running).rejects.toThrow(/cancelled/);
  await vi.waitFor(
    () => {
      expect(existsSync(ready)).toBe(true);
    },
    { timeout: 10000 },
  );
  controller.abort();
  await rejected;
  expect(runner.results).toHaveLength(1);
  const logs = join(root, "retry");
  mkdirSync(logs);
  const retry = new ConsumerCommands(logs, new AbortController().signal);
  expect(await retry.capture("retry", [process.execPath, "-e", "console.log('recovered')"], root, process.env)).toBe(
    "recovered\n",
  );
});

test("verbose commands stream complete evidence while explicit queries remain bounded", async () => {
  const root = fixture(),
    runner = new ConsumerCommands(root, new AbortController().signal);
  const command = [process.execPath, "-e", "process.stdout.write('x'.repeat(9 * 1024 * 1024))"];
  const result = await runner.run("verbose", command, root, process.env);
  const diagnostic = consumerCommandDiagnostics(result).stdout;
  expect(diagnostic).toContain("Earlier output omitted");
  expect(diagnostic.length).toBeLessThan(17000);
  expect(readFileSync(runner.results[0]?.stdout ?? "").byteLength).toBe(9 * 1024 * 1024);
  await expect(runner.capture("oversized-query", command, root, process.env)).rejects.toThrow(
    /oversized captured query.*8 MB limit/,
  );
  expect(runner.results[1]?.state).toBe("failed");
});

test("missing log destinations preserve the original command setup failure", async () => {
  const root = fixture(),
    runner = new ConsumerCommands(join(root, "missing"), new AbortController().signal);
  await expect(runner.run("no-logs", [process.execPath, "-e", ""], root, process.env)).rejects.toThrow(
    /log finalization failed/,
  );
  expect(runner.results[0]?.state).toBe("failed");
  expect(runner.results[0]?.error).toContain("ENOENT");
});
