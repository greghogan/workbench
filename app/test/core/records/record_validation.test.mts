import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, vi } from "vitest";
import { recordDocument } from "../../../src/core/records/record-document.ts";
import { scan } from "../../../src/core/records/record-files.ts";
import { collectionWorkingFiles } from "../../../src/core/collections/collection-files.ts";
import { stageFile } from "../../../src/core/runtime/file-publication.mjs";
import { setupProject } from "../../../src/cli/project-setup.ts";
import { addRecord, createExperiment, validateRelationships } from "../../../src/core/records/records.ts";
import { formatFiles } from "../../../src/core/records/formatting.ts";
import { synchronize } from "../../../src/core/records/sync.ts";
import { validationReport } from "../../../src/core/records/validation.ts";

const distribution = resolve(import.meta.dirname, "../../../..");
const executable = join(distribution, "bundle/main.cjs");

test("record discovery and collection acquisition exclude unpublished atomic candidates", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-record-publication-"));
  const directory = join(root, "workbench/decisions");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "ADR-00.md");
  writeFileSync(path, "published");
  const replacement = stageFile(path, "replacement"),
    added = stageFile(join(directory, "ADR-01.md"), "new record");
  try {
    assert.deepEqual(scan(root, "ADR"), [{ number: "0", path }]);
    assert.deepEqual(
      [...collectionWorkingFiles(join(root, "workbench"))],
      [["workbench/decisions/ADR-00.md", Buffer.from("published")]],
    );
    added.publish();
    assert.deepEqual(
      scan(root, "ADR").map((record) => record.number),
      ["0", "1"],
    );
    writeFileSync(join(directory, "unrelated.tmp"), "unrecognized");
    assert.throws(() => scan(root, "ADR"), /unexpected file in record directory/);
  } finally {
    replacement.discard();
    added.discard();
    rmSync(root, { recursive: true, force: true });
  }
});

function run(root: string, expected: boolean, ...arguments_: string[]) {
  const result = spawnSync(process.execPath, [executable, ...arguments_], {
    cwd: root,
    env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution },
    encoding: "utf8",
  });
  assert.equal(result.status === 0, expected, `${arguments_.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

test("task hierarchy and duplicate dependencies are validated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-relationships-"));
  const root = join(directory, "demo");
  mkdirSync(root);
  try {
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    await setupProject(root, "demo");
    copyFileSync(
      resolve(import.meta.dirname, "../../../resources/verification/CHARTER.md"),
      join(root, "workbench/CHARTER.md"),
    );
    await addRecord(root, "TSK", "Parent");
    await addRecord(root, "TSK", "Child", undefined, "demo:TSK-0");
    synchronize(root);
    assert.deepEqual((await validationReport(root)).errors, []);
    const parent = join(root, "workbench/tasks/TSK-00.md");
    const child = join(root, "workbench/tasks/TSK-01.md");
    const parentMetadata = recordDocument("TSK", readFileSync(parent, "utf8"), parent).metadata;
    assert.equal(typeof parentMetadata.added_at, "string");
    assert.deepEqual(parentMetadata, { status: "Planned", added_at: parentMetadata.added_at });
    const childMetadata = recordDocument("TSK", readFileSync(child, "utf8"), child).metadata;
    assert.equal(typeof childMetadata.added_at, "string");
    assert.deepEqual(childMetadata, {
      added_at: childMetadata.added_at,
      status: "Planned",
      parent: "demo:TSK-0",
    });
    await addRecord(root, "TSK", "Dependent", undefined, undefined, ["demo:TSK-1"]);
    synchronize(root);
    const dependent = join(root, "workbench/tasks/TSK-02.md");
    const dependentMetadata = recordDocument("TSK", readFileSync(dependent, "utf8"), dependent).metadata;
    assert.equal(typeof dependentMetadata.added_at, "string");
    assert.deepEqual(dependentMetadata, {
      added_at: dependentMetadata.added_at,
      status: "Planned",
      depends_on: ["demo:TSK-1"],
    });
    assert.deepEqual((await validationReport(root)).errors, []);
    writeFileSync(parent, readFileSync(parent, "utf8").replace("status: Planned", "status: Accepted"));
    assert.match((await validationReport(root)).errors.join("\n"), /unfinished child demo:TSK-1/);
    writeFileSync(
      parent,
      readFileSync(parent, "utf8")
        .replace("status: Accepted", "status: Planned")
        .replace("status: Planned\n", "status: Planned\nparent: demo:TSK-1\n"),
    );
    assert.match((await validationReport(root)).errors.join("\n"), /parent cycle/);
    writeFileSync(parent, readFileSync(parent, "utf8").replace("parent: demo:TSK-1\n", ""));
    writeFileSync(
      child,
      readFileSync(child, "utf8").replace(
        "status: Planned\n",
        "status: Planned\ndepends_on: [demo:TSK-0, demo:TSK-00]\n",
      ),
    );
    assert.match((await validationReport(root)).errors.join("\n"), /duplicate\s+'depends_on'\s+reference/);
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid proposed task relationships leave records and maps unchanged and do not reuse reserved IDs", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-task-creation-")),
    root = join(directory, "demo");
  mkdirSync(root);
  try {
    run(root, true, "setup-project", root);
    copyFileSync(
      resolve(import.meta.dirname, "../../../resources/verification/CHARTER.md"),
      join(root, "workbench/CHARTER.md"),
    );
    run(root, true, "record", "add", "task", "Parent");
    run(root, true, "record", "add", "task", "Child", "--parent", "TSK-0");
    const map = readFileSync(join(root, "workbench/task-map.md"), "utf8"),
      before = scan(root, "TSK").map(({ path }) => [path, readFileSync(path, "utf8")]);
    for (const options of [
      ["--parent", "TSK-0", "--depends-on", "TSK-0"],
      ["--parent", "TSK-1", "--depends-on", "TSK-0"],
      ["--depends-on", "TSK-1", "--depends-on", "TSK-01"],
    ]) {
      const output = run(root, false, "record", "add", "task", "Invalid", ...options);
      assert.match(output, /relationship cycle|duplicate dependency/);
      assert.doesNotMatch(output, /Created /);
      assert.deepEqual(
        scan(root, "TSK").map(({ path }) => [path, readFileSync(path, "utf8")]),
        before,
      );
      assert.equal(readFileSync(join(root, "workbench/task-map.md"), "utf8"), map);
      assert.deepEqual(readdirSync(join(root, "workbench/tasks")), ["TSK-00.md", "TSK-01.md"]);
      run(root, true, "validate");
    }
    run(root, true, "record", "add", "task", "Independent", "--depends-on", "TSK-1");
    assert.deepEqual(
      scan(root, "TSK").map(({ number }) => number),
      ["0", "1", "5"],
    );
    const completed = join(root, "workbench/tasks/TSK-05.md");
    writeFileSync(completed, readFileSync(completed, "utf8").replace("status: Planned", "status: Canceled"));
    run(root, true, "sync");
    const completedMap = readFileSync(join(root, "workbench/task-map.md"), "utf8");
    assert.match(run(root, false, "record", "add", "task", "Late child", "--parent", "TSK-5"), /Reopen parent/);
    assert.equal(readFileSync(join(root, "workbench/task-map.md"), "utf8"), completedMap);
    assert.deepEqual(
      scan(root, "TSK").map(({ number }) => number),
      ["0", "1", "5"],
    );
    run(root, true, "validate");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reciprocal contextual task citations do not create dependency cycles", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-contextual-links-"));
  const directory = join(root, "workbench/tasks");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
  try {
    for (const [id, related] of [
      ["0", "1"],
      ["1", "0"],
    ] as const)
      writeFileSync(
        join(directory, `TSK-0${id}.md`),
        `---\nstatus: Planned\n---\n\n# TSK-${id}: Context ${id}\n\nRelated context: demo:TSK-${related}.\n`,
      );
    assert.deepEqual(validateRelationships(root), []);
    for (const [id, dependency] of [
      ["0", "1"],
      ["1", "0"],
    ] as const) {
      const path = join(directory, `TSK-0${id}.md`);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(
          "status: Planned\n",
          `status: Planned\ndepends_on: [demo:TSK-${dependency}]\n`,
        ),
      );
    }
    assert.ok(validateRelationships(root).some((error) => error.includes("dependency cycle")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("family environment profiles support different instance sizes and experiment software histories", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-environment-profiles-"));
  const root = join(directory, "demo");
  mkdirSync(root);
  try {
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    await setupProject(root, "demo");
    copyFileSync(
      resolve(import.meta.dirname, "../../../resources/verification/CHARTER.md"),
      join(root, "workbench/CHARTER.md"),
    );
    await addRecord(root, "ENV", "AWS r8a family");
    const environment = join(root, "workbench/environments/ENV-00.md");
    let contents = readFileSync(environment, "utf8");
    contents = contents.replace(
      "## Hardware configuration\n",
      "## Hardware configuration\n\nPublic hardware family with optional instance captures.\n",
    );
    writeFileSync(environment, contents);
    await formatFiles(root, undefined, { all: true, write: true });
    synchronize(root);
    assert.deepEqual((await validationReport(root)).errors, []);
    contents += "\n## Configuration profiles\n";
    const captures = new Map<string, Buffer>();
    const profileLinks = [];
    for (const [type, cores] of [
      ["r8a.2xlarge", 8],
      ["r8a.4xlarge", 16],
    ] as const) {
      const profile = `ENV-00/${type}/capture-01/inventory.json`;
      const path = join(root, "workbench/environments", profile);
      mkdirSync(join(path, ".."), { recursive: true });
      const data = Buffer.from(JSON.stringify({ instance_type: type, cores }));
      writeFileSync(path, data);
      captures.set(path, data);
      profileLinks.push(`- [${type}](${profile})`);
    }
    writeFileSync(
      environment,
      contents.replace("## Configuration profiles\n", `## Configuration profiles\n\n${profileLinks.join("\n")}\n`),
    );
    const protocol = join(directory, "protocol.md");
    writeFileSync(
      protocol,
      "---\nenvironment: demo:ENV-0\n---\n\n" +
        [
          ["Hypothesis", "The candidate reduces parsing time."],
          ["Candidate and baseline", "Compare the new parser against the committed parser."],
          ["Independent variable", "Parser implementation."],
          ["Controls and correctness", "Use the same inputs and verify identical parsed output."],
          ["Workload", "Parse the representative input fixture."],
          ["Evaluation rule", "Report the observed effect and uncertainty, retaining inconclusive results."],
        ]
          .map(([heading, body]) => `## ${String(heading)}\n\n${String(body)}\n`)
          .join("\n"),
    );
    for (const [id, type, os] of [
      [0, "r8a.2xlarge", 1],
      [1, "r8a.4xlarge", 1],
      [2, "r8a.2xlarge", 2],
    ] as const) {
      await createExperiment(root, `Parser comparison ${String(id)}`, protocol);
      const path = join(root, `workbench/experiments/EXP-0${String(id)}.md`);
      assert.equal(recordDocument("EXP", readFileSync(path, "utf8"), path).metadata.environment, "demo:ENV-0");
      writeFileSync(
        path,
        readFileSync(path, "utf8")
          .replace("status: Planned", "status: Inconclusive")
          .replace(
            "## Execution provenance\n",
            `## Execution provenance\n\nInstance ${type}, four allocated CPUs. ` +
              `[Hardware profile](../environments/ENV-00/${type}/capture-01/inventory.json). ` +
              `Test OS ${String(os)}, test-kernel-${String(os)}, test-compiler-${String(os)}; no applied memory limit.\n`,
          )
          .replace("## Evidence\n", "## Evidence\n\nSynthetic fixture; no performance conclusion.\n")
          .replace("## Decision\n", "## Decision\n\nInconclusive: no measurements were collected.\n"),
      );
    }
    await formatFiles(root, undefined, { all: true, write: true });
    synchronize(root);
    assert.deepEqual((await validationReport(root)).errors, []);
    assert.deepEqual(readdirSync(join(root, "workbench/environments")).sort(), ["ENV-00", "ENV-00.md"]);
    assert.match(readFileSync(join(root, "workbench/environment-map.md"), "utf8"), /AWS r8a family/);
    for (const [path, data] of captures) assert.deepEqual(readFileSync(path), data);
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ADR instruction metadata and citation library config are validated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-validation-"));
  const root = join(directory, "demo");
  mkdirSync(root);
  try {
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    await setupProject(root, "demo");
    copyFileSync(
      resolve(import.meta.dirname, "../../../resources/verification/CHARTER.md"),
      join(root, "workbench/CHARTER.md"),
    );
    await addRecord(root, "ADR", "Rule");
    synchronize(root);
    const decision = join(root, "workbench/decisions/ADR-00.md");
    const original = readFileSync(decision, "utf8");
    writeFileSync(decision, original.replace("---\n", "---\nagent_instruction: |\n  Do this.\n  Adjacent prose.\n"));
    assert.match(
      (await validationReport(root)).errors.join("\n"),
      /'agent_instruction' must be one nonempty logical line/,
    );
    writeFileSync(decision, original);
    const config = join(root, "workbench/config.toml");
    writeFileSync(config, readFileSync(config, "utf8").replace("library/citations", "../outside"));
    assert.match((await validationReport(root)).errors.join("\n").replace(/\s+/gu, ""), /citations\.library_dir/);
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repository validation checks every root independently of the active tool profile", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-profile-validation-")));
  try {
    run(root, true, "setup-project", root);
    copyFileSync(
      resolve(import.meta.dirname, "../../../resources/verification/CHARTER.md"),
      join(root, "workbench/CHARTER.md"),
    );
    mkdirSync(join(root, "app"));
    const projects = join(root, "workbench/projects.toml");
    writeFileSync(
      projects,
      `${readFileSync(projects, "utf8")}\n[[language_root]]\nlanguage = "typescript"\npath = "."\n\n[[language_root]]\nlanguage = "typescript"\npath = "app"\n`,
    );
    const config = join(root, "workbench/config.toml");
    writeFileSync(
      config,
      `${readFileSync(config, "utf8")}\n[[toolchains.profiles]]\nname = "root-only"\npaths = ["."]\ntools.node = "22.23.3"\n`,
    );
    run(root, true, "sync");
    vi.stubEnv("WORKBENCH_TOOLCHAIN", "root-only");
    vi.stubEnv("WORKBENCH_TOOLCHAIN_ROOT", root);
    assert.match(run(root, true, "validate"), /validation passed/);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
