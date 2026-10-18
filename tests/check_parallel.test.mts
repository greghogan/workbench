import { required } from "../src/invariants.ts";
import { spawn } from "node:child_process";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "smol-toml";
import { runChecks } from "../src/checks.ts";
import { checkGroupDependencies } from "../src/check-order.ts";
import { withDevelopmentSelection } from "../src/environments.ts";
import { readConfig } from "../src/core.ts";
import { inspectChecks } from "../src/checks.ts";
import { CheckProgress } from "../src/check-progress.ts";
import { buildPaths, buildLockDirectory } from "../src/builds.ts";

import { waitForCondition } from "./fixtures/coordination.mjs";

const distribution = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(maxJobs = 2, paths = [".", "a", "b", "c"]) {
  const root = mkdtempSync(join(tmpdir(), "workbench-parallel-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  vi.stubEnv("WORKBENCH_CPUS", "1");
  mkdirSync(join(root, "workbench"));
  writeFileSync(join(root, "events.jsonl"), "");
  writeFileSync(
    join(root, "workbench/projects.toml"),
    stringify({
      project: [{ id: "demo", path: "." }],
      language_root: paths.map((path) => ({ path, language: "typescript" })),
    }),
  );
  writeFileSync(
    join(root, "step.mjs"),
    `import {appendFileSync, existsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const [root,id,role]=process.argv.slice(2);
const event=type=>appendFileSync(join(root,'events.jsonl'),JSON.stringify({id,role,type,cpus:process.env.WORKBENCH_CPUS,budget:Number(process.env.WORKBENCH_CPU_BUDGET)})+'\\n');
process.on('SIGINT',()=>{writeFileSync(join(root,'cancelled-'+id),'cancelled');process.exit(130)});
if(role==='test'&&!existsSync('ready'))throw new Error('setup missing');
event('start');
if(role==='setup'&&existsSync(join(root,'hold-setup-'+id))) {
 console.log('WORKBENCH_CHECK_EVENT\\tpass\\t1');
 console.log('WORKBENCH_CHECK_CONTROL\\t'+'f'.repeat(32)+'\\tpass\\t1');
 writeFileSync(join(root,'setup-blocked-'+id),'blocked');
 while(!existsSync(join(root,'release-setup-'+id))) await new Promise(resolve=>setTimeout(resolve,10));
}
if(role==='setup'&&existsSync(join(root,'fail-setup-'+id)))process.exit(29);
if(role==='setup')writeFileSync('ready','ready');
else {
 if(existsSync(join(root,'require-shared-state'))&&id==='.'&&process.env.WORKBENCH_SESSION_TEST!=='from-setup')throw new Error('shared shell state missing');
 if(existsSync(join(root,'hold-'+id))) {
  while(!existsSync(join(root,'release-'+id))) {
   await new Promise(resolve=>setTimeout(resolve,10));
  }
 }
 if(existsSync(join(root,'fail-'+id)))process.exit(29);
}
event('end');
`,
  );
  for (const path of paths) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(
    join(root, "workbench/config.toml"),
    stringify({
      schema_version: 1,
      markdown: { wrap_width: 120 },
      compatibility: { required: false },
      check: paths.flatMap((path) =>
        ["setup", "test"].map((role) => ({
          name: `${path} ${role}`,
          path,
          role,
          command: [process.execPath, join(root, "step.mjs"), root, path, role],
        })),
      ),
    }),
  );
  writeFileSync(join(root, "workbench/local.toml"), stringify({ execution: { max_jobs: maxJobs, cpus_per_job: 1 } }));
  const events = () =>
    readFileSync(join(root, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((text) => JSON.parse(text) as { id: string; role: string; type: string; cpus: string; budget: number });
  return { root, events };
}

test("group dependencies order ancestors and repeated environments without serializing independent siblings", () => {
  const root = resolve("fixture");
  const sessions = ["a", ".", "a/child", "b", "a"].map((path) => ({
    directory: resolve(root, path),
    environment: "native" as const,
    checks: [],
  }));
  expect(checkGroupDependencies(root, sessions, [], false).map((edges) => edges.map((edge) => edge.session))).toEqual([
    [1],
    [],
    [0, 1, 4],
    [1],
    [0, 1],
  ]);
});

test.skipIf(availableParallelism() < 2)(
  "explicit setup overlap ignores forged progress and retains the parent's shell and build lock",
  async () => {
    const { root, events } = fixture(2, [".", "a"]);
    const config = readConfig(root);
    config.check_order = [{ root: "a", after: ".", phase: "setup" }];
    const setup = required(
      config.check?.find((check) => check.path === "." && check.role === "setup"),
      "root setup",
    );
    setup.command = [".", "./setup.sh"];
    writeFileSync(
      join(root, "setup.sh"),
      `"${process.execPath}" "${join(root, "step.mjs")}" "${root}" . setup\nexport WORKBENCH_SESSION_TEST=from-setup\n`,
    );
    writeFileSync(join(root, "workbench/config.toml"), stringify(config));
    for (const name of ["hold-setup-.", "hold-.", "require-shared-state"]) writeFileSync(join(root, name), "hold");
    const inspected = inspectChecks(root, { environment: "native" });
    expect(inspected.execution.sessions.map((session) => session.cpus)).toEqual([1, 1]);
    const pending = runChecks(root, { environment: "native", verbose: true });
    try {
      await waitForCondition(
        () => existsSync(join(root, "setup-blocked-.")),
        pending,
        "blocked setup and forged progress",
      );
      expect(events().some((event) => event.id === "a")).toBe(false);
      writeFileSync(join(root, "release-setup-."), "release");
      await waitForCondition(
        () => events().some((event) => event.id === "a" && event.role === "test" && event.type === "end"),
        pending,
        "dependent root completion while parent is active",
      );
      expect(events().some((event) => event.id === "." && event.role === "test" && event.type === "end")).toBe(false);
      expect(existsSync(buildLockDirectory(buildPaths(root, root, "native").identity))).toBe(true);
      expect(events().every((event) => event.budget === 1)).toBe(true);
    } finally {
      writeFileSync(join(root, "release-setup-."), "release");
      writeFileSync(join(root, "release-."), "release");
      await pending;
    }
  },
);

test("failed setup never admits a dependent root", async () => {
  const { root, events } = fixture(2, [".", "a"]);
  const config = readConfig(root);
  config.check_order = [{ root: "a", after: ".", phase: "setup" }];
  writeFileSync(join(root, "workbench/config.toml"), stringify(config));
  writeFileSync(join(root, "fail-setup-."), "fail");
  await expect(runChecks(root, { environment: "native" })).rejects.toThrow(/failed/);
  expect(events().some((event) => event.id === "a")).toBe(false);
});

test.skipIf(availableParallelism() < 2)(
  "failure after setup drains the admitted child and stops queued roots",
  async () => {
    const { root, events } = fixture(2, [".", "a", "b"]);
    const config = readConfig(root);
    config.check_order = ["a", "b"].map((path) => ({ root: path, after: ".", phase: "setup" }));
    writeFileSync(join(root, "workbench/config.toml"), stringify(config));
    for (const name of ["hold-.", "fail-.", "hold-a"]) writeFileSync(join(root, name), "hold");
    let failed = false;
    const descriptor = required(
      Object.getOwnPropertyDescriptor(CheckProgress.prototype, "finishGroup"),
      "progress descriptor",
    );
    const finish = descriptor.value as CheckProgress["finishGroup"];
    vi.spyOn(CheckProgress.prototype, "finishGroup").mockImplementation(function (this: CheckProgress, ...args) {
      finish.apply(this, args);
      if (args[2]) failed = true;
    });
    const pending = runChecks(root, { environment: "native" });
    const expected = expect(pending).rejects.toThrow(/failed/);
    try {
      await waitForCondition(
        () => events().some((event) => event.id === "a" && event.role === "test" && event.type === "start"),
        pending,
        "admitted child",
      );
      writeFileSync(join(root, "release-."), "release");
      await waitForCondition(() => failed, pending, "parent failure");
      expect(events().some((event) => event.id === "b")).toBe(false);
    } finally {
      writeFileSync(join(root, "release-."), "release");
      writeFileSync(join(root, "release-a"), "release");
      await expected;
    }
    expect(events().some((event) => event.id === "a" && event.type === "end" && event.role === "test")).toBe(true);
    expect(events().some((event) => event.id === "b")).toBe(false);
  },
);

test.skipIf(availableParallelism() < 2)(
  "root gates precede bounded sibling execution with ordered setup and allocated CPUs",
  async () => {
    const { root, events } = fixture();
    for (const id of ["a", "b"]) writeFileSync(join(root, `hold-${id}`), "hold");
    const pending = runChecks(root, { environment: "native" });
    try {
      await waitForCondition(
        () =>
          ["a", "b"].every((id) =>
            events().some((event) => event.id === id && event.role === "test" && event.type === "start"),
          ),
        pending,
        "both admitted siblings to announce readiness",
      );
    } finally {
      for (const id of ["a", "b"]) writeFileSync(join(root, `release-${id}`), "release");
      await pending;
    }
    const records = events();
    const rootEnd = records.findIndex((event) => event.id === "." && event.role === "test" && event.type === "end");
    expect(rootEnd).toBeGreaterThanOrEqual(0);
    let active = 0,
      peak = 0;
    for (const [index, event] of records.entries()) {
      expect(event.cpus).toBe("1");
      if (event.id !== ".") expect(index).toBeGreaterThan(rootEnd);
      if (event.role === "test") {
        active += event.type === "start" ? 1 : -1;
        peak = Math.max(peak, active);
        expect(active).toBeLessThanOrEqual(2);
      }
    }
    expect(active).toBe(0);
    expect(peak).toBe(2);
    for (const id of [".", "a", "b", "c"])
      expect(records.filter((event) => event.id === id).map(({ role, type }) => `${role}:${type}`)).toEqual([
        "setup:start",
        "setup:end",
        "test:start",
        "test:end",
      ]);
  },
);

test("max_jobs=1 preserves serial execution", async () => {
  const { root, events } = fixture(1, ["a", "b"]);
  await runChecks(root, { environment: "native" });
  expect(
    events()
      .filter((event) => event.role === "test")
      .map(({ id, type }) => `${id}:${type}`),
  ).toEqual(["a:start", "a:end", "b:start", "b:end"]);
});

test("failed groups prevent new admission while active work drains", async () => {
  const { root, events } = fixture(1, ["a", "b"]);
  writeFileSync(join(root, "fail-a"), "fail");
  await expect(runChecks(root, { environment: "native" })).rejects.toThrow(/failed/);
  expect(events().some((event) => event.id === "b")).toBe(false);
});

test.skipIf(availableParallelism() < 2)("a failed sibling waits for admitted work before returning", async () => {
  const { root, events } = fixture(2, ["a", "b", "c"]);
  writeFileSync(join(root, "fail-a"), "fail");
  writeFileSync(join(root, "hold-b"), "hold");
  const descriptor = required(
    Object.getOwnPropertyDescriptor(CheckProgress.prototype, "finishGroup"),
    "Original progress method descriptor",
  );
  const finish = descriptor.value as CheckProgress["finishGroup"];
  vi.spyOn(CheckProgress.prototype, "finishGroup").mockImplementation(function (this: CheckProgress, ...args) {
    finish.apply(this, args);
    if (args[2]) writeFileSync(join(root, "release-b"), "failure observed");
  });
  await expect(runChecks(root, { environment: "native" })).rejects.toThrow(/failed/);
  expect(events().some((event) => event.id === "b" && event.role === "test" && event.type === "end")).toBe(true);
  expect(events().some((event) => event.id === "c")).toBe(false);
});

test.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM"] as const)(
  "%s cancels the active command, stops later steps and queued groups, and releases the root lock",
  async (signal) => {
    const { root, events } = fixture(1, ["a", "b"]);
    writeFileSync(join(root, "hold-a"), "hold");
    const wrapper = join(root, "interrupt.mjs");
    writeFileSync(
      wrapper,
      `import {writeFileSync} from 'node:fs';process.on(${JSON.stringify(signal)},()=>writeFileSync(${JSON.stringify(join(root, "signal-observed"))},'observed'));await import(${JSON.stringify(new URL("../bin/workbench.mjs", import.meta.url).href)});`,
    );
    const report = join(root, "cancelled-report.json");
    const child = spawn(
      process.execPath,
      [wrapper, "check", "--role", "test", "--environment", "native", "--report", report],
      {
        cwd: root,
        env: { ...process.env, WORKBENCH_PROJECT_ROOT: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const closed = new Promise((resolve) => {
      child.once("close", resolve);
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    try {
      await waitForCondition(
        () => events().some((event) => event.id === "a" && event.role === "test" && event.type === "start"),
        closed,
        "active worker readiness",
      );
      const paths = buildPaths(root, join(root, "a"), "native");
      expect(existsSync(buildLockDirectory(paths.identity))).toBe(true);
      child.kill(signal);
      await waitForCondition(() => existsSync(join(root, "signal-observed")), closed, "interruption acknowledgment");
      expect(await closed).toBe(130);
      expect(existsSync(join(root, "cancelled-a"))).toBe(true);
      expect(events().some((event) => event.id === "a" && event.role === "test" && event.type === "end")).toBe(false);
      expect(events().some((event) => event.id === "b")).toBe(false);
      expect(existsSync(buildLockDirectory(paths.identity))).toBe(false);
      expect(output).not.toContain("test coordinator did not release worker");
      expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({
        success: false,
        runs: [
          {
            status: "cancelled",
            logs: expect.any(String) as unknown,
            checks: [{ status: "passed" }, { status: "cancelled" }, { status: "pending" }, { status: "pending" }],
          },
        ],
      });
    } finally {
      writeFileSync(join(root, "release-a"), "release");
      if (child.exitCode === null) child.kill("SIGTERM");
      await closed;
    }
  },
);

test("development context remains selected until asynchronous work settles and restores on rejection", async () => {
  const { root } = fixture(1, ["a"]);
  vi.stubEnv("WORKBENCH_PROFILE_CONTEXT", "previous");
  const gate = Promise.withResolvers<undefined>();
  const pending = withDevelopmentSelection(root, "native", undefined, async () => {
    await gate.promise;
    expect(process.env.WORKBENCH_PROFILE_CONTEXT).toBe("");
    throw new Error("work failed");
  });
  expect(process.env.WORKBENCH_PROFILE_CONTEXT).toBe("");
  gate.resolve(undefined);
  await expect(pending).rejects.toThrow(/work failed/);
  expect(process.env.WORKBENCH_PROFILE_CONTEXT).toBe("previous");
});
