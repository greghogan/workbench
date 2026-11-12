import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { InputWatch } from "../../../src/server/workspace/input-watch.ts";

test("input reconciliation follows atomic replacements, discovers missing parents and ignores unrelated writes", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-input-watch-"));
  const path = join(root, "new", "receipt.json"),
    changes: string[][] = [];
  const watch = new InputWatch((paths) => {
    changes.push(paths);
  });
  try {
    watch.update([path]);
    writeFileSync(join(root, "unrelated"), "unrelated");
    watch.reconcile();
    expect(changes).toEqual([]);
    mkdirSync(join(root, "new"));
    writeFileSync(path, "first");
    watch.reconcile();
    expect(changes).toEqual([[path]]);
    writeFileSync(join(root, "new", "replacement"), "second");
    renameSync(join(root, "new", "replacement"), path);
    watch.reconcile();
    expect(changes).toEqual([[path], [path]]);
    renameSync(join(root, "new"), join(root, "old"));
    mkdirSync(join(root, "new"));
    writeFileSync(path, "third");
    watch.reconcile();
    expect(changes).toHaveLength(3);
    watch.close();
    writeFileSync(path, "fourth");
    watch.reconcile();
    expect(changes).toHaveLength(3);
  } finally {
    watch.close();
    rmSync(root, { recursive: true, force: true });
  }
});
