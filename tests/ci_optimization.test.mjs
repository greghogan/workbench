import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { sharedPlan } from "../scripts/ci-plan.mjs";
import { ciMatrix } from "../src/ci.ts";

const repository = resolve(import.meta.dirname, "..");
const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "workbench-ci-cache-"));
  temporary.push(path);
  return path;
}

test("shared CI setup preserves every configured root and target", () => {
  const original = ciMatrix(repository);
  const shared = sharedPlan(original);
  for (const [section, fields] of [
    ["native", ["os", "architecture", "runner", "node"]],
    ["compatibility", ["runtime", "version", "architecture", "runner", "node"]],
    ["environments", ["environment", "node"]],
  ]) {
    const key = (entry, path) => JSON.stringify([path, ...fields.map((field) => entry[field] ?? "")]);
    const before = original[section].include.map((entry) => key(entry, entry.path)).sort();
    const after = shared[section].include.flatMap((entry) => entry.paths.map((path) => key(entry, path))).sort();
    expect(after).toEqual(before);
  }
  expect(shared.native.include).toHaveLength(4);
  expect(shared.compatibility.include.filter((entry) => entry.runtime === "gcc")).toHaveLength(6);
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
    `import { appendFileSync } from "node:fs"; const args=process.argv.slice(2); appendFileSync("events.jsonl", JSON.stringify(args)+"\\n"); if(args.includes("bad")) process.exitCode=2;`,
  );
  const result = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "environment"], {
    cwd: root,
    env: { ...process.env, CHECK_ROOTS: '["bad","good"]', CHECK_ENVIRONMENT: "guix" },
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
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
  const nativeEvents = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(nativeEvents).toHaveLength(3);
  expect(nativeEvents[2]).toContain("good");
  expect(nativeEvents[2]).toContain("checks");
});

test("CI cache keys isolate runtime targets and exclude oversized installations", () => {
  const root = fixture();
  const environment = join(root, "environment");
  const output = join(root, "output");
  const run = (version) => {
    writeFileSync(environment, "");
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [join(repository, "scripts/ci-cache.mjs")], {
      cwd: repository,
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        GITHUB_ENV: environment,
        GITHUB_OUTPUT: output,
        CACHE_TARGET: JSON.stringify({ runtime: "node", version, paths: ["."] }),
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(
      [...readFileSync(output, "utf8").matchAll(/^([^\n]+)<<WORKBENCH_CACHE\n([\s\S]*?)\nWORKBENCH_CACHE\n/gm)].map(
        (match) => [match[1], match[2]],
      ),
    );
  };
  const oldest = run("22.23.3");
  const newest = run("26.10.0");
  expect(oldest["dependencies-key"]).not.toBe(newest["dependencies-key"]);
  expect(oldest["tools-key"]).toBe(newest["tools-key"]);
  expect(oldest["tools-paths"]).not.toMatch(/toolchains[\\/](llvm|clang|gcc)/);
  expect(oldest["dependencies-paths"]).toContain(join(root, "workbench-ci", "cache", "dependencies"));
  expect(oldest["dependencies-paths"]).not.toMatch(/\/nix\/store|\/gnu\/store/);
  expect(readFileSync(environment, "utf8")).toContain("WORKBENCH_STORAGE_EXTERNAL=true");
});
