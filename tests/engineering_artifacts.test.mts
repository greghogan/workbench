import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
const fault = vi.hoisted(() => ({ destination: "" }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (to === fault.destination && from.includes("artifact-")) throw new Error("injected publication failure");
      actual.renameSync(from, to);
    },
  };
});
import { withEngineeringRun, withEngineeringReport } from "../scripts/engineering-run.mjs";
import { fileSHA256, publishOptimization } from "../scripts/optimization-artifact.mjs";
import { compareArtifacts } from "../scripts/compare-artifacts.mjs";
import { decodeMeasurement } from "../scripts/profile-model.mjs";
const temporary: string[] = [];
afterEach(() => {
  fault.destination = "";
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "workbench-engineering-"));
  temporary.push(directory);
  return directory;
}
test("a failed training, relocation check, or publication preserves the previous executable and matching provenance", async () => {
  const parent = fixture(),
    output = join(parent, "pgo");
  await withEngineeringRun(parent, "optimization-test", async (job) => {
    const publish = (contents: string) =>
      publishOptimization(job, output, "app", (stage) => {
        writeFileSync(join(stage, "app"), contents);
        return { compiler: "fixture compiler" };
      });
    await publish("first verified artifact");
    const bytes = readFileSync(join(output, "app")),
      provenance = readFileSync(join(output, "provenance.json"));
    await expect(
      publishOptimization(job, output, "app", (stage) => {
        writeFileSync(join(stage, "app"), "unverified");
        throw new Error("relocation failed");
      }),
    ).rejects.toThrow("relocation failed");
    fault.destination = output;
    await expect(publish("replacement")).rejects.toThrow("publication failure");
    expect(readFileSync(join(output, "app"))).toEqual(bytes);
    expect(readFileSync(join(output, "provenance.json"))).toEqual(provenance);
    fault.destination = "";
    await publish("second verified artifact");
    const value = JSON.parse(readFileSync(join(output, "provenance.json"), "utf8")) as { artifact: { sha256: string } };
    expect(value.artifact.sha256).toBe(await fileSHA256(join(output, "app")));
    expect(readFileSync(join(output, "app"), "utf8")).toBe("second verified artifact");
  });
});
test("unrecognized retained output is preserved and engineering scratch and signal listeners are released on failure", async () => {
  const parent = fixture(),
    output = join(parent, "pgo");
  mkdirSync(output);
  writeFileSync(join(output, "user-data"), "keep");
  const listeners = process.listenerCount("SIGTERM");
  let scratch = "";
  await expect(
    withEngineeringRun(parent, "optimization-test", async (job) => {
      scratch = job.directory;
      await publishOptimization(job, output, "app", (stage) => {
        writeFileSync(join(stage, "app"), "new");
        return {};
      });
    }),
  ).rejects.toThrow(/unrecognized/);
  expect(readFileSync(join(output, "user-data"), "utf8")).toBe("keep");
  expect(existsSync(scratch)).toBe(false);
  expect(process.listenerCount("SIGTERM")).toBe(listeners);
});
test("bounded artifact comparison reports content, length and boundary mismatches with hashes", async () => {
  const root = fixture(),
    a = join(root, "a"),
    b = join(root, "b"),
    bytes = Buffer.alloc(65536 * 3 + 1, 42);
  writeFileSync(a, bytes);
  writeFileSync(b, bytes);
  expect((await compareArtifacts(a, b)).equal).toBe(true);
  bytes[65536] = 7;
  writeFileSync(b, bytes);
  expect(await compareArtifacts(a, b)).toMatchObject({
    equal: false,
    firstDifference: 65536,
    left: { bytes: bytes.length },
    right: { bytes: bytes.length },
  });
  writeFileSync(b, Buffer.alloc(0));
  expect((await compareArtifacts(a, b)).firstDifference).toBe(0);
  writeFileSync(a, Buffer.alloc(0));
  expect((await compareArtifacts(a, b)).equal).toBe(true);
});
test("profiling measurements reject missing, nonfinite and negative counters", () => {
  const value = { wallMs: 1, cpuUserMs: 0, cpuSystemMs: 2, blockInputOps: 0, blockOutputOps: 0, maximumRssKiB: 42 };
  expect(decodeMeasurement(value)).toEqual(value);
  for (const invalid of [
    null,
    {},
    { ...value, wallMs: Infinity },
    { ...value, maximumRssKiB: -1 },
    { ...value, cpuUserMs: "0" },
  ])
    expect(() => decodeMeasurement(invalid)).toThrow(/measurement/);
});

test("operation and report-publication failures remain visible together", async () => {
  const report = { status: "running" as "running" | "passed" | "failed" },
    primary = new Error("training failed"),
    publication = new Error("disk full");
  let writes = 0,
    failure: unknown;
  try {
    await withEngineeringReport(
      report,
      () => {
        if (++writes > 1) throw publication;
      },
      () => Promise.reject(primary),
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([primary, publication]);
  expect(report.status).toBe("failed");
});
