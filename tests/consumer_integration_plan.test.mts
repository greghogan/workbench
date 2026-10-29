import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parse } from "smol-toml";
import { executeConsumerProfiles, planConsumerProfiles } from "../src/consumer-integration-plan.ts";
import { configureConsumerCompiler, enableAdoptedApplicationChecks } from "../src/consumer-integration-fixtures.ts";
import { ConsumerReportRecorder, readConsumerIntegrationReport } from "../src/consumer-integration-report.ts";
import { resolveNativeTool } from "../src/native-installation.ts";
import { runConsumerSuite } from "../src/consumer-integration-scenarios.ts";
import { CheckCancellation } from "../src/check-cancellation.ts";
import { createOwnedScratch } from "../scripts/owned-scratch.mjs";
const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "workbench-consumer-plan-"));
  roots.push(path);
  mkdirSync(join(path, "workbench"));
  return path;
}
test("profiles preserve language selection and route explicit compilers only to supported hosts", () => {
  expect(planConsumerProfiles(["c", "typescript", "cpp"], undefined, "win32", "x64")).toEqual([
    { id: "pins", languages: ["c", "typescript", "cpp"] },
    { id: "mvsc", languages: ["c", "cpp"], compiler: "mvsc" },
  ]);
  expect(planConsumerProfiles(["c"], ["clang", "gcc"], "linux", "x64").map((profile) => profile.id)).toEqual([
    "clang",
    "gcc",
  ]);
  expect(() => planConsumerProfiles(["c"], ["mvsc"], "linux", "x64")).toThrow(/unavailable/);
  expect(() => planConsumerProfiles(["typescript"], ["clang"])).toThrow(/C\/C\+\+/);
});
test("compiler fixture setup handles records-only and adopted roots without rewriting application files", () => {
  const root = fixture(),
    distribution = resolve(import.meta.dirname, "..");
  const registry = join(root, "workbench/projects.toml");
  writeFileSync(registry, '[[project]]\nid="app"\npath="."\n');
  configureConsumerCompiler(root, distribution, "clang");
  expect(parse(readFileSync(registry, "utf8")).language_root).toBeUndefined();
  writeFileSync(registry, '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="c"\npath="."\n');
  writeFileSync(join(root, "application.c"), "existing application");
  writeFileSync(
    join(root, "workbench/automation.toml"),
    '[[check]]\nname="Existing"\nrole="test"\ncommand=["node","existing.cjs"]\n',
  );
  enableAdoptedApplicationChecks(root, distribution, "c");
  const values = parse(readFileSync(registry, "utf8")) as { language_root: { compiler: string; standard: string }[] };
  expect(values.language_root[0]).toMatchObject({ compiler: "clang", standard: "17" });
  const automation = parse(readFileSync(join(root, "workbench/automation.toml"), "utf8"));
  expect(automation.check_suite).toEqual([{ language: "c", path: "." }]);
  expect(automation.check).toEqual([{ name: "Existing", role: "test", command: ["node", "existing.cjs"] }]);
  expect(readFileSync(join(root, "application.c"), "utf8")).toBe("existing application");
});
test("report snapshots expose running work and keep primary and cleanup failures independently", () => {
  const root = fixture(),
    file = join(root, "results.json"),
    recorder = new ConsumerReportRecorder(file);
  const profile = recorder.profile("pins", ["c"]);
  profile.status = "running";
  profile.cases.push({ name: "adoption", status: "running", durationMs: 0, started: new Date().toISOString() });
  recorder.save();
  expect(readConsumerIntegrationReport(JSON.parse(readFileSync(file, "utf8"))).profiles[0]?.cases[0]?.status).toBe(
    "running",
  );
  recorder.result.error = "primary failure";
  recorder.result.cleanupErrors.push("cleanup failure");
  recorder.save();
  expect(readConsumerIntegrationReport(JSON.parse(readFileSync(file, "utf8")))).toMatchObject({
    error: "primary failure",
    cleanupErrors: ["cleanup failure"],
  });
  expect(() => readConsumerIntegrationReport({ version: 999 })).toThrow(/Invalid/);
});
test("missing artifacts are unavailable, independently from actual runtime managers", () => {
  const root = resolve(import.meta.dirname, "..");
  expect(resolveNativeTool(root, root, { name: "node", version: "0.0.0", source: "fixture" }).provider).toBe(
    "unavailable",
  );
  expect(resolveNativeTool(root, root, { name: "rust", version: "1.0.0", source: "fixture" }).provider).toBe("rustup");
  expect(resolveNativeTool(root, root, { name: "mvsc", version: "14.44.35207", source: "fixture" }).provider).toBe(
    "visual-studio",
  );
});

test("profile failures preserve remaining evidence, while cancellation stops the batch", async () => {
  const profiles = planConsumerProfiles(["c"], ["clang", "gcc"], "linux", "x64");
  const visited: string[] = [],
    failures: unknown[] = [];
  const controller = new AbortController();
  await executeConsumerProfiles(
    profiles,
    controller.signal,
    async (profile) => {
      visited.push(profile.id);
      await Promise.resolve();
      if (profile.id === "clang") throw new Error("application failed");
    },
    (error) => {
      failures.push(error);
    },
  );
  expect(visited).toEqual(["clang", "gcc"]);
  expect(failures).toHaveLength(1);
  visited.length = 0;
  await expect(
    executeConsumerProfiles(
      profiles,
      controller.signal,
      async (profile) => {
        visited.push(profile.id);
        await Promise.resolve();
        controller.abort();
        controller.signal.throwIfAborted();
      },
      (error) => {
        failures.push(error);
      },
    ),
  ).rejects.toThrow();
  expect(visited).toEqual(["clang"]);
});

test("installation failures block only dependent cases and remain separate from compiler evidence", async () => {
  const root = fixture(),
    scope = createOwnedScratch(root, "consumer-cases"),
    recorder = new ConsumerReportRecorder(join(root, "results.json")),
    cancellation = new CheckCancellation("Fixture integration");
  const visited: string[] = [];
  try {
    await runConsumerSuite(
      {
        report: recorder.result.installations,
        recorder,
        output: join(root, "installations"),
        cancellation,
        owner: scope.owner,
        label: "installations",
      },
      async (_commands, scenarios) => {
        await scenarios.run("user-install", () => Promise.reject(new Error("acquisition failed")));
        await scenarios.run(
          "offline-dispatch",
          async () => {
            visited.push("must-not-run");
            await Promise.resolve();
          },
          ["user-install"],
        );
        const value = await scenarios.run("independent-prefix", () => Promise.resolve({ executable: "selected" }));
        expect(value).toEqual({ executable: "selected" });
      },
    );
    const profile = recorder.profile("clang", ["c"], "clang");
    await runConsumerSuite(
      { report: profile, recorder, output: join(root, "clang"), cancellation, owner: scope.owner, label: "clang" },
      async (_commands, scenarios) => {
        await scenarios.run("application", async () => {
          visited.push("application");
          await Promise.resolve();
        });
      },
    );
    const result = readConsumerIntegrationReport(JSON.parse(readFileSync(join(root, "results.json"), "utf8")));
    expect(result.version).toBe(3);
    expect(result.installations.status).toBe("failed");
    expect(result.installations.cases.map((entry) => [entry.name, entry.status, entry.blockedBy])).toEqual([
      ["user-install", "failed", undefined],
      ["offline-dispatch", "blocked", ["user-install"]],
      ["independent-prefix", "passed", undefined],
    ]);
    expect(result.profiles[0]?.status).toBe("passed");
    expect(result.profiles[0]?.cases.map((entry) => entry.name)).toEqual(["application"]);
    expect(visited).toEqual(["application"]);
    const blocked = result.installations.cases[1];
    expect(blocked).toBeDefined();
    if (blocked) {
      blocked.blockedBy = [];
      expect(() => readConsumerIntegrationReport(result)).toThrow(/Invalid blocked/);
      blocked.blockedBy = ["unknown-prerequisite"];
      expect(() => readConsumerIntegrationReport(result)).toThrow(/Invalid blocked/);
      blocked.status = "passed";
      expect(() => readConsumerIntegrationReport(result)).toThrow(/Only blocked/);
    }
  } finally {
    cancellation.close();
    scope.release();
  }
});
