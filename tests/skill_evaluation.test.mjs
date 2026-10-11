import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, devNull } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { grade, prepare, write } from "../scripts/skill-evaluation-cases.mjs";

test("evaluation rejects unchanged defects and advisory edits, then accepts corrected behavior", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-evaluation-grader-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
  try {
    const before = prepare(root, resolve(import.meta.dirname, ".."), env, "review");
    grade(root, env, "refactors", before);
    assert.throws(() => grade(root, env, "review", before));
    write(
      root,
      "basket.mjs",
      "export function total(items, discounted = false) { return items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0) * (discounted ? 0.9 : 1); }\n",
    );
    assert.throws(() => grade(root, env, "refactors", before), /advisory request changed project files/);
    grade(root, env, "review", before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
