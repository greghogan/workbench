import { afterEach, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { retainJavaTestReports } from "../scripts/java-test-reports.mjs";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const temporary: string[] = [];
afterEach(() => {
  vi.mocked(renameSync).mockImplementation(actual.renameSync);
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-java-reports-"));
  temporary.push(root);
  const reports = join(root, "build/surefire-reports");
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, "OldTest.xml"), '<testsuite tests="3"/>');
  const run = { role: "test", startedAt: "2026-01-01T00:00:00.000Z", status: 0, signal: null };
  retainJavaTestReports(reports, root, run);
  const destination = join(root, "coverage/surefire");
  const metadata = () =>
    JSON.parse(readFileSync(join(destination, ".workbench-run.json"), "utf8")) as {
      runId: string;
      outcome: string;
      status: number | null;
    };
  return { root, reports, run, destination, metadata };
}

test("each report set replaces its predecessor, including failing and missing runs", () => {
  const f = fixture();
  const first = f.metadata();
  expect(first.outcome).toBe("passed");
  rmSync(join(f.reports, "OldTest.xml"));
  writeFileSync(join(f.reports, "RenamedTest.xml"), '<testsuite tests="2" failures="1"/>');
  retainJavaTestReports(f.reports, f.root, { ...f.run, status: 1 });
  expect(readdirSync(f.destination).filter((name) => name.endsWith(".xml"))).toEqual(["RenamedTest.xml"]);
  const second = f.metadata();
  expect(second.outcome).toBe("failed");
  expect(second.status).toBe(1);
  expect(second.runId).not.toBe(first.runId);
  rmSync(f.reports, { recursive: true });
  retainJavaTestReports(f.reports, f.root, { ...f.run, status: null, error: "Maven could not start" });
  expect(readdirSync(f.destination)).toEqual([".workbench-run.json"]);
  expect(f.metadata().outcome).toBe("missing");
  expect(readdirSync(join(f.root, "coverage"))).toEqual(["surefire"]);
});

test("a failed report-directory replacement restores the complete previous run", () => {
  const f = fixture();
  const before = f.metadata();
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (String(from).endsWith("incoming")) throw new Error("injected publication failure");
    actual.renameSync(from, to);
  });
  expect(() => {
    retainJavaTestReports(f.reports, f.root, f.run);
  }).toThrow(/injected publication failure/);
  expect(f.metadata()).toEqual(before);
  expect(readFileSync(join(f.destination, "OldTest.xml"), "utf8")).toContain('tests="3"');
  expect(readdirSync(join(f.root, "coverage"))).toEqual(["surefire"]);
});

test("failed replacement and rollback retain the previous reports for explicit recovery", () => {
  const f = fixture();
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (String(to) === f.destination) throw new Error("injected replacement and recovery failure");
    actual.renameSync(from, to);
  });
  expect(() => {
    retainJavaTestReports(f.reports, f.root, f.run);
  }).toThrow(/previous output retained at/);
  const retained = readdirSync(join(f.root, "coverage")).find((name) => name.startsWith(".surefire-"));
  expect(retained).toBeDefined();
  expect(readFileSync(join(f.root, "coverage", retained ?? "", "previous/OldTest.xml"), "utf8")).toContain('tests="3"');
});

test("linked report output or input cannot replace retained evidence or modify another directory", () => {
  const f = fixture();
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(f.reports, "linked"), process.platform === "win32" ? "junction" : "dir");
  expect(() => {
    retainJavaTestReports(f.reports, f.root, f.run);
  }).toThrow(/symbolic links/);
  expect(existsSync(join(f.destination, "OldTest.xml"))).toBe(true);
  rmSync(join(f.reports, "linked"));
  rmSync(f.destination, { recursive: true });
  symlinkSync(outside, f.destination, process.platform === "win32" ? "junction" : "dir");
  expect(() => {
    retainJavaTestReports(f.reports, f.root, f.run);
  }).toThrow(/symbolic link/);
  expect(readdirSync(outside)).toEqual([]);
});
