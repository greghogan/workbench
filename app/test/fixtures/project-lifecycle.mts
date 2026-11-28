import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { required } from "../../src/core/runtime/invariants.ts";
import { distribution } from "./adoption.mjs";

import {
  citationStatus,
  importCitation,
  syncCitations,
  type CitationStatus,
} from "../../src/core/citations/citations.ts";
import { formatFiles } from "../../src/core/records/formatting.ts";
import { addRecord, createExperiment } from "../../src/core/records/records.ts";
import { addRelease } from "../../src/core/records/releases.ts";
import { synchronize } from "../../src/core/records/sync.ts";

const executable = join(distribution, "bundle/main.cjs");
export const projectFixtureCharter = resolve(import.meta.dirname, "../../resources/verification/CHARTER.md");

interface AcquisitionFixture {
  sources: { status: string; sha256: string }[];
}
function invoke(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution },
    encoding: "utf8",
  });
}
export function runProjectCli(root: string, ...args: string[]) {
  const result = invoke(root, ...args);
  assert.equal(result.status, 0, `workbench ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
export function failProjectCli(root: string, ...args: string[]) {
  const result = invoke(root, ...args);
  assert.notEqual(result.status, 0, `workbench ${args.join(" ")} unexpectedly succeeded`);
  return result.stderr;
}

export function writeFixtureCitation(directory: string, project: string, status: "pending" | "unavailable") {
  writeFileSync(
    join(directory, "workbench/citations/CIT-00.json"),
    JSON.stringify([
      {
        id: `${project}-CIT-0`,
        type: "article",
        title: "Fixture record",
        author: [{ family: "Example", given: "Alice" }],
        issued: { "date-parts": [[2026]] },
        URL: "https://example.test/paper",
      },
    ]),
  );
  const acquisition = join(directory, "workbench/citations/CIT-00/acquisition.yaml");
  writeFileSync(
    acquisition,
    "# Attribution comment\nsources:\n  - kind: published\n" +
      `    landing-url: https://example.test/paper\n    status: ${status}\n`,
  );
  return acquisition;
}

export async function exerciseProjectRecords(root: string, project: string, directory = root) {
  for (const kind of ["ADR", "TSK", "ENV", "CIT"]) {
    await addRecord(root, kind, "Fixture record", project);
    const folder = { ADR: "decisions", TSK: "tasks", ENV: "environments", CIT: "citations" }[kind];
    const extension = kind === "CIT" ? "json" : "md";
    const path = join(directory, `workbench/${String(folder)}/${kind}-00.${extension}`);
    assert.ok(existsSync(path), path);
    if (kind === "ENV") {
      writeFileSync(
        path,
        "---\n{}\n---\n\n# ENV-0: Fixture record\n\n## Hardware configuration\n\nOne x86_64 test host.\n\n" +
          "## Limits\n\nNo topology guarantees.\n",
      );
    }
    if (kind === "CIT") {
      const acquisition = writeFixtureCitation(directory, project, "pending");
      const absent = citationStatus(root, project);
      assert.equal(required(absent[0], "Expected fixture value").id, `${project}:CIT-0`);
      assert.equal(required(absent[0], "Expected fixture value").present, false);
      assert.equal(required(absent[0], "Expected fixture value").state, "pending");
      const missing = () =>
        JSON.parse(
          runProjectCli(root, "citation", "--project", project, "--source", "published", "--json", "--missing"),
        ) as CitationStatus[];
      assert.deepEqual(
        missing().map((entry) => entry.id),
        [`${project}:CIT-0`],
      );
      await assert.rejects(() => syncCitations(root), /have no download-url/);
      assert.equal(
        required(
          (parseYaml(readFileSync(acquisition, "utf8")) as AcquisitionFixture).sources[0],
          "Expected fixture value",
        ).status,
        "pending",
      );
      const pending = readFileSync(acquisition, "utf8");
      for (const state of [
        "status: acquired",
        "status: unknown",
        `status: unavailable\n    sha256: '${"0".repeat(64)}'`,
      ]) {
        writeFileSync(acquisition, pending.replace("status: pending", state));
        await assert.rejects(() => syncCitations(root, project), /source status|acquired source|all-zero digest/);
      }
      writeFileSync(acquisition, pending.replace("status: pending", "status: unavailable"));
      await syncCitations(root, project);
      assert.equal(existsSync(join(directory, "library/citations/CIT-00-published.pdf")), false);
      const download = join(directory, "downloaded.pdf");
      writeFileSync(download, "%PDF-1.7\nfixture\n");
      await importCitation(root, `${project}:CIT-0`, download);
      const acquired = (parseYaml(readFileSync(acquisition, "utf8")) as AcquisitionFixture).sources[0];
      assert.equal(required(acquired, "Expected fixture value").status, "acquired");
      assert.equal(
        required(acquired, "Expected fixture value").sha256,
        createHash("sha256").update(readFileSync(download)).digest("hex"),
      );
      assert.ok(existsSync(join(directory, "library/citations/CIT-00-published.pdf")));
      const present = citationStatus(root, project);
      assert.equal(required(present[0], "Expected fixture value").source, "published");
      assert.equal(required(present[0], "Expected fixture value").present, true);
      assert.equal(required(present[0], "Expected fixture value").state, "acquired");
      assert.deepEqual(missing(), []);
      assert.match(readFileSync(acquisition, "utf8"), /# Attribution comment/);
      writeFileSync(join(directory, "library/citations/CIT-00-published.pdf"), "%PDF-1.7\nmodified\n");
      await assert.rejects(() => syncCitations(root, project), /SHA-256/);
      writeFileSync(join(directory, "library/citations/CIT-00-published.pdf"), "%PDF-1.7\nfixture\n");
      await syncCitations(root, project);
    }
    assert.match(readFileSync(path, "utf8"), /Fixture record/);
  }
  const protocol = join(directory, "protocol.md");
  writeFileSync(
    protocol,
    "---\n# Protocol provenance comment\nenvironment: null\n---\n\n## Hypothesis\nFaster.\n\n## Candidate and baseline\nNew and old.\n\n" +
      "## Independent variable\nAlgorithm.\n\n## Controls and correctness\nEqual answers.\n\n" +
      "## Workload\nSame input.\n\n## Evaluation rule\nLower median.\n",
  );
  await createExperiment(root, "Fixture trial", protocol, project);
  assert.match(
    readFileSync(join(directory, "workbench/experiments/EXP-00.md"), "utf8"),
    /# Protocol provenance comment/,
  );
  const artifact = join(directory, "portable-workbench");
  writeFileSync(artifact, "portable fixture");
  const specification = join(directory, "release.yaml");
  writeFileSync(
    specification,
    `version: 0.1.0\nrevision: ${"a".repeat(40)}\ntag: v0.1.0\nreleased: 2026-09-20\n` +
      `notes:\n  summary: Fixture release.\n  changes: []\nartifacts:\n  - target: portable-node\n` +
      `    path: ${artifact}\n    url: https://example.test/portable-workbench\n`,
  );
  await addRelease(root, specification, project);
  assert.ok(existsSync(join(directory, "workbench/releases/REL-00.yaml")));
  assert.match(readFileSync(join(directory, "workbench/releases/REL-00.yaml"), "utf8"), /version: 0.1.0/);
  await formatFiles(root, undefined, { all: true, write: true });
  synchronize(root, false);
  assert.match(readFileSync(join(directory, "workbench/decision-map.md"), "utf8"), new RegExp(`${project}:ADR-0`));
  for (const type of ["decision", "task", "experiment", "environment", "citation", "release"]) {
    assert.ok(existsSync(join(directory, `workbench/${type}-map.md`)));
  }
  assert.match(readFileSync(join(directory, "workbench/release-index.tsv"), "utf8"), /0\.1\.0\tportable-node/);
}
