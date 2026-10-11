import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { ciSelection, changedPaths, selectChangedRoots, selectedCIMatrix } from "../src/ci-selection.ts";
import { groupedCIMatrix } from "../src/ci-targets.ts";
import { ciMatrix } from "../src/ci.ts";
import { localCIPlan } from "../src/local-ci.ts";
import { readConfig } from "../src/core.ts";
import * as core from "../src/core.ts";
import * as inputs from "../src/ci-inputs.ts";
import { selectionSummary } from "../scripts/ci-plan.mjs";
import { git, put, commit } from "./fixtures/ci.mjs";

const repository = resolve(import.meta.dirname, "..");
const temporary = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-selection-"));
  temporary.push(root);
  git(root, "init", "--quiet");
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", root);
  put(
    root,
    "workbench/config.toml",
    'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[ci]\noperating_systems=["linux"]\n',
  );
  put(
    root,
    "workbench/projects.toml",
    '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="python"\npath="python"\n[[language_root]]\nlanguage="typescript"\npath="web"\n',
  );
  put(root, "languages/index.toml", 'schema_version=1\nlanguages=["python","typescript"]\n');
  for (const language of ["python", "typescript"])
    put(
      root,
      `languages/${language}/automation.toml`,
      `schema_version=1\n[[command]]\nrole="test"\ncommand=["node","{workbench}/scripts/${language}.mjs"]\n`,
    );
  for (const path of [
    "python/a.py",
    "web/a.ts",
    "scripts/python.mjs",
    "scripts/typescript.mjs",
    "workbench/decisions/ADR-00.md",
    "workbench/tasks/TSK-00.md",
  ])
    put(root, path);
  return { root, base: commit(root) };
}
const selected = (root, base, extra = {}) => ciSelection(root, { affected: true, base, ...extra });
const paths = (selection) => selection.selected.map((entry) => entry.path);

test("ADR, charter, tasks, maps and evidence edits select validation without example roots", () => {
  const { root, base } = fixture();
  for (const path of [
    "workbench/decisions/ADR-00.md",
    "workbench/tasks/TSK-00.md",
    "workbench/CHARTER.md",
    "AGENTS.md",
    "workbench/task-map.md",
    "workbench/record-sequences.toml",
    "workbench/evidence/run.json",
  ])
    put(root, path, "updated\n");
  const result = selected(root, base);
  expect(result.mode).toBe("affected");
  expect(result.selected).toEqual([]);
  expect(result.excluded.map((entry) => entry.path)).toEqual(["python", "web"]);
  expect(selectionSummary(result)).toContain("| python | no |");
  expect(result.changedCount).toBe(7);
  expect(result).not.toHaveProperty("changed");
  expect(selected(root, base, { explainFiles: true }).changed).toContain("AGENTS.md");
});

test("shared collection decisions, maps and registry edits require validation without selecting example jobs", () => {
  const { root, base } = fixture();
  for (const path of [
    "collections/index.toml",
    "collections/benchd/1/workbench/decisions/ADR-00.md",
    "collections/benchd/1/workbench/decision-map.md",
  ])
    put(root, path, "updated\n");
  expect(selected(root, base).selected).toEqual([]);
  expect(selected(root, base).mode).toBe("affected");
});

test("working tree includes staged, unstaged and untracked changes; explicit head uses committed inputs only", () => {
  const { root, base } = fixture();
  put(root, "python/a.py", "staged\n");
  git(root, "add", "python/a.py");
  put(root, "web/a.ts", "unstaged\n");
  put(root, "python/new file.py");
  expect(paths(selected(root, base))).toEqual(["python", "web"]);
  expect(selected(root, base, { explainFiles: true }).changed).toEqual([
    "python/a.py",
    "python/new file.py",
    "web/a.ts",
  ]);
  expect(paths(selected(root, base, { head: base }))).toEqual([]);
  put(root, ".gitignore", "ignored\n");
  commit(root);
  put(root, "ignored");
  expect(ciSelection(root, { base: "HEAD", explainFiles: true }).changed).toEqual([]);
});

test("language definitions, adapters and local replacements select their actual dependents", () => {
  const { root, base } = fixture();
  put(root, "scripts/python.mjs", "changed\n");
  expect(paths(selected(root, base))).toEqual(["python"]);
  put(root, "languages/typescript/filter.json");
  expect(paths(selected(root, base))).toEqual(["python", "web"]);
  put(
    root,
    "workbench/languages/python/automation.toml",
    'schema_version=1\n[[command]]\nrole="test"\ncommand=["echo","local"]\n',
  );
  const replaced = commit(root);
  put(root, "languages/python/filter.json");
  expect(selected(root, replaced).selected).toEqual([]);
  rmSync(join(root, "languages/python/filter.json"));
  put(root, "workbench/languages/python/filter.json");
  expect(paths(selected(root, replaced))).toEqual(["python"]);
  rmSync(join(root, "workbench/languages/python"), { recursive: true });
  expect(paths(selected(root, replaced))).toEqual(["python"]);
});

test("shared and unclassified inputs select all roots; documentation does not mask executable changes", () => {
  const { root, base } = fixture();
  put(root, "src/main.ts");
  put(root, "README.md");
  const result = selected(root, base);
  expect(paths(result)).toEqual(["python", "web"]);
  expect(
    result.selected.every((entry) =>
      entry.reasons.some((reason) => reason === "shared or unclassified input (1 changed file)"),
    ),
  ).toBe(true);
});

test("declarative dependencies augment ownership and are validated against registered roots", () => {
  const { root } = fixture();
  put(
    root,
    "workbench/config.toml",
    readFileSync(join(root, "workbench/config.toml"), "utf8") +
      '\n[[ci.dependencies]]\npaths=["shared/data", "web/shared.ts"]\nroots=["python"]\n',
  );
  const base = commit(root);
  put(root, "shared/data/input.json");
  expect(paths(selected(root, base))).toEqual(["python"]);
  put(root, "web/shared.ts");
  expect(paths(selected(root, base))).toEqual(["python", "web"]);
  const previous = {
    roots: ["python", "web"],
    dependencies: [{ path: "removed/input", roots: ["python"], source: "old declaration" }],
    documentation: [],
  };
  expect(selectChangedRoots({ ...previous, dependencies: [] }, previous, ["removed/input"]).selected).toEqual([
    { path: "python", reasons: ["old declaration: removed/input (1 changed file)"] },
  ]);
  for (const value of [
    'paths=[]\nroots=["python"]',
    'paths=["../escape"]\nroots=["python"]',
    'paths=["x"]\nroots=[]',
    'paths=["x"]\nroots=["python"]\nunknown=true',
  ]) {
    put(
      root,
      "workbench/config.toml",
      `schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[[ci.dependencies]]\n${value}\n`,
    );
    expect(() => readConfig(root)).toThrow();
  }
});

test("cross-root renames and deletions retain both owners with NUL-safe parsing", () => {
  const { root, base } = fixture();
  renameSync(join(root, "python/a.py"), join(root, "web/moved.py"));
  const head = commit(root);
  expect(paths(selected(root, base, { head }))).toEqual(["python", "web"]);
  rmSync(join(root, "web/a.ts"));
  expect(paths(selected(root, head))).toEqual(["web"]);
  expect(changedPaths("R100\0python/old file\0web/new file\0T\0web/link\0")).toEqual([
    "python/old file",
    "web/link",
    "web/new file",
  ]);
  for (const output of ["A\0unterminated", "R100\0old\0", "?\0file\0", "M\0../bad\0"])
    expect(() => changedPaths(output)).toThrow();
});

test("PR comparisons use merge base; pushes compare exact revisions including non-ancestor force pushes", () => {
  const { root, base } = fixture();
  git(root, "checkout", "--quiet", "-b", "feature");
  put(root, "python/a.py", "feature\n");
  const feature = commit(root);
  git(root, "checkout", "--quiet", "-b", "other", base);
  put(root, "web/a.ts", "base advanced\n");
  const advanced = commit(root);
  git(root, "checkout", "--quiet", "feature");
  expect(paths(selected(root, advanced, { head: feature, mergeBase: true }))).toEqual(["python"]);
  expect(paths(selected(root, advanced, { head: feature }))).toEqual(["python", "web"]);
  git(
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "merge",
    "--quiet",
    "--no-edit",
    "other",
  );
  expect(paths(selected(root, advanced, { head: "HEAD" }))).toEqual(["python"]);
});

test("new roots and uncertain history/configuration use safe selections, while explicit full ignores the diff", () => {
  const { root, base } = fixture();
  for (const options of [{ affected: true }, { base: "0".repeat(40) }, { base: "missing" }]) {
    const result = ciSelection(root, options);
    expect(result.mode).toBe("fallback");
    expect(paths(result)).toEqual(["python", "web"]);
  }
  const full = ciSelection(root, { full: true });
  expect(full.mode).toBe("full");
  expect(full.changedCount).toBeNull();
  expect(() => ciSelection(root, { full: true, base })).toThrow(/cannot be combined/);
  expect(() => ciSelection(root, { head: base })).toThrow(/requires/);
  expect(() => ciSelection(root, { mergeBase: true })).toThrow(/requires/);
  put(
    root,
    "workbench/projects.toml",
    readFileSync(join(root, "workbench/projects.toml"), "utf8") +
      '\n[[language_root]]\nlanguage="python"\npath="new-root"\n',
  );
  put(root, "new-root/README.md");
  expect(paths(selected(root, base))).toContain("new-root");
  expect(selected(root, base, { head: base }).mode).toBe("fallback");
  put(
    root,
    "workbench/projects.toml",
    '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="python"\npath="python"\n[[language_root]]\nlanguage="typescript"\npath="web"\n',
  );
  put(root, "languages/python/automation.toml", "invalid[");
  expect(selected(root, base).mode).toBe("fallback");
});

test("selection precedes grouping and preserves every selected matrix target", () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", repository);
  const matrix = ciMatrix(repository);
  const selection = { selected: [{ path: "examples/languages/python", reasons: [] }] };
  const filtered = selectedCIMatrix(matrix, selection);
  for (const name of ["native", "compatibility", "environments"])
    expect(filtered[name].include).toEqual(
      matrix[name].include.filter((entry) => entry.path === "examples/languages/python"),
    );
  expect(filtered.devcontainer.paths).toEqual(["examples/languages/python"]);
  const grouped = groupedCIMatrix(filtered);
  for (const name of ["native", "compatibility", "environments"])
    expect(grouped[name].include.every((entry) => entry.paths.join() === "examples/languages/python")).toBe(true);
  const empty = groupedCIMatrix(selectedCIMatrix(matrix, { selected: [] }));
  expect(empty.native.include).toEqual([]);
  expect(empty.compatibility.include).toEqual([]);
  expect(empty.environments.include).toEqual([]);
  expect(empty.devcontainer.paths).toEqual([]);
  const plan = localCIPlan(repository, { full: true });
  expect(plan.selected.every((entry) => entry.os === "linux" && entry.architecture === "x64")).toBe(true);
});

test("pinned distribution submodules provide historical language definitions without fetching", () => {
  const { root } = fixture();
  const distribution = join(root, ".workbench");
  mkdirSync(distribution);
  cpSync(join(root, "languages"), join(distribution, "languages"), { recursive: true });
  rmSync(join(root, "languages"), { recursive: true });
  git(distribution, "init", "--quiet");
  commit(distribution);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const base = commit(root);
  put(root, "python/a.py", "changed\n");
  const result = selected(root, base);
  expect(result.mode).toBe("affected");
  expect(paths(result)).toEqual(["python"]);
  put(distribution, "languages/python/filter.json");
  commit(distribution);
  expect(paths(selected(root, base))).toEqual(["python", "web"]);
});

test("large comparisons retain affected selection and expose filenames only on request", () => {
  const { root, base } = fixture();
  for (let i = 0; i < 3000; i++) put(root, `python/${"long-directory-name-".repeat(5)}file-${i}.py`);
  const compact = selected(root, base);
  expect(compact.mode).toBe("affected");
  expect(compact.changedCount).toBe(3000);
  expect(compact).not.toHaveProperty("changed");
  expect(compact.selected).toEqual([{ path: "python", reasons: ["root input (3000 changed files)"] }]);
  expect(JSON.stringify(compact).length).toBeLessThan(1024);
  const detailed = selected(root, base, { explainFiles: true });
  expect(Buffer.byteLength(JSON.stringify(detailed))).toBeGreaterThan(256 * 1024);
  expect(detailed.mode).toBe("affected");
  expect(paths(detailed)).toEqual(paths(compact));
  expect(detailed.changed).toHaveLength(3000);
  expect(detailed.selected[0].matches[0].files).toEqual(detailed.changed);
});

test("historical configuration and automation use the current semantic validation rules", () => {
  const { root } = fixture();
  const path = "workbench/config.toml";
  const config = readFileSync(join(root, path), "utf8");
  put(root, path, config.replace("wrap_width=120", "wrap_width=0"));
  const badConfig = commit(root);
  expect(() => readConfig(root)).toThrow(/wrap_width/);
  put(root, path, config);
  const current = commit(root);
  const result = selected(root, badConfig, { head: current });
  expect(result.mode).toBe("fallback");
  expect(result.reason).toContain("wrap_width");
  expect(result.failure).toMatchObject({ kind: "input", operation: `read declarations at ${badConfig}` });
  expect(paths(result)).toEqual(["python", "web"]);

  const automation = "languages/python/automation.toml";
  const valid = readFileSync(join(root, automation), "utf8");
  put(root, automation, valid.replace('role="test"', 'role="clean"'));
  const badAutomation = commit(root);
  put(root, automation, valid);
  const restored = commit(root);
  const invalid = selected(root, badAutomation, { head: restored });
  expect(invalid.mode).toBe("fallback");
  expect(invalid.reason).toContain("manual-only");
});

test("comparison fallback retains operation and cause while unexpected acquisition and policy errors fail visibly", () => {
  const { root, base } = fixture();
  const missing = selected(root, "missing-revision");
  expect(missing.failure).toMatchObject({ kind: "history", operation: "git rev-parse" });
  expect(missing.reason).toContain("history: git rev-parse");
  put(root, "languages/python/automation.toml", "invalid[");
  let failure;
  try {
    inputs.ciInputs(root);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(inputs.ComparisonUnavailable);
  expect(failure.cause).toBeInstanceOf(Error);
  expect(failure.failure.kind).toBe("input");
  const runtimeError = new TypeError("declaration parser implementation failed");
  vi.spyOn(core, "configFromData").mockImplementationOnce(() => {
    throw runtimeError;
  });
  expect(() => selected(root, base)).toThrow(runtimeError);
  const plainError = new Error("unexpected parser implementation failure");
  vi.spyOn(core, "configFromData").mockImplementationOnce(() => {
    throw plainError;
  });
  expect(() => selected(root, base)).toThrow(plainError);
  const unexpected = new Error("unexpected comparison implementation failure");
  vi.spyOn(inputs, "ciInputs").mockImplementationOnce(() => {
    throw unexpected;
  });
  expect(() => selected(root, base)).toThrow(unexpected);
  vi.spyOn(inputs, "ciInputs").mockReturnValueOnce({ roots: ["python", "web"], dependencies: null, documentation: [] });
  expect(() => selected(root, base)).toThrow(TypeError);
});
