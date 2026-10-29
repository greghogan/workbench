import { required } from "../src/invariants.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import * as targets from "../src/ci-targets.ts";
import { runLocalCI } from "../src/local-ci.ts";
import { targetPhases } from "../scripts/ci-contract.mjs";
import { CIWorkspace } from "../src/ci-workspace.ts";
import { localCIFixture } from "./fixtures/local-ci-execution.mjs";

const { fixture } = localCIFixture();

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "real adapters exchange manifests and fresh reports while preserving the checkout and cleaning owned resources",
  async () => {
    const f = await fixture();
    const selected = targets.ciTargets(f.root);
    const gcc: import("../src/ci-targets.ts").CITarget = {
      ...required(selected[0], "First target"),
      id: "gcc",
      kind: "compatibility",
      runtime: "gcc",
      version: "16.2.0",
      roles: ["test", "sanitizers", "lto"],
      environment: "native",
      release: false,
    };
    vi.mocked(targets.ciTargets).mockReturnValue([...selected, { ...gcc, phases: targetPhases(gcc) }]);
    const before = readFileSync(join(f.root, ".git/index"));
    try {
      await runLocalCI(f.root);
    } catch (error) {
      console.error(readFileSync(join(f.reports(), "results.json"), "utf8"));
      throw error;
    }
    expect(readFileSync(join(f.root, ".git/index"))).toEqual(before);
    expect(readFileSync(join(f.root, "draft"), "utf8")).toBe("pending input");
    expect(existsSync(join(f.slot, "workspace"))).toBe(false);
    expect(existsSync(join(f.slot, "active"))).toBe(false);
    const reports = f.reports();
    const run = JSON.parse(
      readFileSync(join(reports, "results.json"), "utf8"),
    ) as import("../scripts/ci-results.mjs").RunReport;
    expect(run.errors).toEqual([]);
    expect(run.targets.map(({ success }) => success)).toEqual([true, true, true, true]);
    for (const target of run.targets) {
      const observed = JSON.parse(readFileSync(join(target.report, "coverage/fixture.json"), "utf8")) as {
        target: string;
        checkout: string;
        localCIImage: string;
      };
      expect(observed.target).toBe(target.id);
      expect(observed.checkout).toBe(f.root);
      expect(observed.localCIImage).toContain("ubuntu:26.04@sha256:");
    }
    expect(f.events()).toContainEqual({ cleaned: "owned-container" });
    expect(
      f
        .events()
        .filter(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "target" in event &&
            event.target === "gcc" &&
            "command" in event &&
            event.command === "tools",
        ),
    ).toHaveLength(1);
    expect(
      f
        .events()
        .filter(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "target" in event &&
            event.target === "gcc" &&
            "command" in event &&
            event.command === "check",
        ),
    ).toHaveLength(3);
    expect(existsSync(resolve(reports, "../image"))).toBe(false);
  },
);

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "job admission creates at most the configured workspace count and releases completed jobs before admitting another",
  async () => {
    const f = await fixture();
    mkdirSync(join(f.root, "workbench"));
    writeFileSync(
      join(f.root, "workbench/config.toml"),
      "schema_version = 1\n[markdown]\nwrap_width = 120\n[compatibility]\nrequired = false\n",
    );
    writeFileSync(join(f.root, "workbench/local.toml"), "[execution]\ncpus_per_job=1\nmax_jobs=1\n");
    const original = required(Object.getOwnPropertyDescriptor(CIWorkspace.prototype, "fork"), "Workspace method")
      .value as CIWorkspace["fork"];
    const seen: string[] = [];
    vi.spyOn(CIWorkspace.prototype, "fork").mockImplementation(async function (this: CIWorkspace, id) {
      const directory = await original.call(this, id);
      const jobs = join(f.slot, "jobs");
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(jobs)).toHaveLength(1);
      seen.push(directory);
      return directory;
    });
    await runLocalCI(f.root);
    expect(seen).toHaveLength(3);
    expect(seen.every((path) => !existsSync(path))).toBe(true);
    const reports = f.reports();
    const run = JSON.parse(
      readFileSync(join(reports, "results.json"), "utf8"),
    ) as import("../scripts/ci-results.mjs").RunReport;
    expect(
      run.targets.every((target) => target.success && existsSync(join(target.report, "coverage/fixture.json"))),
    ).toBe(true);
    expect(existsSync(join(f.slot, "active"))).toBe(false);
  },
);

test.skipIf(process.platform !== "linux" || process.arch !== "x64").each([false, true])(
  "local CI preserves independent operation results when checks fail: %s",
  async (failChecks) => {
    const f = await fixture();
    const base = required(targets.ciTargets(f.root)[0], "Fixture native target");
    const foreignCandidate = join(f.root, "unrelated-hosted-candidate");
    vi.stubEnv("WORKBENCH_CI_CANDIDATE", foreignCandidate);
    if (base.kind !== "native") throw new Error("Expected native fixture");
    const target = { ...base, release: true, integration: true };
    if (failChecks) vi.stubEnv("FIXTURE_BEHAVIOR", "checks-failure");
    vi.mocked(targets.ciTargets).mockReturnValue([{ ...target, phases: targetPhases(target) }]);
    if (failChecks) await expect(runLocalCI(f.root)).rejects.toThrow(/Local CI failed/);
    else await runLocalCI(f.root);
    const reports = f.reports();
    const run = JSON.parse(
      readFileSync(join(reports, "results.json"), "utf8"),
    ) as import("../scripts/ci-results.mjs").RunReport;
    expect(run.errors).toEqual([]);
    expect(run.targets).toHaveLength(1);
    expect(run.targets[0]?.success).toBe(!failChecks);
    const report = required(run.targets[0], "Target report").report;
    for (const operation of ["checks", "integration", "release"]) {
      const result = JSON.parse(
        readFileSync(join(report, "operations", operation, "job-results.json"), "utf8"),
      ) as import("../scripts/ci-results.mjs").RunReport;
      expect(result.targets[0]?.success).toBe(operation !== "checks" || !failChecks);
    }
    const plan = JSON.parse(readFileSync(join(reports, "plan.json"), "utf8")) as {
      operations: { operation: string }[];
    };
    expect(plan.operations.map((job) => job.operation).sort()).toEqual(["checks", "integration", "release"]);
    expect(process.env.WORKBENCH_CI_CANDIDATE).toBe(foreignCandidate);
    expect(existsSync(join(f.slot, "workspace"))).toBe(false);
    expect(
      f
        .events()
        .filter(
          (event) => typeof event === "object" && event !== null && "command" in event && event.command === "ci-checks",
        ),
    ).toHaveLength(1);
  },
);
