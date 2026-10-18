import { required } from "../../src/invariants.ts";
import type { CITarget } from "../../src/ci-targets.ts";
import type { RunReport } from "../../scripts/ci-results.mjs";
import * as buildkit from "../../src/buildkit.ts";
import { executeCI } from "../../src/ci-lifecycle.ts";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, vi } from "vitest";
import * as targets from "../../src/ci-targets.ts";
import * as core from "../../src/core.ts";
import { runLocalCI } from "../../src/local-ci.ts";
import { targetPhases } from "../../scripts/ci-contract.mjs";
const repository = resolve(import.meta.dirname, "../..");

export function localCIFixture() {
  const temporary: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  function fixture() {
    vi.spyOn(buildkit, "buildProjectImage").mockImplementation(async (_root, args) => {
      await executeCI("docker", ["build", ...args]);
    });
    const root = mkdtempSync(join(tmpdir(), "workbench-local-execution-"));
    temporary.push(root);
    for (const args of [
      ["init", "--quiet"],
      ["config", "user.email", "fixture@example.invalid"],
      ["config", "user.name", "Fixture"],
    ])
      expect(spawnSync("git", args, { cwd: root }).status).toBe(0);
    writeFileSync(join(root, "draft"), "pending input");
    expect(spawnSync("git", ["add", "."], { cwd: root }).status).toBe(0);
    expect(spawnSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root }).status).toBe(0);
    for (const file of [
      ".node-version",
      "scripts/ci-linux",
      "scripts/ci-run.mjs",
      "scripts/values.mjs",
      "scripts/ci-contract.mjs",
      "scripts/ci-worker-request.mjs",
      "scripts/cpu-budget.mjs",
      "scripts/ci-results.mjs",
      "scripts/ci-reports.mjs",
      "scripts/native-assets.json",
      "scripts/keys/node.asc",
    ]) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      cpSync(join(repository, file), join(root, file), { recursive: true });
    }
    const clients = join(root, "clients");
    mkdirSync(clients);
    cpSync(join(repository, "tests/fixtures/ci-docker.mjs"), join(clients, "docker"));
    mkdirSync(join(root, "bin"));
    cpSync(join(repository, "tests/fixtures/ci-workbench.mjs"), join(root, "bin/workbench.mjs"));
    const eventsFile = join(root, "events");
    writeFileSync(eventsFile, "");
    const reportsFile = join(root, "reports-path");
    vi.stubEnv("FIXTURE_EVENTS", eventsFile);
    vi.stubEnv("FIXTURE_REPORTS", reportsFile);
    vi.stubEnv("PATH", clients + delimiter + (process.env.PATH ?? ""));
    vi.stubEnv("CARGO_HOME", join(root, "private-cargo"));
    vi.stubEnv("RUSTUP_HOME", join(root, "private-rustup"));
    vi.spyOn(core, "distributionRoot").mockReturnValue(root);
    vi.spyOn(core, "readLanguageRoots").mockReturnValue([{ language: "typescript", path: "." }]);
    const slot = join(
      tmpdir(),
      `workbench-ci-${String(process.getuid?.() ?? 0)}`,
      createHash("sha256").update(root).digest("hex").slice(0, 24),
    );
    temporary.push(slot);
    const target = (id: string, kind: "native" | "environment", environment: CITarget["environment"] = "native") => {
      const selection = {
        id,
        kind,
        environment,
        path: ".",
        os: "linux",
        architecture: "x64",
        release: false as const,
        checks: [],
      };
      return { ...selection, phases: targetPhases(selection) };
    };
    vi.spyOn(targets, "ciTargets").mockReturnValue([
      target("native", "native"),
      target("guix", "environment", "guix"),
      target("devcontainer", "environment", "devcontainer"),
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reports = () => {
      const line = log.mock.calls
        .flat()
        .map(String)
        .find((line) => line.startsWith("Local CI reports and release artifacts: "));
      const path = required(line, "Local CI reports announcement").slice(
        "Local CI reports and release artifacts: ".length,
      );
      temporary.push(resolve(path, ".."));
      return path;
    };
    return {
      root,
      slot,
      reports,
      events: () =>
        readFileSync(eventsFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((text) => JSON.parse(text) as unknown),
    };
  }
  async function verifyFailure(behavior: string | undefined) {
    const f = fixture();
    vi.stubEnv("FIXTURE_BEHAVIOR", behavior);
    await expect(runLocalCI(f.root)).rejects.toThrow(/Local CI/);
    const run = JSON.parse(readFileSync(join(f.reports(), "results.json"), "utf8")) as RunReport;
    expect(run.targets.map(({ id }) => id)).toEqual(["native", "guix", "devcontainer"]);
    expect(
      required(
        run.targets.find(({ id }) => id === "devcontainer"),
        "Dev Container result",
      ).success,
    ).toBe(true);
    if (behavior === "managed-failure")
      expect(
        required(
          run.targets.find(({ id }) => id === "guix"),
          "Guix result",
        ).success,
      ).toBe(false);
    else if (behavior === "cleanup-failure") {
      expect(run.targets.every(({ success }) => success)).toBe(true);
      expect(run.errors).toHaveLength(3);
      expect(run.errors.every((error: { phase: string }) => error.phase === "cleanup:containers")).toBe(true);
    } else
      expect(
        required(
          run.targets.find(({ id }) => id === "native"),
          "Native result",
        ).success,
      ).toBe(false);
    if (behavior === "target-failure") expect(run.errors).toEqual([]);
    if (behavior === "incomplete-results")
      expect(run.errors).toEqual([expect.objectContaining({ phase: "target execution or results" })]);
    expect(existsSync(join(f.slot, "workspace"))).toBe(behavior === "cleanup-failure");
    expect(existsSync(join(f.slot, "active"))).toBe(behavior === "cleanup-failure");
  }
  return { fixture, verifyFailure };
}
