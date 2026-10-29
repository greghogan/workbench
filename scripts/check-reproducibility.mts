import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createSourceSnapshot } from "./source-snapshot.mts";
import { linkDependencies } from "./link-dependencies.mjs";
import { withEngineeringRun, withEngineeringReport } from "./engineering-run.mjs";
import { compareArtifacts, type ArtifactComparison } from "./compare-artifacts.mjs";
import { writeAtomic } from "./file-publication.mjs";
import { readBoundedFile } from "../src/file-reads.ts";
import { ownedPath } from "../src/paths.ts";

const root = process.cwd(),
  parent = process.env.WORKBENCH_BUILD_DIR;
if (!parent) throw new Error("Run independent rebuilds through a configured Workbench check or shell");
mkdirSync(parent, { recursive: true });
const report: {
  schema_version: number;
  sourceTree?: string;
  node: string;
  platform: string;
  status: "running" | "passed" | "failed";
  error?: string;
  comparisons: ({ path: string } & ArtifactComparison)[];
} = {
  schema_version: 1,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  status: "running",
  comparisons: [],
};
const reportPath = join(parent, "reproducibility.json"),
  save = () => {
    writeAtomic(reportPath, JSON.stringify(report, null, 2) + "\n");
  };
await withEngineeringReport(report, save, async () => {
  await withEngineeringRun(tmpdir(), "reproducibility", async (job) => {
    const snapshot = await createSourceSnapshot({
      source: root,
      destination: join(job.directory, "first"),
      environment: process.env,
      signal: job.signal,
      owner: job.scratch.owner,
    });
    report.sourceTree = snapshot.tree;
    save();
    rmSync(join(snapshot.directory, ".git"), { recursive: true });
    const second = join(job.directory, "different location", "second");
    cpSync(snapshot.directory, second, { recursive: true });
    const artifacts: { root: string; outputs: string[]; archive: string }[] = [];
    for (const directory of [snapshot.directory, second]) {
      linkDependencies(join(root, "node_modules"), join(directory, "node_modules"));
      const options = {
        cwd: directory,
        env: { ...process.env, WORKBENCH_EPHEMERAL_CHECKOUT: "1", WORKBENCH_PROJECT_ROOT: directory },
      };
      await job.run(process.execPath, ["scripts/build-tooling.mts"], options);
      await job.run(process.execPath, ["scripts/rebuild-workbench.mjs"], options);
      const value: unknown = JSON.parse(
        readBoundedFile(join(directory, "rebuild.json"), 65536, "rebuild manifest").toString("utf8"),
      );
      if (
        !value ||
        typeof value !== "object" ||
        !("outputs" in value) ||
        !Array.isArray(value.outputs) ||
        value.outputs.length > 256 ||
        !value.outputs.every((path: unknown) => typeof path === "string") ||
        !("archive" in value) ||
        typeof value.archive !== "string"
      )
        throw new Error("Invalid rebuilt artifact manifest");
      artifacts.push({
        root: directory,
        outputs: value.outputs,
        archive: relative(directory, value.archive).replaceAll("\\", "/"),
      });
    }
    const [a, b] = artifacts;
    assert.ok(a && b);
    assert.deepEqual(a.outputs.sort(), b.outputs.sort(), "Rebuild output sets differ");
    const pairs = [
      ...a.outputs.map((path) => ({ path, a: ownedPath(a.root, path), b: ownedPath(b.root, path) })),
      { path: "release archive", a: ownedPath(a.root, a.archive), b: ownedPath(b.root, b.archive) },
    ];
    for (const pair of pairs) {
      const comparison = await compareArtifacts(pair.a, pair.b);
      report.comparisons.push({ path: pair.path, ...comparison });
      save();
    }
    assert.ok(
      report.comparisons.every((result) => result.equal),
      `Independent rebuilds differ; compact mismatch evidence: ${reportPath}`,
    );
  });
});
console.log(`Independent rebuild evidence: ${reportPath}`);
