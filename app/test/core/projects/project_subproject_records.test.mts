import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  exerciseProjectRecords,
  projectFixtureCharter,
  runProjectCli as run,
  writeFixtureCitation,
} from "../../fixtures/project-lifecycle.mjs";

test("subproject records preserve root records with the same numbers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-subproject-records-"));
  const root = join(directory, "demo");
  try {
    mkdirSync(root);
    run(root, "setup-project", root);
    copyFileSync(projectFixtureCharter, join(root, "workbench/CHARTER.md"));
    run(root, "record", "add", "decision", "Root policy");
    run(root, "record", "add", "citation", "Root bibliography");
    const rootAcquisition = writeFixtureCitation(root, "demo", "unavailable");
    const rootDecision = join(root, "workbench/decisions/ADR-00.md");
    const rootCitation = join(root, "workbench/citations/CIT-00.json");
    const decision = readFileSync(rootDecision, "utf8");
    const citation = JSON.parse(readFileSync(rootCitation, "utf8")) as unknown;
    const acquisition = parseYaml(readFileSync(rootAcquisition, "utf8")) as unknown;

    const component = join(root, "component");
    mkdirSync(join(component, "workbench"), { recursive: true });
    copyFileSync(projectFixtureCharter, join(component, "workbench/CHARTER.md"));
    run(root, "subproject", "add", "component", "component");
    assert.equal(existsSync(join(component, "AGENTS.md")), false);
    await exerciseProjectRecords(root, "component", component);

    assert.equal(readFileSync(rootDecision, "utf8"), decision);
    assert.deepEqual(JSON.parse(readFileSync(rootCitation, "utf8")), citation);
    assert.deepEqual(parseYaml(readFileSync(rootAcquisition, "utf8")), acquisition);
    assert.equal(existsSync(join(root, "library/citations/CIT-00-published.pdf")), false);
    run(root, "validate");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
