import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sourceMapErrors } from "../src/source-maps.ts";
import { stageFile } from "../scripts/file-publication.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(files: Record<string, string>) {
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

test("unpublished atomic candidates do not become source-map inputs", () => {
  const root = fixture({ "map.md": "- `src/main.ts`: source.\n", "src/main.ts": "export {};\n" });
  const candidate = stageFile(join(root, "src/main.ts"), "not published yet");
  try {
    expect(sourceMapErrors(root, "map.md", ["src"])).toEqual([]);
  } finally {
    candidate.discard();
  }
});

test.each([
  ["mts", "mjs", ""],
  ["cts", "cjs", "#!/usr/bin/env node\n"],
])("mapped %s source covers an optional generated %s helper", (source, output, shebang) => {
  const root = fixture({
    "map.md": `- \`scripts/helper.${source}\`: owns the helper.\n`,
    [`scripts/helper.${source}`]: "export const value: number = 42;\n",
  });
  expect(sourceMapErrors(root, "map.md", ["scripts"])).toEqual([]);
  writeFileSync(
    join(root, `scripts/helper.${output}`),
    `${shebang}// Generated from helper.${source}; edit the TypeScript source.\nexport const value = 42;\n`,
  );
  expect(sourceMapErrors(root, "map.md", ["scripts"])).toEqual([]);
});

test("an unmapped source or handwritten JavaScript still needs its own source-map entry", () => {
  const root = fixture({
    "map.md": "- `scripts/handwritten.mts`: typed helper.\n",
    "scripts/handwritten.mts": "export const value = 42;\n",
    "scripts/handwritten.mjs": "export const independentlyAuthored = true;\n",
    "scripts/unmapped.mts": "export const missing = true;\n",
    "scripts/unmapped.mjs":
      "// Generated from unmapped.mts; edit the TypeScript source.\nexport const missing = true;\n",
  });
  expect(sourceMapErrors(root, "map.md", ["scripts"])).toEqual([
    `${join(root, "map.md")}: source map does not cover 'scripts/handwritten.mjs'`,
    `${join(root, "map.md")}: source map does not cover 'scripts/unmapped.mjs'`,
    `${join(root, "map.md")}: source map does not cover 'scripts/unmapped.mts'`,
  ]);
});

test("an explicit generated-file entry must exist and a mismatched generated-source marker does not provide coverage", () => {
  const root = fixture({
    "map.md": "- `scripts/helper.mts`: typed helper.\n- `scripts/missing.mjs`: missing emission.\n",
    "scripts/helper.mts": "export const value = 42;\n",
    "scripts/helper.mjs": "// Generated from another.mts; edit the TypeScript source.\nexport const value = 42;\n",
  });
  expect(sourceMapErrors(root, "map.md", ["scripts"])).toEqual([
    `${join(root, "map.md")}: source map references missing path 'scripts/missing.mjs'`,
    `${join(root, "map.md")}: source map does not cover 'scripts/helper.mjs'`,
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
