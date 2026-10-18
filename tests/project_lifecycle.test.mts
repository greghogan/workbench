interface CitationFixture {
  id: string;
  present: boolean;
  state: string;
}
interface AcquisitionFixture {
  sources: { status: string; sha256: string }[];
}
import { languageRootsFromData, projectsFromData } from "../src/core.ts";
import { required } from "../src/invariants.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
import { join, resolve } from "node:path";
import { test } from "vitest";
import { parse } from "smol-toml";
import { parse as parseYaml } from "yaml";

const distribution = resolve(import.meta.dirname, "..");
const executable = join(distribution, "bundle/main.cjs");
const charter = resolve(import.meta.dirname, "fixtures/records/CHARTER.md");

function invoke(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution },
    encoding: "utf8",
  });
}
function run(root: string, ...args: string[]) {
  const result = invoke(root, ...args);
  assert.equal(result.status, 0, `workbench ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function fails(root: string, ...args: string[]) {
  const result = invoke(root, ...args);
  assert.notEqual(result.status, 0, `workbench ${args.join(" ")} unexpectedly succeeded`);
  return result.stderr;
}

function exercise(root: string, project: string, directory: string, subproject: boolean) {
  // Reuse the existing human-written charter as fixture data; the app never generates one.
  copyFileSync(charter, join(directory, "workbench/CHARTER.md"));
  for (const kind of ["ADR", "TSK", "ENV", "CIT"]) {
    const name = { ADR: "decision", TSK: "task", ENV: "environment", CIT: "citation" }[kind];
    run(
      root,
      "record",
      "add",
      required(name, "Expected fixture value"),
      "Fixture record",
      ...(subproject ? ["--project", project] : []),
    );
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
      writeFileSync(
        path,
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
          "    landing-url: https://example.test/paper\n    status: pending\n",
      );
      const absent = JSON.parse(run(root, "citation", "--json", "--project", project)) as CitationFixture[];
      assert.equal(required(absent[0], "Expected fixture value").id, `${project}:CIT-0`);
      assert.equal(required(absent[0], "Expected fixture value").present, false);
      assert.equal(required(absent[0], "Expected fixture value").state, "pending");
      assert.ok(
        (JSON.parse(run(root, "citation", "--json", "--missing")) as CitationFixture[]).some(
          (entry: { id: string }) => entry.id === `${project}:CIT-0`,
        ),
      );
      assert.match(fails(root, "citation", "fetch"), /have no download-url/);
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
        assert.match(
          fails(root, "citation", "fetch", "--project", project),
          /source status|acquired source|all-zero digest/,
        );
      }
      writeFileSync(acquisition, pending.replace("status: pending", "status: unavailable"));
      run(root, "citation", "fetch", "--project", project);
      assert.equal(existsSync(join(directory, "library/citations/CIT-00-published.pdf")), false);
      const download = join(directory, "downloaded.pdf");
      writeFileSync(download, "%PDF-1.7\nfixture\n");
      run(root, "citation", "import", `${project}:CIT-0`, download);
      const acquired = (parseYaml(readFileSync(acquisition, "utf8")) as AcquisitionFixture).sources[0];
      assert.equal(required(acquired, "Expected fixture value").status, "acquired");
      assert.equal(
        required(acquired, "Expected fixture value").sha256,
        createHash("sha256").update(readFileSync(download)).digest("hex"),
      );
      assert.ok(existsSync(join(directory, "library/citations/CIT-00-published.pdf")));
      const present = JSON.parse(
        run(root, "citation", "--project", project, "--source", "published", "--json"),
      ) as CitationFixture[];
      assert.equal(required(present[0], "Expected fixture value").present, true);
      assert.equal(required(present[0], "Expected fixture value").state, "acquired");
      assert.deepEqual(JSON.parse(run(root, "citation", "--project", project, "--missing", "--json")), []);
      assert.match(readFileSync(acquisition, "utf8"), /# Attribution comment/);
      writeFileSync(join(directory, "library/citations/CIT-00-published.pdf"), "%PDF-1.7\nmodified\n");
      assert.match(fails(root, "citation", "fetch", "--project", project), /SHA-256/);
      writeFileSync(join(directory, "library/citations/CIT-00-published.pdf"), "%PDF-1.7\nfixture\n");
      run(root, "citation", "fetch", "--project", project);
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
  run(
    root,
    "record",
    "add",
    "experiment",
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
  run(root, "record", "add", "release", specification, ...(subproject ? ["--project", project] : []));
  assert.ok(existsSync(join(directory, "workbench/releases/REL-00.yaml")));
  assert.match(readFileSync(join(directory, "workbench/releases/REL-00.yaml"), "utf8"), /version: 0.1.0/);
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
  assert.equal(run(root, "help", "record"), run(root, "record", "--help"));
  assert.match(run(root, "help", "record"), /add/);
  assert.match(run(root, "help", "citation", "fetch"), /Usage: workbench citation fetch/);
  const complete = run(root, "--help-all");
  assert.match(complete, /COMMAND: workbench citation fetch/);
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
  const expected = {
    Workspace: ["setup", "project", "collection", "language"],
    "Records and context": ["record", "citation", "sync", "feedback"],
    Development: ["development", "shell", "tools", "paths", "release"],
    "Checks and review": [
      "check",
      "pre-commit",
      "pre-push",
      "ci",
      "format",
      "validate",
      "review",
      "docs",
      "secrets",
      "advisories",
    ],
    "Workbench settings": ["config", "skills", "cache", "update", "install", "completion"],
    Help: ["help"],
  };
  assert.deepEqual(Object.entries(commandGroups(short)), Object.entries(expected));
  for (const [path, names] of [
    [["check"], ["matrix"]],
    [["development"], ["use", "images", "prepare", "verify", "publish"]],
    [["citation"], ["add", "fetch", "import"]],
    [["feedback"], ["add", "show", "resolve"]],
    [["language"], ["init", "roots"]],
    [
      ["collection"],
      [
        "install",
        "changes",
        "compare",
        "update",
        "fetch",
        "stage",
        "context",
        "local",
        "compatibility",
        "inspect",
        "export",
        "check-export",
      ],
    ],
  ] as const) {
    const help = run(root, ...path, "--help");
    assert.deepEqual(Object.values(commandGroups(help)).flat(), names);
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
    ) as Pick<import("../src/core.ts").Config, "check_suite" | "check">;
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
