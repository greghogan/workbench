import { required } from "../src/invariants.ts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BrowserEvidenceRun,
  browserEvidenceMarker,
  inspectBrowserEvidence,
  applyBrowserEvidencePlan,
} from "../src/browser-evidence.ts";
import { inspectLogRun } from "../src/log-recovery.ts";
import { setUserOption } from "../src/user-config.ts";
import { configureDiagnostics } from "../scripts/diagnostics.mjs";
import { runOwnedChild } from "../scripts/owned-child.mjs";
import { keepCacheAsset } from "../src/project-registry.ts";
let root: string;
beforeEach(() => {
  configureDiagnostics({ sink: () => undefined });
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "workbench-browser-evidence-")));
  vi.stubEnv("WORKBENCH_LOCAL_CONFIG_ROOT", root);
  vi.stubEnv("WORKBENCH_PROJECT_ROOT", root);
  for (const kind of ["CONFIG", "CACHE", "STATE"]) vi.stubEnv(`WORKBENCH_${kind}_HOME`, join(root, kind));
  setUserOption("cache.auto_prune", "false");
});
afterEach(() => {
  configureDiagnostics();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
test("retention preserves binary evidence, protects live and kept runs, and revalidates a deletion plan", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01"));
  setUserOption("logs.max_bytes", "1");
  const first = new BrowserEvidenceRun(root);
  mkdirSync(join(first.directory, "session-0"));
  const png = Buffer.from([137, 80, 78, 71, 0, 13, 10, 255]);
  writeFileSync(join(first.directory, "session-0/failure.png"), png);
  await first.finish([new Error("browser failed")]);
  await expect(inspectLogRun(first.directory)).rejects.toThrow();
  expect(readFileSync(join(first.directory, "session-0/failure.png"))).toEqual(png);
  keepCacheAsset(first.directory, true);
  vi.setSystemTime(new Date("2026-01-02"));
  const active = new BrowserEvidenceRun(root),
    second = new BrowserEvidenceRun(root);
  await second.finish();
  expect(inspectBrowserEvidence(root).entries.every((entry) => !entry.selected)).toBe(true);
  keepCacheAsset(first.directory, false);
  const plan = inspectBrowserEvidence(root);
  expect(plan.entries.filter((entry) => entry.selected).map((entry) => entry.directory)).toEqual([first.directory]);
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(applyBrowserEvidencePlan(plan, { signal: cancelled.signal })).rejects.toThrow();
  keepCacheAsset(first.directory, true);
  await expect(applyBrowserEvidencePlan(plan)).rejects.toThrow(/changed/);
  expect(existsSync(first.directory)).toBe(true);
  keepCacheAsset(first.directory, false);
  const result = await applyBrowserEvidencePlan(inspectBrowserEvidence(root));
  expect(result.entries.find((entry) => entry.directory === first.directory)?.removed).toBe(true);
  expect(existsSync(first.directory)).toBe(false);
  expect(existsSync(second.directory)).toBe(true);
  expect(existsSync(active.directory)).toBe(true);
  await active.finish();
});

test("all-project pruning uses individual policy overrides and protects unavailable projects", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setUserOption("logs.max_bytes", "0");
  setUserOption("logs.max_age_days", "0");
  const projects = ["small", "large", "unavailable", "malformed"].map((name) => join(root, name));
  const runs: BrowserEvidenceRun[] = [];
  for (const [index, project] of projects.entries()) {
    mkdirSync(join(project, "workbench"), { recursive: true });
    writeFileSync(
      join(project, "workbench/local.toml"),
      `[logs]\nmax_bytes=${index === 0 ? "1" : "0"}\nmax_age_days=0\n`,
    );
    for (const date of ["2026-01-01", "2026-01-02"]) {
      vi.setSystemTime(new Date(date));
      const run = new BrowserEvidenceRun(project);
      await run.finish();
      runs.push(run);
    }
  }
  rmSync(required(projects[2], "Expected unavailable project"), { recursive: true });
  writeFileSync(
    join(required(projects[3], "Expected malformed project"), "workbench/local.toml"),
    '[logs]\nmax_bytes="invalid"\n',
  );
  const plan = inspectBrowserEvidence();
  expect(plan.entries.filter((entry) => entry.selected).map((entry) => entry.directory)).toEqual([runs[0]?.directory]);
  expect(
    plan.entries
      .filter((entry) => entry.project === projects[2])
      .every((entry) => entry.blockedBy?.includes("unavailable")),
  ).toBe(true);
  expect(plan.issues.some((issue) => issue.includes("retention policy unavailable"))).toBe(true);
  await applyBrowserEvidencePlan(plan);
  expect(runs.map((run) => existsSync(run.directory))).toEqual([false, true, true, true, true, true, true, true]);
});

test("proven abandoned producers recover as interrupted; uncertainty preserves their artifacts", async () => {
  const retired = await runOwnedChild(process.execPath, ["-e", ""], {
    cwd: root,
    env: process.env,
    signal: AbortSignal.timeout(120000),
  });
  expect(retired.status).toBe(0);
  const recovered = new BrowserEvidenceRun(root),
    uncertain = new BrowserEvidenceRun(root);
  for (const run of [recovered, uncertain]) {
    const path = join(run.directory, "owner/owner.json");
    const owner = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(owner.pid).toBe(process.pid);
    writeFileSync(
      path,
      JSON.stringify({ ...owner, pid: retired.pid, ...(run === uncertain ? { uncertain: true } : {}) }),
    );
  }
  const plan = inspectBrowserEvidence(root);
  expect(plan.entries.find((entry) => entry.directory === recovered.directory)?.interrupted).toBe(true);
  expect(plan.entries.find((entry) => entry.directory === uncertain.directory)?.blockedBy).toBeTruthy();
  await applyBrowserEvidencePlan(plan);
  expect(JSON.parse(readFileSync(join(recovered.directory, browserEvidenceMarker), "utf8"))).toMatchObject({
    state: "completed",
    outcome: "interrupted",
  });
  expect(existsSync(join(recovered.directory, "owner"))).toBe(false);
  expect(existsSync(join(uncertain.directory, "owner"))).toBe(true);
});

test("a browser startup failure drains its child, completes evidence, and removes its fixture workspace", async () => {
  const chunks: Buffer[] = [];
  let size = 0;
  const result = await runOwnedChild(
    process.execPath,
    [
      resolve(import.meta.dirname, "../scripts/check-web-browser.mjs"),
      "--browser",
      process.execPath,
      "--scenario",
      "Policy incompatibility proposals in the unified review queue",
    ],
    {
      cwd: resolve(import.meta.dirname, ".."),
      env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
      signal: AbortSignal.timeout(120000),
      stopDescendantsOnExit: true,
      output: (stdout, stderr) => {
        for (const stream of [stdout, stderr])
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 1024 * 1024) chunks.push(chunk);
          });
      },
    },
  );
  const output = Buffer.concat(chunks).toString();
  expect(result.status, output).not.toBe(0);
  expect(result.descendantsActive).not.toBe(true);
  const directory = /Browser verification artifacts: (.+)/.exec(output)?.[1];
  if (!directory) throw new Error("Browser failure did not retain evidence: " + output);
  expect(readFileSync(join(directory, "failure.txt"), "utf8")).toMatch(/launch|browser/i);
  expect(JSON.parse(readFileSync(join(directory, browserEvidenceMarker), "utf8"))).toMatchObject({
    state: "completed",
    outcome: "failed",
  });
  expect(JSON.parse(readFileSync(join(directory, "result.json"), "utf8"))).toMatchObject({ passed: false });
  expect(readdirSync(root).filter((name) => name.startsWith("workbench-browser-"))).toEqual([]);
  expect(readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory())).toEqual([]);
});

test("browser pruning CLI exposes the inspected plan and per-entry applied outcomes", async () => {
  const { Command } = await import("commander");
  const { registerCacheCommands } = await import("../src/cli/cache.ts");
  setUserOption("logs.max_bytes", "1");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01"));
  const first = new BrowserEvidenceRun(root);
  await first.finish();
  vi.setSystemTime(new Date("2026-01-02"));
  const second = new BrowserEvidenceRun(root);
  await second.finish();
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const run = async (apply: boolean) => {
      const program = new Command().enablePositionalOptions();
      registerCacheCommands(program, root);
      await program.parseAsync(["cache", "prune", "--browser", "--all", "--json", ...(apply ? ["--apply"] : [])], {
        from: "user",
      });
      return JSON.parse(String(output.mock.calls.at(-1)?.[0])) as {
        schema_version: number;
        kind: string;
        applied: boolean;
        entries: { directory: string; selected: boolean; removed?: boolean }[];
      };
    };
    expect(await run(false)).toMatchObject({ schema_version: 2, kind: "browser-evidence", applied: false });
    expect(existsSync(first.directory)).toBe(true);
    const applied = await run(true);
    expect(applied.entries.find((entry) => entry.directory === first.directory)).toMatchObject({
      selected: true,
      removed: true,
    });
    expect(existsSync(first.directory)).toBe(false);
    expect(existsSync(second.directory)).toBe(true);
  } finally {
    output.mockRestore();
  }
});
