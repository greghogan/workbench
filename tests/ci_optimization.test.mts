import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

test("grouped execution continues checking other roots after one fails", () => {
  const root = fixture();
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin/workbench.mjs"),
    `import { appendFileSync } from "node:fs"; import { resolve } from "node:path";
     const args=process.argv.slice(2); appendFileSync("events.jsonl", JSON.stringify(args)+"\\n");
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
    'import { appendFileSync } from "node:fs"; appendFileSync("events.jsonl", JSON.stringify(process.argv.slice(2))+"\\n");',
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
    'import { appendFileSync } from "node:fs"; appendFileSync("events.jsonl", JSON.stringify(process.argv.slice(2))+"\\n");',
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
    'import {appendFileSync} from "node:fs"; appendFileSync("events.jsonl",JSON.stringify({args:process.argv.slice(2),roots:JSON.parse(process.env.CHECK_ROOTS)})+"\\n");',
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
    'import {appendFileSync,mkdirSync,writeFileSync} from "node:fs"; import {resolve} from "node:path"; const args=process.argv.slice(2); appendFileSync("events.jsonl",JSON.stringify({args,target:process.env.WORKBENCH_CI_TARGET})+"\\n"); if(args.includes("bad")) process.exitCode=2; if(args.includes("release")){mkdirSync("dist",{recursive:true});writeFileSync("dist/package.txt","standalone");} if(args[0]==="paths") console.log(JSON.stringify({variables:{WORKBENCH_DIST_DIR:resolve("dist")}}));',
  );
  mkdirSync(join(root, "scripts"));
  cpSync(join(repository, "scripts/ci-run.mjs"), join(root, "scripts/ci-run.mjs"));
  cpSync(join(repository, "scripts/ci-contract.mjs"), join(root, "scripts/ci-contract.mjs"));
  cpSync(join(repository, "scripts/values.mjs"), join(root, "scripts/values.mjs"));
  cpSync(join(repository, "scripts/ci-results.mjs"), join(root, "scripts/ci-results.mjs"));
  cpSync(join(repository, "scripts/ci-reports.mjs"), join(root, "scripts/ci-reports.mjs"));
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
