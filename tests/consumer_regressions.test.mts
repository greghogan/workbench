import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parse, stringify as yaml } from "yaml";
import { stringify as toml } from "smol-toml";
import { setupProject } from "../src/projects.ts";
import { initLanguage } from "../src/languages.ts";
import { readChecks } from "../src/checks.ts";
import { validateRecords, validateRelationships } from "../src/records.ts";
import { addRelease, parseRelease } from "../src/releases.ts";
import { packageOutput } from "../scripts/package-output.mjs";

const distribution = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-consumer-")));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  return root;
}

test("public launcher discovers the consuming project from nested cwd and honors an explicit snapshot", async () => {
  const root = fixture();
  await setupProject(root, "consumer");
  const nested = join(root, "src");
  mkdirSync(nested);
  for (const [cwd, override] of [
    [nested, undefined],
    [distribution, root],
  ] as const) {
    const env = { ...process.env };
    delete env.WORKBENCH_PROJECT_ROOT;
    if (override) env.WORKBENCH_PROJECT_ROOT = override;
    const result = spawnSync(
      process.execPath,
      [join(distribution, "bin/workbench.mjs"), "record", "add", "task", "Consumer task"],
      {
        cwd,
        env,
        encoding: "utf8",
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  expect(readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8")).toContain("Consumer task");
  expect(readFileSync(join(root, "workbench/tasks/TSK-01.md"), "utf8")).toContain("Consumer task");
});

test("two language suites can share a root and custom starters preserve binary and executable files", async () => {
  const root = fixture();
  await setupProject(root, "consumer");
  const reference = join(root, "reference");
  mkdirSync(reference);
  writeFileSync(join(reference, "LICENSE"), "example licensing");
  writeFileSync(join(root, "LICENSE"), "consumer licensing");
  const binary = Buffer.from([0, 255, 128, 10]);
  writeFileSync(join(reference, "asset.bin"), binary);
  writeFileSync(join(reference, "run"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(reference, "run"), 0o755);
  for (const id of ["first", "second"]) {
    const directory = join(root, "workbench/languages", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "config.toml"),
      toml({
        schema_version: 1,
        id,
        name: id,
        summary: "Fixture language",
        reference: "reference",
        manifests: ["run"],
        ...(id === "first" ? { starter: ["run", "asset.bin", "LICENSE"] } : {}),
      }),
    );
    writeFileSync(
      join(directory, "automation.toml"),
      toml({
        schema_version: 1,
        command: [{ role: "test", command: ["node", "-e", `require('node:fs').writeFileSync('${id}.txt','passed')`] }],
      }),
    );
  }
  initLanguage(root, "first");
  expect(readFileSync(join(root, "asset.bin"))).toEqual(binary);
  expect(readFileSync(join(root, "LICENSE"), "utf8")).toBe("consumer licensing");
  expect(readFileSync(join(root, "LICENSE.workbench-example"), "utf8")).toBe("example licensing");
  if (process.platform !== "win32") expect(statSync(join(root, "run")).mode & 0o100).toBe(0o100);
  writeFileSync(
    join(root, "workbench/projects.toml"),
    toml({
      project: [{ id: "consumer", path: "." }],
      language_root: [
        { language: "first", path: "." },
        { language: "second", path: "." },
      ],
    }),
  );
  writeFileSync(
    join(root, "workbench/automation.toml"),
    toml({
      check_suite: [
        { language: "first", path: "." },
        { language: "second", path: "." },
      ],
    }),
  );
  const checks = readChecks(root);
  expect(new Set(checks.map((entry) => entry.name)).size).toBe(2);
  for (const check of checks) {
    const result = spawnSync(required(check.command[0], "Check command"), check.command.slice(1), { cwd: root });
    expect(result.status).toBe(0);
  }
  for (const id of ["first", "second"]) expect(readFileSync(join(root, `${id}.txt`), "utf8")).toBe("passed");
});

test("task validation rejects mixed parent/dependency deadlocks but permits sibling ordering", async () => {
  const root = fixture();
  await setupProject(root, "consumer");
  mkdirSync(join(root, "workbench/tasks"), { recursive: true });
  function task(id: number, parent: string | null, dependencies: string[]) {
    writeFileSync(
      join(root, `workbench/tasks/TSK-0${String(id)}.md`),
      `---\n${yaml({ status: "Active", parent, depends_on: dependencies })}---\n\n# TSK-${String(id)}: Task\n`,
    );
  }
  task(0, null, []);
  task(1, "consumer:TSK-0", ["consumer:TSK-0"]);
  expect(validateRelationships(root).join("\n")).toContain("task completion cycle");
  task(1, "consumer:TSK-0", ["consumer:TSK-2"]);
  task(2, null, ["consumer:TSK-0"]);
  expect(validateRelationships(root).join("\n")).toContain("task completion cycle");
  task(2, "consumer:TSK-0", []);
  expect(validateRelationships(root)).toEqual([]);
});

test("release creation preserves extensions and validation rejects malformed records and foreign identities", async () => {
  const root = fixture();
  await setupProject(root, "consumer");
  writeFileSync(join(root, "app.tar"), "artifact");
  const specification = {
    version: "1.0.0",
    revision: "a".repeat(40),
    tag: "v1.0.0",
    released: "2026-10-11",
    notes: { summary: "First release", changes: [], extensions: { audience: "developers" } },
    artifacts: [
      { target: "linux-x64", path: "app.tar", url: "https://example.com/app.tar", extensions: { media: "tar" } },
    ],
    extensions: { channel: "stable" },
  };
  writeFileSync(join(root, "release.yaml"), yaml(specification));
  const path = await addRelease(root, join(root, "release.yaml"));
  const release = parseRelease(readFileSync(path, "utf8"), path, "0", "consumer");
  expect(release.extensions).toEqual(specification.extensions);
  expect(required(release.artifacts[0], "Expected fixture value: release.artifacts[0]").extensions).toEqual({
    media: "tar",
  });
  for (const update of [
    { yanked: "false" },
    { released: "2026-02-30" },
    { surprise: true },
    { id: "other-REL-0" },
    { artifacts: [null] },
  ])
    expect(() => parseRelease(yaml({ ...release, ...update }), path, "0", "consumer")).toThrow();
  mkdirSync(join(root, "workbench/citations"), { recursive: true });
  const citation = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/records/CIT-00.json"), "utf8")) as {
    id: string;
  }[];
  required(citation[0], "Citation fixture").id = "other-CIT-0";
  writeFileSync(join(root, "workbench/citations/CIT-00.json"), JSON.stringify(citation));
  mkdirSync(join(root, "workbench/citations/CIT-00"));
  writeFileSync(
    join(root, "workbench/citations/CIT-00/acquisition.yaml"),
    readFileSync(resolve(import.meta.dirname, "fixtures/records/acquisition.yaml")),
  );
  expect(validateRecords(root, "consumer").join("\n")).toContain("consumer-CIT-0");
});

test("package replacement preserves source and unowned data, and failed builds retain the previous package", () => {
  const root = fixture();
  const source = join(root, "source");
  mkdirSync(join(source, "workbench"), { recursive: true });
  writeFileSync(join(source, "workbench/CHARTER.md"), "human intent");
  const build = (directory: string) => {
    writeFileSync(join(directory, "payload"), "verified");
  };
  for (const output of [source, root, join(source, "workbench")])
    expect(() => {
      packageOutput(source, output, build);
    }).toThrow(/source checkout/);
  const output = join(root, "release");
  mkdirSync(output);
  writeFileSync(join(output, "user-file"), "keep");
  expect(() => {
    packageOutput(source, output, build);
  }).toThrow(/unowned/);
  expect(readFileSync(join(output, "user-file"), "utf8")).toBe("keep");
  const owned = join(root, "owned");
  packageOutput(source, owned, build);
  expect(() => {
    packageOutput(source, owned, () => {
      throw new Error("failed validation");
    });
  }).toThrow(/failed validation/);
  expect(readFileSync(join(owned, "payload"), "utf8")).toBe("verified");
  packageOutput(source, owned, (stage: string) => {
    writeFileSync(join(stage, "payload"), "updated");
  });
  expect(readFileSync(join(owned, "payload"), "utf8")).toBe("updated");
  const linked = join(root, "linked");
  symlinkSync(owned, linked, "junction");
  expect(() => {
    packageOutput(source, join(linked, "nested"), build);
  }).toThrow(/symlink/);
  expect(existsSync(`${owned}.lock`)).toBe(false);
  expect(readFileSync(join(source, "workbench/CHARTER.md"), "utf8")).toBe("human intent");
});

test("hosted workflow uses the shared native and managed target executor", () => {
  const workflow = parse(
    readFileSync(join(distribution, ".github/workflows/checks.yml"), "utf8"),
  ) as import("./fixtures/workflow.mjs").Workflow;
  expect(workflow.jobs.native.steps.some((step) => step.run === "node scripts/ci-hosted.mjs native")).toBe(true);
  expect(
    required(workflow.jobs.environments, "Fixture value workflow.jobs.environments").steps.some(
      (step) => step.run === "node scripts/ci-hosted.mjs environment",
    ),
  ).toBe(true);
});
