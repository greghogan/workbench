import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { parse } from "smol-toml";
import { parse as parseYaml } from "yaml";

const distribution = resolve(import.meta.dirname, "..");
const executable = join(distribution, "bundle/main.cjs");
const charter = join(distribution, "workbench/CHARTER.md");

function invoke(root, ...args) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution },
    encoding: "utf8",
  });
}
function run(root, ...args) {
  const result = invoke(root, ...args);
  assert.equal(result.status, 0, `workbench ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function fails(root, ...args) {
  const result = invoke(root, ...args);
  assert.notEqual(result.status, 0, `workbench ${args.join(" ")} unexpectedly succeeded`);
  return result.stderr;
}

function exercise(root, project, directory, subproject) {
  // Reuse the existing human-written charter as fixture data; the app never generates one.
  copyFileSync(charter, join(directory, "workbench/CHARTER.md"));
  for (const kind of ["ADR", "TSK", "ENV", "CIT"]) {
    const name = { ADR: "decision", TSK: "task", ENV: "environment", CIT: "citation" }[kind];
    run(root, name, kind === "CIT" ? "draft" : "add", "Fixture record", ...(subproject ? ["--project", project] : []));
    const folder = { ADR: "decisions", TSK: "tasks", ENV: "environments", CIT: "citations" }[kind];
    const extension = kind === "CIT" ? "yaml" : "md";
    const path = join(directory, `workbench/${folder}/${kind}-00.${extension}`);
    assert.ok(existsSync(path), path);
    if (kind === "ENV") {
      writeFileSync(
        path,
        "---\n{}\n---\n\n# ENV-0: Fixture record\n\n## Hardware configuration\n\nOne x86_64 test host.\n\n" +
          "## Limits\n\nNo topology guarantees.\n",
      );
    }
    if (kind === "CIT") {
      writeFileSync(
        path,
        `references:\n  - id: ${project}-CIT-0\n    type: article\n    title: Fixture record\n` +
          "    # Attribution comment\n    author:\n      - family: Example\n        given: Alice\n    issued:\n      date-parts:\n        - [2026]\n" +
          "    URL: https://example.test/paper\nworkbench:\n  sources:\n    - kind: published\n" +
          "      landing-url: https://example.test/paper\n      status: pending\n",
      );
      assert.match(fails(root, "citation", "fetch", "--all", "--project", project), /require manual acquisition/);
      assert.equal(parseYaml(readFileSync(path, "utf8")).workbench.sources[0].status, "pending");
      const pending = readFileSync(path, "utf8");
      for (const state of [
        "status: acquired",
        "status: unknown",
        `status: unavailable\n      sha256: '${"0".repeat(64)}'`,
      ]) {
        writeFileSync(path, pending.replace("status: pending", state));
        assert.match(
          fails(root, "citation", "fetch", "--all", "--project", project),
          /source status|acquired source|all-zero digest/,
        );
      }
      writeFileSync(path, pending.replace("status: pending", "status: unavailable"));
      run(root, "citation", "fetch", "--all", "--project", project);
      assert.equal(existsSync(join(directory, "library/citations/CIT-00-published.pdf")), false);
      const download = join(directory, "downloaded.pdf");
      writeFileSync(download, "%PDF-1.7\nfixture\n");
      run(root, "citation", "import", `${project}:CIT-0`, download);
      const acquired = parseYaml(readFileSync(path, "utf8")).workbench.sources[0];
      assert.equal(acquired.status, "acquired");
      assert.equal(acquired.sha256, createHash("sha256").update(readFileSync(download)).digest("hex"));
      assert.ok(existsSync(join(directory, "library/citations/CIT-00-published.pdf")));
      assert.match(readFileSync(path, "utf8"), /# Attribution comment/);
      writeFileSync(join(directory, "library/citations/CIT-00-published.pdf"), "%PDF-1.7\nmodified\n");
      assert.match(fails(root, "citation", "fetch", "--all", "--project", project), /SHA-256/);
      writeFileSync(join(directory, "library/citations/CIT-00-published.pdf"), "%PDF-1.7\nfixture\n");
      run(root, "citation", "fetch", "--all", "--project", project);
    }
    run(root, name, "show", `${project}:${kind}-0`);
  }
  const protocol = join(directory, "protocol.md");
  writeFileSync(
    protocol,
    "---\n# Protocol provenance comment\nenvironment: null\n---\n\n## Hypothesis\nFaster.\n\n## Candidate and baseline\nNew and old.\n\n" +
      "## Independent variable\nAlgorithm.\n\n## Controls and correctness\nEqual answers.\n\n" +
      "## Workload\nSame input.\n\n## Evaluation rule\nLower median.\n",
  );
  run(
    root,
    "experiment",
    "add",
    "Fixture trial",
    "--protocol",
    protocol,
    ...(subproject ? ["--project", project] : []),
  );
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
  run(root, "release", "add", specification, ...(subproject ? ["--project", project] : []));
  assert.ok(existsSync(join(directory, "workbench/releases/REL-00.yaml")));
  run(root, "release", "show", `${project}:REL-0`);
  run(root, "format", "--all", "--write");
  run(root, "sync");
  assert.match(readFileSync(join(directory, "workbench/decision-map.md"), "utf8"), new RegExp(`${project}:ADR-0`));
  for (const type of ["decision", "task", "experiment", "environment", "citation", "release"]) {
    assert.ok(existsSync(join(directory, `workbench/${type}-map.md`)));
  }
  assert.match(readFileSync(join(directory, "workbench/release-index.tsv"), "utf8"), /0\.1\.0\tportable-node/);
}

test("lifecycle with every record type before and after adding a subproject", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-project-"));
  const root = join(directory, "demo");
  mkdirSync(root);
  try {
    run(root, "setup-project", root);
    assert.equal(existsSync(join(root, "workbench/CHARTER.md")), false);
    assert.equal(readFileSync(join(root, "Makefile"), "utf8"), readFileSync(join(distribution, "Makefile"), "utf8"));
    const customMakefile = "all:\n\t@echo consumer command\n";
    writeFileSync(join(root, "Makefile"), customMakefile);
    run(root, "setup-project", root);
    assert.equal(readFileSync(join(root, "Makefile"), "utf8"), customMakefile);
    exercise(root, "demo", root, false);
    run(root, "validate");
    const component = join(root, "component");
    mkdirSync(join(component, "workbench"), { recursive: true });
    copyFileSync(charter, join(component, "workbench/CHARTER.md"));
    run(root, "project", "add", "component", "component");
    assert.equal(existsSync(join(component, "AGENTS.md")), false);
    exercise(root, "component", component, true);
    run(root, "validate");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hierarchical help and short help", () => {
  const root = distribution;
  const short = run(root, "-h");
  assert.equal(short, run(root, "--help"));
  assert.equal(short, run(root, "help"));
  assert.equal(short, run(root));
  assert.equal(run(root, "help", "task"), run(root, "task", "--help"));
  assert.match(run(root, "help", "task"), /Examples:/);
  assert.match(run(root, "help", "citation", "fetch"), /Usage: workbench citation fetch/);
  const complete = run(root, "--help-all");
  assert.match(complete, /COMMAND: workbench citation fetch/);
  assert.match(complete, /COMMAND: workbench review approve/);
  assert.doesNotMatch(complete, /COMMAND: workbench review check/);
  assert.match(fails(root, "help", "review", "check"), /unknown command/);
  assert.doesNotMatch(short, /setup-project/);
});

test.each([false, true])("TypeScript starter preserves check ownership and independent roots (inline=%s)", (inline) => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-language-"));
  const root = join(directory, "demo");
  mkdirSync(join(root, "web"), { recursive: true });
  mkdirSync(join(root, "api"), { recursive: true });
  try {
    run(root, "setup-project", root);
    if (inline) {
      const config = join(root, "workbench/config.toml");
      writeFileSync(
        config,
        readFileSync(config, "utf8") + '\n[[check]]\nname="existing"\nrole="test"\ncommand=["node", "--version"]\n',
      );
    }
    run(root, "language", "init", "typescript", "web");
    run(root, "language", "init", "typescript", "api");
    const registry = parse(readFileSync(join(root, "workbench/projects.toml"), "utf8"));
    assert.deepEqual(
      registry.language_root.map((entry) => ({ ...entry })),
      [
        { language: "typescript", path: "web" },
        { language: "typescript", path: "api" },
      ],
    );
    assert.deepEqual(
      registry.project.map((entry) => ({ ...entry })),
      [{ id: "demo", path: "." }],
    );
    for (const name of ["package.json", "pnpm-lock.yaml", "tsconfig.json", "eslint.config.mjs", "vitest.config.mjs"])
      assert.ok(existsSync(join(root, "web", name)));
    const checks = run(root, "checks");
    assert.equal(existsSync(join(root, "workbench/automation.toml")), !inline);
    if (inline) assert.match(checks, /existing/);
    assert.match(checks, /typescript@web type/);
    assert.match(checks, /typescript@api test/);
    writeFileSync(join(root, "web/tsconfig.json"), '{"compilerOptions":{"strict":false}}\n');
    assert.match(run(root, "checks"), /typescript@web type/);
    assert.match(fails(root, "language", "init", "typescript", "web"), /already registered/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
