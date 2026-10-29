import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyScriptClosure } from "./fixtures/script-closure.mjs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import type { RunReport } from "../scripts/ci-results.mjs";
import { targetPhases, type TargetSelection } from "../scripts/ci-contract.mjs";
import { groupedCIMatrix } from "../src/ci-targets.ts";
import { ciMatrix } from "../src/ci.ts";
import { ciCacheFixtures } from "./fixtures/ci-cache.mjs";

const repository = resolve(import.meta.dirname, "..");

const fixture = ciCacheFixtures();

test("shared CI setup preserves every configured root and target", () => {
  const original = ciMatrix(repository);
  const shared = groupedCIMatrix(original);
  for (const [section, fields] of [
    ["native", ["os", "architecture", "runner", "node"]],
    ["compatibility", ["runtime", "version", "architecture", "runner", "node"]],
    ["environments", ["environment", "node"]],
  ] as const) {
    const key = (entry: object, path: string) =>
      JSON.stringify([
        path,
        ...required(fields, "Expected fixture value: fields").map(
          (field: string | number) => (Reflect.get(entry, field) as unknown) ?? "",
        ),
      ]);
    const before = original[section].include.map((entry) => key(entry, entry.path)).sort();
    const after = shared[section].include
      .flatMap((entry) => entry.selections.map((selection) => key(selection, selection.path)))
      .sort();
    expect(after).toEqual(before);
  }
  expect(shared.native.include).toHaveLength(4);
  expect(
    shared.native.include
      .filter((entry) => entry.os === "linux")
      .flatMap((entry) => entry.selections.filter((selection) => selection.toolchain === "gcc")),
  ).toHaveLength(4);
  expect(
    shared.compatibility.include.filter((entry) => entry.runtime === "gcc").every((entry) => entry.paths.length === 2),
  ).toBe(true);
  expect(shared.environments.include).toHaveLength(2);
  expect(shared.devcontainer).toEqual(original.devcontainer);
});

test("integration CI preserves fresh failure evidence independently of coverage cleanup and old reports", () => {
  const root = fixture();
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "build/consumer-integration/stale"), { recursive: true });
  writeFileSync(join(root, "build/consumer-integration/stale/results.json"), '{"stale":true}');
  writeFileSync(
    join(root, "bin/workbench.mjs"),
    `import {mkdirSync,writeFileSync} from 'node:fs';
if(process.argv[2]==='project' && process.argv[3]==='add') process.exit(0);
mkdirSync('build/consumer-integration/current', {recursive:true});
writeFileSync('build/consumer-integration/current/results.json', '{"success":false}');
writeFileSync('build/consumer-integration/current/command.log', 'actual failure evidence');
process.exitCode=2;\n`,
  );
  const result = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "integration"], {
    cwd: root,
    env: {
      ...process.env,
      WORKBENCH_DISTRIBUTION_ROOT: root,
      CHECK_ROOTS: '["."]',
      RUNNER_TEMP: join(root, "reports"),
    },
    encoding: "utf8",
  });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  const reports = join(root, "reports/consumer-integration/0");
  expect(readFileSync(join(reports, "current/results.json"), "utf8")).toBe('{"success":false}');
  expect(readFileSync(join(reports, "current/command.log"), "utf8")).toBe("actual failure evidence");
  expect(existsSync(join(reports, "stale"))).toBe(false);
  writeFileSync(join(root, "blocked-reports"), "user file");
  const blocked = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "integration"], {
    cwd: root,
    env: {
      ...process.env,
      WORKBENCH_DISTRIBUTION_ROOT: root,
      CHECK_ROOTS: '["."]',
      RUNNER_TEMP: join(root, "blocked-reports"),
    },
    encoding: "utf8",
  });
  expect(blocked.status).toBe(1);
  expect(blocked.stderr).toContain("Integration check and report collection failed");
  expect(blocked.stderr).toContain("failed: 2");
  expect(readFileSync(join(root, "blocked-reports"), "utf8")).toBe("user file");
});

test("grouped execution continues checking other roots after one fails", () => {
  const root = fixture();
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin/workbench.mjs"),
    `import { appendFileSync } from "node:fs"; import { resolve } from "node:path";
     const args=process.argv.slice(2); if(args[0]==="project" && args[1]==="add") process.exit(0); appendFileSync("events.jsonl", JSON.stringify(args)+"\\n");
     if(args.includes("bad")) process.exitCode=2;
     else if(args[0]==="paths") console.log(JSON.stringify({variables:{WORKBENCH_DIST_DIR:resolve(args[args.indexOf("--path")+1],"dist")}}));`,
  );
  const result = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "environment"], {
    cwd: root,
    env: { ...process.env, CHECK_ROOTS: '["bad","good"]', CHECK_ENVIRONMENT: "guix" },
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  const events = readFileSync(join(root, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((text) => JSON.parse(text) as string[]);
  expect(events).toHaveLength(2);
  expect(events[0]).toContain("bad");
  expect(events[1]).toContain("good");
  writeFileSync(join(root, "events.jsonl"), "");
  const output = join(root, "output");
  const native = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "native"], {
    cwd: root,
    env: { ...process.env, CHECK_ROOTS: '["bad","good"]', GITHUB_OUTPUT: output },
    encoding: "utf8",
  });
  expect(native.status).toBe(1);
  expect(readFileSync(output, "utf8")).toBe('roots=["good"]\n');
  const nativeEvents = readFileSync(join(root, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((text) => JSON.parse(text) as string[]);
  expect(nativeEvents).toHaveLength(3);
  expect(nativeEvents[2]).toContain("good");
  expect(nativeEvents[2]).toContain("check");
  mkdirSync(join(root, "good/dist"), { recursive: true });
  writeFileSync(join(root, "good/dist/package.txt"), "verified fixture");
  writeFileSync(output, "");
  const releases = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "release"], {
    cwd: root,
    env: { ...process.env, CHECK_ROOTS: '["bad","good"]', GITHUB_OUTPUT: output, RUNNER_TEMP: root },
    encoding: "utf8",
  });
  expect(releases.status).toBe(1);
  expect(readFileSync(output, "utf8")).toBe('roots=["good"]\n');
  expect(readFileSync(join(root, "release-artifacts/1.txt"), "utf8")).toBe("good\n");
  expect(existsSync(join(root, "release-artifacts/1.tar.gz"))).toBe(true);
  const releaseEvents = readFileSync(join(root, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((text) => JSON.parse(text) as string[]);
  expect(releaseEvents).toContainEqual([
    "check",
    "--role",
    "release-verify",
    "--path",
    "good",
    "--environment",
    "native",
  ]);
});

test("Python compatibility delegates the selected version to configured compatibility checks", () => {
  const root = fixture();
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin/workbench.mjs"),
    'import { appendFileSync } from "node:fs"; if(process.argv[2]==="project" && process.argv[3]==="add") process.exit(0); appendFileSync("events.jsonl", JSON.stringify(process.argv.slice(2))+"\\n");',
  );
  const result = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "python"], {
    cwd: root,
    env: { ...process.env, CHECK_ROOTS: '["python"]', PYTHON_VERSION: "3.11.17" },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const events = readFileSync(join(root, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((text) => JSON.parse(text) as string[]);
  expect(events).toEqual([["compatibility-exec", "python", "python", "3.11.17", "--checks"]]);
});

test("compiler compatibility executes ordinary, sanitizer, and optimized release checks with the same selection", () => {
  const root = fixture();
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin/workbench.mjs"),
    'import { appendFileSync } from "node:fs"; if(process.argv[2]==="project" && process.argv[3]==="add") process.exit(0); appendFileSync("events.jsonl", JSON.stringify(process.argv.slice(2))+"\\n");',
  );
  const result = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "compiler"], {
    cwd: root,
    env: {
      ...process.env,
      CHECK_ROOTS: '["native"]',
      COMPILER: "gcc",
      COMPILER_VERSION: "14.4.0",
      CHECK_ROLES: '["test","sanitizers","lto"]',
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const events = readFileSync(join(root, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((text) => JSON.parse(text) as string[]);
  expect(events).toEqual(
    ["test", "sanitizers", "lto"].map((role) => [
      "check",
      "--role",
      role,
      "--path",
      "native",
      "--environment",
      "native",
      "--compiler",
      "gcc",
      "--compiler-version",
      "14.4.0",
    ]),
  );
  const installation = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "compiler-install"], {
    cwd: root,
    env: { ...process.env, CHECK_ROOTS: '["native"]', COMPILER: "gcc", COMPILER_VERSION: "14.4.0" },
    encoding: "utf8",
  });
  expect(installation.status, installation.stderr).toBe(0);
  expect(
    JSON.parse(
      required(
        readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").at(-1),
        'Fixture value readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\\n").at',
      ),
    ),
  ).toEqual(["tools", "install", "--path", "native", "--compiler", "gcc", "--compiler-version", "14.4.0"]);
});

test("compatibility wrapper selects one verified runtime per root and forwards the exact version", () => {
  const root = fixture();
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin/workbench.mjs"),
    'import {appendFileSync} from "node:fs"; if(process.argv[2]==="project" && process.argv[3]==="add") process.exit(0); appendFileSync("events.jsonl",JSON.stringify({args:process.argv.slice(2),roots:JSON.parse(process.env.CHECK_ROOTS)})+"\\n");',
  );
  const result = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "compatibility"], {
    cwd: root,
    env: { ...process.env, CHECK_ROOTS: '["one","two"]', RUNTIME: "go", RUNTIME_VERSION: "1.26.8" },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const events = readFileSync(join(root, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((text) => JSON.parse(text) as { args: string[]; roots: string[] });
  expect(events.map(({ roots }) => roots)).toEqual([["one"], ["two"]]);
  expect(events.map(({ args }) => args.slice(0, 4))).toEqual([
    ["compatibility-exec", "one", "go", "1.26.8"],
    ["compatibility-exec", "two", "go", "1.26.8"],
  ]);
});

test("local guest executes the shared phases, retains releases separately, and continues after target failure", () => {
  const root = fixture();
  const reports = join(root, "reports");
  mkdirSync(join(root, "bin"));
  mkdirSync(reports);
  writeFileSync(
    join(root, "bin/workbench.mjs"),
    'import {appendFileSync,mkdirSync,writeFileSync} from "node:fs"; import {resolve} from "node:path"; const args=process.argv.slice(2); if(args[0]==="project" && args[1]==="add") process.exit(0); appendFileSync("events.jsonl",JSON.stringify({args,target:process.env.WORKBENCH_CI_TARGET})+"\\n"); if(args.includes("bad")) process.exitCode=2; if(args.includes("release")){mkdirSync("dist",{recursive:true});writeFileSync("dist/package.txt","standalone");} if(args[0]==="paths") console.log(JSON.stringify({variables:{WORKBENCH_DIST_DIR:resolve("dist")}}));',
  );
  mkdirSync(join(root, "scripts"));
  copyScriptClosure(repository, root, "scripts/ci-run.mjs");
  const selections: (TargetSelection & { id: string; path: string })[] = [
    { id: "bad", kind: "native", path: "bad", release: true },
    { id: "good", kind: "native", path: ".", release: true },
    {
      id: "compiler",
      kind: "compatibility",
      path: ".",
      runtime: "clang",
      release: false,
      version: "22.1.8",
      roles: ["test", "sanitizers", "lto"],
    },
    {
      id: "python",
      kind: "compatibility",
      path: ".",
      runtime: "python",
      version: "3.11.17",
      release: false,
      roles: ["test"],
    },
    {
      id: "node",
      kind: "compatibility",
      path: ".",
      runtime: "node",
      version: "22.23.3",
      release: false,
      roles: ["test"],
    },
  ];
  const targets = selections.map((selection) => ({
    ...selection,
    os: "linux",
    architecture: "x64",
    environment: "native",
    phases: targetPhases(selection),
    checks: [],
  }));
  writeFileSync(join(root, "targets.json"), JSON.stringify(targets));
  const result = spawnSync(process.execPath, [join(repository, "scripts/ci-linux/run.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      WORKBENCH_DISTRIBUTION_ROOT: root,
      WORKBENCH_CI_TARGETS: join(root, "targets.json"),
      HOME: join(root, "home"),
      RUNNER_TEMP: reports,
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(1);
  const results = (JSON.parse(readFileSync(join(reports, "guest-results.json"), "utf8")) as RunReport).targets;
  expect(
    results.map(({ success }) => success),
    result.stdout + result.stderr,
  ).toEqual([false, true, true, true, true]);
  expect(existsSync(join(required(results[1], "Release result").report, "release-artifacts/0.tar.gz"))).toBe(true);
  expect(readFileSync(join(required(results[1], "Release result").report, "release-artifacts/0.txt"), "utf8")).toBe(
    ".\n",
  );
  const events = readFileSync(join(root, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((text) => JSON.parse(text) as { args: string[]; target: string });
  expect(events.filter(({ target }) => target === "bad")).toHaveLength(1);
  expect(
    events
      .filter(({ target, args }) => target === "compiler" && args.includes("--role"))
      .map(({ args }) => args[args.indexOf("--role") + 1]),
  ).toEqual(["test", "sanitizers", "lto"]);
  expect(
    required(
      events.find(({ target, args }) => target === "node" && args.includes("compatibility-exec")),
      "Node invocation",
    ).args,
  ).toContain("22.23.3");
});
