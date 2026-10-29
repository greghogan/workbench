import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { canonicalJavaSources } from "../scripts/java-sources.mjs";

const temporary: string[] = [];
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "workbench-java-sources-"));
  temporary.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Java newline checks reject noncanonical sources without changing any file", () => {
  const files = {
    "main/java/Count.java": "class Count {}\n",
    "test/java/CountTest.java": "class CountTest {}\r\n",
    "nested package/Legacy.java": "class Legacy {}\r",
    "notes.txt": "leave this resource alone\r\n",
  };
  const root = fixture(files);
  expect(() => {
    canonicalJavaSources(root);
  }).toThrow(/\.java: Java sources require LF.*format-write/);
  for (const [path, contents] of Object.entries(files)) expect(readFileSync(join(root, path), "utf8")).toBe(contents);
});

test("explicit Java formatting normalizes source newlines while preserving content and other resources", () => {
  const root = fixture({
    "main/java/Count.java": '// π\r\nclass Count { String value = "\\r\\n"; }\r\n',
    "test/java/CountTest.java": "class CountTest {}\r",
    "notes.txt": "preserved\r\n",
  });
  canonicalJavaSources(root, true);
  expect(readFileSync(join(root, "main/java/Count.java"), "utf8")).toBe(
    '// π\nclass Count { String value = "\\r\\n"; }\n',
  );
  expect(readFileSync(join(root, "test/java/CountTest.java"), "utf8")).toBe("class CountTest {}\n");
  expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("preserved\r\n");
  expect(() => {
    canonicalJavaSources(root);
  }).not.toThrow();
});

test("already canonical Java files retain their contents and filesystem timestamps", () => {
  const root = fixture({ "Count.java": "class Count {}\n" });
  const path = join(root, "Count.java");
  const timestamp = new Date("2000-01-01T00:00:00Z");
  utimesSync(path, timestamp, timestamp);
  const before = statSync(path, { bigint: true }).mtimeNs;
  canonicalJavaSources(root);
  canonicalJavaSources(root, true);
  expect(statSync(path, { bigint: true }).mtimeNs).toBe(before);
  expect(readFileSync(path, "utf8")).toBe("class Count {}\n");
});
