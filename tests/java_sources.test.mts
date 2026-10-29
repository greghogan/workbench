import { afterEach, expect, test } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJavaSources, publishJavaFormatting, snapshotJavaSources } from "../scripts/java-sources.mjs";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-java-format-"));
  temporary.push(root);
  const source = join(root, "source"),
    stage = join(root, "stage");
  mkdirSync(join(source, "nested"), { recursive: true });
  writeFileSync(join(source, "Changed.java"), "class Changed {}\r\n");
  writeFileSync(join(source, "nested/Other.java"), "class Other {}\n");
  writeFileSync(join(source, "config.json"), "original resource\n");
  const before = snapshotJavaSources(source);
  cpSync(source, stage, { recursive: true });
  canonicalJavaSources(stage, true);
  return { root, source, stage, before };
}

test("formatting publishes changed Java files while preserving unrelated concurrent edits and additions", () => {
  const f = fixture();
  writeFileSync(join(f.source, "nested/Other.java"), "class Other { /* concurrent test */ }\n");
  writeFileSync(join(f.source, "New.java"), "class New {}\n");
  writeFileSync(join(f.source, "config.json"), "concurrent resource\n");
  publishJavaFormatting(f.source, f.stage, f.before);
  expect(readFileSync(join(f.source, "Changed.java"), "utf8")).toBe("class Changed {}\n");
  expect(readFileSync(join(f.source, "nested/Other.java"), "utf8")).toContain("concurrent test");
  expect(readFileSync(join(f.source, "New.java"), "utf8")).toBe("class New {}\n");
  expect(readFileSync(join(f.source, "config.json"), "utf8")).toBe("concurrent resource\n");
});

test.each(["edit", "delete"])(
  "a concurrent %s to a formatted file rejects writeback before publishing other files",
  (change) => {
    const f = fixture();
    writeFileSync(join(f.stage, "nested/Other.java"), "class Other { /* formatted */ }\n");
    const destination = join(f.source, "nested/Other.java");
    if (change === "edit") writeFileSync(destination, "class Other { /* concurrent */ }\n");
    else rmSync(destination);
    expect(() => {
      publishJavaFormatting(f.source, f.stage, f.before);
    }).toThrow(/source changed during formatting/);
    expect(readFileSync(join(f.source, "Changed.java"), "utf8")).toBe("class Changed {}\r\n");
    if (change === "edit") expect(readFileSync(destination, "utf8")).toContain("concurrent");
    else expect(() => readFileSync(destination)).toThrow();
  },
);

test("unexpected formatter file creation or deletion preserves the original source inventory", () => {
  const f = fixture();
  rmSync(join(f.stage, "Changed.java"));
  writeFileSync(join(f.stage, "Replacement.java"), "class Replacement {}\n");
  expect(() => {
    publishJavaFormatting(f.source, f.stage, f.before);
  }).toThrow(/source inventory/);
  expect(readFileSync(join(f.source, "Changed.java"), "utf8")).toBe("class Changed {}\r\n");
});

test("formatting rejects linked input trees and a destination directory replaced by a link", () => {
  const f = fixture();
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "Other.java"), "class Other { /* protected */ }\n");
  writeFileSync(join(f.stage, "nested/Other.java"), "class Other { /* formatted */ }\n");
  rmSync(join(f.source, "nested"), { recursive: true });
  symlinkSync(outside, join(f.source, "nested"), process.platform === "win32" ? "junction" : "dir");
  expect(() => snapshotJavaSources(f.source)).toThrow(/symbolic links/);
  expect(() => {
    publishJavaFormatting(f.source, f.stage, f.before);
  }).toThrow(/source changed during formatting/);
  expect(readFileSync(join(outside, "Other.java"), "utf8")).toContain("protected");
  expect(readFileSync(join(f.source, "Changed.java"), "utf8")).toBe("class Changed {}\r\n");
});
