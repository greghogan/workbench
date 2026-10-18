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
import { recordDocument } from "../src/record-document.ts";
import { validateRelationships } from "../src/records.ts";

const distribution = resolve(import.meta.dirname, "..");
const executable = join(distribution, "bundle/main.cjs");

function run(root: string, expected: boolean, ...arguments_: string[]) {
  const result = spawnSync(process.execPath, [executable, ...arguments_], {
    cwd: root,
    env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution },
    encoding: "utf8",
  });
  assert.equal(result.status === 0, expected, `${arguments_.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

test("task hierarchy and duplicate dependencies are validated", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-relationships-"));
  const root = join(directory, "demo");
  mkdirSync(root);
  try {
    run(root, true, "setup-project", root);
    copyFileSync(resolve(import.meta.dirname, "fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    run(root, true, "record", "add", "task", "Parent");
    run(root, true, "record", "add", "task", "Child", "--parent", "demo:TSK-0");
    run(root, true, "validate");
    const parent = join(root, "workbench/tasks/TSK-00.md");
    const child = join(root, "workbench/tasks/TSK-01.md");
    assert.deepEqual(recordDocument("TSK", readFileSync(parent, "utf8"), parent).metadata, { status: "Planned" });
    assert.deepEqual(recordDocument("TSK", readFileSync(child, "utf8"), child).metadata, {
      status: "Planned",
      parent: "demo:TSK-0",
    });
    run(root, true, "record", "add", "task", "Dependent", "--depends-on", "demo:TSK-1");
    const dependent = join(root, "workbench/tasks/TSK-02.md");
    assert.deepEqual(recordDocument("TSK", readFileSync(dependent, "utf8"), dependent).metadata, {
      status: "Planned",
      depends_on: ["demo:TSK-1"],
    });
    run(root, true, "validate");
    writeFileSync(parent, readFileSync(parent, "utf8").replace("status: Planned", "status: Done"));
    assert.match(run(root, false, "validate"), /unfinished child demo:TSK-1/);
    writeFileSync(
      parent,
      readFileSync(parent, "utf8")
        .replace("status: Done", "status: Planned")
        .replace("status: Planned\n", "status: Planned\nparent: demo:TSK-1\n"),
    );
    assert.match(run(root, false, "validate"), /parent cycle/);
    writeFileSync(parent, readFileSync(parent, "utf8").replace("parent: demo:TSK-1\n", ""));
    writeFileSync(
      child,
      readFileSync(child, "utf8").replace(
        "status: Planned\n",
        "status: Planned\ndepends_on: [demo:TSK-0, demo:TSK-00]\n",
      ),
    );
    assert.match(run(root, false, "validate"), /duplicate 'depends_on' reference/);
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

test("family environment profiles support different instance sizes and experiment software histories", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-environment-profiles-"));
  const root = join(directory, "demo");
  mkdirSync(root);
  try {
    run(root, true, "setup-project", root);
    copyFileSync(resolve(import.meta.dirname, "fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    run(root, true, "record", "add", "environment", "AWS r8a family");
    const environment = join(root, "workbench/environments/ENV-00.md");
    let contents = readFileSync(environment, "utf8");
    assert.match(contents, /## Configuration profiles/);
    contents = contents
      .replace(
        "## Hardware configuration\n",
        "## Hardware configuration\n\nAWS r8a family; sizes have separate captures.\n",
      )
      .replace("## Limits\n", "## Limits\n\nShared family membership does not imply equivalent performance.\n");
    const captures = new Map<string, Buffer>();
    const profileLinks = [];
    for (const [type, cores] of [
      ["r8a.2xlarge", 8],
      ["r8a.4xlarge", 16],
    ] as const) {
      const profile = `ENV-00/${type}/capture-01/inventory.json`;
      const path = join(root, "workbench/environments", profile);
      mkdirSync(join(path, ".."), { recursive: true });
      const data = Buffer.from(
        JSON.stringify({ instance_type: type, cores, os: "Test OS 1", kernel: "test-kernel-1" }),
      );
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
      run(root, true, "record", "add", "experiment", `Parser comparison ${String(id)}`, "--protocol", protocol);
      const path = join(root, `workbench/experiments/EXP-0${String(id)}.md`);
      assert.equal(recordDocument("EXP", readFileSync(path, "utf8"), path).metadata.environment, "demo:ENV-0");
      writeFileSync(
        path,
        readFileSync(path, "utf8")
          .replace("status: Running", "status: Inconclusive")
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
    run(root, true, "format", "--all", "--write");
    run(root, true, "sync");
    run(root, true, "validate");
    assert.deepEqual(readdirSync(join(root, "workbench/environments")).sort(), ["ENV-00", "ENV-00.md"]);
    assert.match(readFileSync(join(root, "workbench/environment-map.md"), "utf8"), /AWS r8a family/);
    for (const [path, data] of captures) assert.deepEqual(readFileSync(path), data);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ADR instruction metadata and citation library config are validated", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-validation-"));
  const root = join(directory, "demo");
  mkdirSync(root);
  try {
    run(root, true, "setup-project", root);
    copyFileSync(resolve(import.meta.dirname, "fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    run(root, true, "record", "add", "decision", "Rule");
    const decision = join(root, "workbench/decisions/ADR-00.md");
    const original = readFileSync(decision, "utf8");
    writeFileSync(decision, original.replace("---\n", "---\nagent_instruction: |\n  Do this.\n  Adjacent prose.\n"));
    assert.match(run(root, false, "validate"), /'agent_instruction' must be one nonempty logical line/);
    writeFileSync(decision, original);
    const config = join(root, "workbench/config.toml");
    writeFileSync(config, readFileSync(config, "utf8").replace("library/citations", "../outside"));
    assert.match(run(root, false, "validate"), /citations.library_dir/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repository validation checks every root independently of the active tool profile", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-profile-validation-")));
  try {
    run(root, true, "setup-project", root);
    copyFileSync(resolve(import.meta.dirname, "fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
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
