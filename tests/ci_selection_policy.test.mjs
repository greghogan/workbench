import { expect, test } from "vitest";
import { selectChangedRoots } from "../src/ci-selection.ts";

test("dependencies propagate through affected roots, retaining removed edges and terminating cycles", () => {
  const previous = {
    roots: ["library", "service", "web"],
    documentation: [],
    dependencies: [
      { path: "languages/python", roots: ["library"], source: "language definition" },
      { path: "library/schema", roots: ["service"], source: "service input" },
      { path: "service/api", roots: ["web"], source: "web input" },
      { path: "web/client", roots: ["library"], source: "cyclic input" },
    ],
  };
  const current = { ...previous, dependencies: previous.dependencies.slice(0, 1) };
  const result = selectChangedRoots(current, previous, ["languages/python/automation.toml"]);
  expect(result.selected.map((entry) => entry.path)).toEqual(["library", "service", "web"]);
  expect(result.selected.find((entry) => entry.path === "web").reasons).toEqual([
    "service: affected root dependency (web input: service/api)",
  ]);
  expect(selectChangedRoots(current, previous, ["README.md"]).selected).toEqual([]);
});

test("all immediate dependency causes survive fanout, existing selections, duplicate declarations and cycles", () => {
  const input = {
    roots: ["library", "service", "web", "unused"],
    documentation: [],
    dependencies: [
      { path: "shared/schema", roots: ["library", "service"], source: "schema input" },
      { path: "library/api", roots: ["service"], source: "service input" },
      { path: "library/models", roots: ["service"], source: "service input" },
      { path: "service/api", roots: ["web"], source: "web input" },
      { path: "web/client", roots: ["library"], source: "cyclic input" },
      { path: "library/own", roots: ["library"], source: "own input" },
    ],
  };
  const changes = ["shared/schema/b.json", "web/a.ts", "shared/schema/a.json", "shared/schema/a.json"];
  const result = selectChangedRoots(input, input, changes, true);
  const byRoot = (result) => Object.fromEntries(result.selected.map((entry) => [entry.path, entry]));
  expect(byRoot(result).service).toEqual({
    path: "service",
    reasons: [
      "library: affected root dependency (service input: library/api)",
      "library: affected root dependency (service input: library/models)",
      "schema input: shared/schema (2 changed files)",
    ],
    matches: [
      {
        reason: "schema input: shared/schema (2 changed files)",
        files: ["shared/schema/a.json", "shared/schema/b.json"],
      },
    ],
  });
  expect(byRoot(result).web.reasons).toEqual([
    "root input (1 changed file)",
    "service: affected root dependency (web input: service/api)",
  ]);
  expect(byRoot(result).library.reasons).toEqual([
    "schema input: shared/schema (2 changed files)",
    "web: affected root dependency (cyclic input: web/client)",
  ]);
  expect(result.excluded).toEqual([{ path: "unused", reason: "no changed inputs or dependencies" }]);
  const reversed = { ...input, roots: [...input.roots].reverse(), dependencies: [...input.dependencies].reverse() };
  expect(byRoot(selectChangedRoots(reversed, reversed, [...changes].reverse(), true))).toEqual(byRoot(result));
  expect(selectChangedRoots(input, input, changes).selected).toEqual(
    result.selected.map(({ path, reasons }) => ({ path, reasons })),
  );
});

test("large changes roll up by root and dependency without expanding the selected matrix", () => {
  const input = {
    roots: ["python", "web"],
    dependencies: [{ path: "shared/data", roots: ["python"], source: "schema input" }],
    documentation: ["workbench/decisions"],
  };
  const changed = Array.from({ length: 10000 }, (_, i) => `python/very-long-subdirectory-name/file-${i}.py`);
  changed.push("shared/data/a.json", "shared/data/b.json");
  const compact = selectChangedRoots(input, input, changed);
  expect(compact.selected).toEqual([
    { path: "python", reasons: ["root input (10000 changed files)", "schema input: shared/data (2 changed files)"] },
  ]);
  expect(JSON.stringify(compact).length).toBeLessThan(1024);
  const detailed = selectChangedRoots(input, input, changed, true);
  expect(detailed.selected.map((entry) => ({ path: entry.path, reasons: entry.reasons }))).toEqual(compact.selected);
  expect(detailed.selected[0].matches.find((entry) => entry.reason.startsWith("root input")).files).toHaveLength(10000);
  expect(
    selectChangedRoots(
      input,
      input,
      changed.map((path) => `workbench/decisions/${path}.md`),
    ).selected,
  ).toEqual([]);
});
