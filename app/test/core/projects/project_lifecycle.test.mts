import { languageRootsFromData, projectsFromData } from "../../../src/core/projects/project-configuration.ts";
import { required } from "../../../src/core/runtime/invariants.ts";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { parse } from "smol-toml";

import { distribution } from "../../fixtures/adoption.mjs";
import {
  exerciseProjectRecords,
  failProjectCli as fails,
  projectFixtureCharter as charter,
  runProjectCli as run,
} from "../../fixtures/project-lifecycle.mjs";

test("project setup preserves an existing Makefile and supports every root record type", async () => {
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
    copyFileSync(charter, join(root, "workbench/CHARTER.md"));
    await exerciseProjectRecords(root, "demo");
    run(root, "validate");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hierarchical help and short help", () => {
  const root = distribution;
  run(root, "project", "add", root);
  const short = run(root, "-h");
  assert.equal(short, run(root, "--help"));
  assert.equal(short, run(root, "help"));
  assert.equal(short, run(root));
  const recordHelp = run(root, "help", "record");
  assert.equal(recordHelp, run(root, "record", "--help"));
  assert.match(recordHelp, /add/);
  assert.match(run(root, "help", "citation", "fetch"), /Usage: workbench citation fetch/);
  const complete = run(root, "--help-all");
  assert.match(complete, /COMMAND: workbench citation fetch/);
  assert.match(complete, /COMMAND: workbench commit\n/);
  assert.match(complete, /COMMAND: workbench commit check/);
  assert.match(run(root, "help", "commit", "check"), /project conventions/);
  assert.match(run(root, "help", "commit"), /--provisional/);
  assert.doesNotMatch(complete, /COMMAND: workbench review approve/);
  assert.doesNotMatch(complete, /COMMAND: workbench review check/);
  assert.match(fails(root, "help", "review", "check"), /unknown command/);
  assert.doesNotMatch(short, /setup-project/);
  const commandGroups = (help: string): Record<string, string[]> =>
    Object.fromEntries(
      [...help.matchAll(/^([A-Z][\w ]*):\n((?: {2}.*\n)+)/gm)]
        .filter(([, heading]) => !["Options", "Arguments"].includes(required(heading, "Expected fixture value")))
        .map(
          ([, heading, body]) =>
            [
              required(heading, "Command heading"),
              [...required(body, "Expected fixture value: body").matchAll(/^ {2}([a-z][\w-]*)\b/gm)].map((match) =>
                required(match[1], "Command name"),
              ),
            ] as const,
        ),
    );
  const publicChildren = (path: string[]) => {
    const prefix = `COMMAND: workbench ${path.length ? path.join(" ") + " " : ""}`;
    return complete
      .split("\n")
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length))
      .filter((name) => /^[a-z][\w-]*$/.test(name));
  };
  const verifyDiscovery = (help: string, path: string[]) => {
    const groups = commandGroups(help),
      names = Object.values(groups).flat();
    assert.ok(names.length > 0, "public help must expose available commands");
    assert.equal(new Set(names).size, names.length, "commands must not appear in multiple groups");
    assert.deepEqual([...names].sort(), publicChildren(path).sort(), "short and complete help must agree");
    return groups;
  };
  const groups = verifyDiscovery(short, []);
  assert.ok(groups.Projects?.includes("init"));
  assert.ok(groups["Records and context"]?.includes("record"));
  assert.ok(groups["Workbench settings"]?.includes("config"));
  assert.equal(Object.hasOwn(groups, "Commands"), false, "top-level commands need a discovery group");
  for (const path of [["check"], ["development"], ["citation"], ["feedback"], ["language"], ["collection"]]) {
    const help = run(root, ...path, "--help");
    verifyDiscovery(help, path);
    assert.equal(help, run(root, "help", ...path));
  }
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
      languageRootsFromData(registry, "fixture").map((entry) => ({ ...entry })),
      [
        { language: "typescript", path: "web" },
        { language: "typescript", path: "api" },
      ],
    );
    assert.deepEqual(
      projectsFromData(registry, "fixture").map((entry) => ({ ...entry })),
      [{ id: "demo", path: "." }],
    );
    for (const name of ["package.json", "pnpm-lock.yaml", "tsconfig.json", "eslint.config.mjs", "vitest.config.mjs"])
      assert.ok(existsSync(join(root, "web", name)));
    for (const name of ["eslint.config.mjs", "vitest.config.mjs"])
      assert.equal(
        readFileSync(join(root, "web", name), "utf8"),
        readFileSync(join(distribution, "examples/languages/typescript", name), "utf8"),
        `new TypeScript roots must receive the complete starter ${name}`,
      );
    const checks = run(root, "check", "--list");
    assert.equal(existsSync(join(root, "workbench/automation.toml")), !inline);
    if (inline) assert.match(checks, /existing/);
    assert.match(checks, /web: type/);
    assert.match(checks, /api: test/);
    const selected = parse(
      readFileSync(join(root, inline ? "workbench/config.toml" : "workbench/automation.toml"), "utf8"),
    ) as Pick<import("../../../src/core/projects/project-model.ts").Config, "check_suite" | "check">;
    assert.deepEqual(
      required(selected.check_suite, "Expected fixture value: selected.check_suite").map((entry) => ({ ...entry })),
      [
        { language: "typescript", path: "web" },
        { language: "typescript", path: "api" },
      ],
    );
    assert.equal(selected.check?.length ?? 0, inline ? 1 : 0);
    writeFileSync(join(root, "web/tsconfig.json"), '{"compilerOptions":{"strict":false}}\n');
    assert.match(run(root, "check", "--list"), /web: type/);
    assert.match(fails(root, "language", "init", "typescript", "web"), /already registered/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["java", "javascript"])(
  "%s starter copies project inputs and references its own shared suite",
  (language) => {
    const directory = mkdtempSync(join(tmpdir(), "workbench-new-language-"));
    const root = join(directory, "demo");
    mkdirSync(join(root, "app"), { recursive: true });
    try {
      run(root, "setup-project", root);
      writeFileSync(join(root, "app/README.md"), "# User documentation\n");
      const external = join(directory, "external");
      mkdirSync(external);
      symlinkSync(external, join(root, "app/src"), "junction");
      assert.match(fails(root, "language", "init", language, "app"), /real project path/);
      assert.equal(existsSync(join(root, "app", language === "java" ? "pom.xml" : "package.json")), false);
      assert.equal(existsSync(join(external, language === "java" ? "main" : "arithmetic.js")), false);
      rmSync(join(root, "app/src"));
      run(root, "language", "init", language, "app");
      assert.equal(readFileSync(join(root, "app/README.md"), "utf8"), "# User documentation\n");
      const metadata = parse(readFileSync(join(distribution, `languages/${language}/config.toml`), "utf8"));
      if (!Array.isArray(metadata.starter) || !metadata.starter.every((value) => typeof value === "string"))
        throw new Error("Expected starter files");
      for (const file of metadata.starter) assert.ok(existsSync(join(root, "app", file)), file);
      assert.match(run(root, "check", "--list"), /app: test/);
      assert.match(fails(root, "language", "init", language, "app"), /already registered/);
      if (language === "javascript")
        assert.equal(
          (JSON.parse(readFileSync(join(root, "app/package.json"), "utf8")) as { name: string }).name,
          "app",
        );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("project names retain stable IDs and nested CLI listings use declared name breadcrumbs", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-project-names-"));
  try {
    assert.match(
      run(root, "init", "--records-only", "--no-workbench-collection", "--id", "graphai", "--name", "GraphAI"),
      /GraphAI/,
    );
    copyFileSync(charter, join(root, "workbench/CHARTER.md"));
    run(root, "subproject", "add", "graphmp", "packages/compute", "--name", "GraphMP");
    copyFileSync(charter, join(root, "packages/compute/workbench/CHARTER.md"));
    run(root, "subproject", "add", "solver", "packages/compute/src/solver");
    assert.match(run(root, "subproject"), /GraphAI\/GraphMP \(graphmp\)/);
    assert.match(run(root, "subproject"), /GraphAI\/GraphMP\/solver/);
    const projects = projectsFromData(parse(readFileSync(join(root, "workbench/projects.toml"), "utf8")), "fixture");
    assert.deepEqual(
      projects.map((project) => project.id),
      ["graphai", "graphmp", "solver"],
    );
    assert.equal(projects[2]?.name, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
