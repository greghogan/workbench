import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sourceMapErrors } from "../src/source-maps.ts";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "workbench-source-maps-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

test("an architectural index links to tables and lists without interpreting prose code as paths", () => {
  const root = fixture({
    "workbench/source-map.md":
      "# Architecture\n\n- [Storage](maps/storage.md): durable state.\n- [Commands](maps/commands.md): user entry points.\n",
    "workbench/maps/storage.md":
      "| Path | Responsibility |\n| --- | --- |\n| `src/storage` | Owns persistence and calls `flush()`. |\n| `src/storage/store.ts` | Commits durable state. |\n",
    "workbench/maps/commands.md":
      "- `src/main.ts` selects commands using `parse()`.\n\n```md\n- `not-a-path` is an illustration.\n```\n",
    "src/storage/store.ts": "",
    "src/storage/recovery.ts": "",
    "src/main.ts": "",
  });
  expect(sourceMapErrors(root, "workbench/source-map.md", ["src"])).toEqual([]);
});

test("renames expose both stale references and newly uncovered source files", () => {
  const root = fixture({ "map.md": "- `src/old.ts`: old location.\n", "src/new.ts": "" });
  expect(sourceMapErrors(root, "map.md", ["src"])).toEqual([
    `${join(root, "map.md")}: source map references missing path 'src/old.ts'`,
    `${join(root, "map.md")}: source map does not cover 'src/new.ts'`,
  ]);
});

test("duplicate entries report both map locations, while repeated navigation links are harmless", () => {
  const root = fixture({
    "map.md": "- [A](a.md)\n- [A again](a.md)\n- [B](b.md)\n",
    "a.md": "- `src/one.ts`: owns persistence.\n",
    "b.md": "| `src/one.ts` | owns commands. |\n",
    "src/one.ts": "",
  });
  const errors = sourceMapErrors(root, "map.md", ["src"]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("duplicate source-map entry 'src/one.ts'");
  expect(errors[0]).toContain(`${join(root, "a.md")}:1`);
  expect(errors[0]).toContain(`${join(root, "b.md")}:1`);
});

test("explicit directory exclusions preserve coverage of neighboring files", () => {
  const root = fixture({
    "map.md": "- `src/main.ts`: commands.\n",
    "src/main.ts": "",
    "src/generated/parser.ts": "",
    "src/other.ts": "",
  });
  expect(sourceMapErrors(root, "map.md", ["src"], ["src/generated"])).toEqual([
    `${join(root, "map.md")}: source map does not cover 'src/other.ts'`,
  ]);
});

test("missing map links and navigation cycles are errors", () => {
  const root = fixture({
    "map.md": "- [A](a.md)\n- [Missing](missing.md)\n",
    "a.md": "- [Back](map.md)\n- `src`: source.\n",
    "src/one.ts": "",
  });
  const errors = sourceMapErrors(root, "map.md", ["src"]);
  expect(errors).toHaveLength(2);
  expect(errors[0]).toContain("source-map link cycle");
  expect(errors[1]).toContain("missing.md: configured source map is missing");
});

test("source and map references cannot traverse outside the project", () => {
  const root = fixture({
    "map.md": "- `../outside`: unsafe.\n- [Outside](../outside.md)\n- `src`: source.\n",
    "src/one.ts": "",
  });
  const errors = sourceMapErrors(root, "map.md", ["src"]);
  expect(errors).toHaveLength(2);
  expect(errors[0]).toContain("unsafe relative path");
  expect(errors[1]).toContain("escapes the project");
});

test("linked maps and mapped source paths reject symbolic-link redirection", () => {
  const root = fixture({
    "map.md": "- [Alias](alias/map.md)\n- `alias/code.ts`: source.\n",
    "actual/map.md": "",
    "actual/code.ts": "",
  });
  symlinkSync(join(root, "actual"), join(root, "alias"), "junction");
  const errors = sourceMapErrors(root, "map.md", ["actual"]);
  expect(errors.filter((error) => error.includes("symlinks are not supported"))).toHaveLength(2);
});
