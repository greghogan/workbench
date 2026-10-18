import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { grade, prepare, write } from "../scripts/skill-evaluation-cases.mjs";

test("evaluation rejects unchanged defects and advisory edits, then accepts corrected behavior", () => {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-evaluation-grader-"));
  const root = join(temporary, "project");
  mkdirSync(root);
  const env = {
    ...process.env,
    WORKBENCH_CONFIG_HOME: join(temporary, "user"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  try {
    const before = prepare(root, resolve(import.meta.dirname, ".."), env, "review");
    assert.ok(existsSync(join(env.WORKBENCH_CONFIG_HOME, "config.toml")));
    assert.ok(!existsSync(join(root, ".workbench-evaluation-config")));
    grade(root, env, "refactors", before);
    assert.throws(() => {
      grade(root, env, "review", before);
    });
    write(
      root,
      "basket.mjs",
      "export function total(items, discounted = false) { return items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0) * (discounted ? 0.9 : 1); }\n",
    );
    assert.throws(() => {
      grade(root, env, "refactors", before);
    }, /advisory request changed project files/);
    grade(root, env, "review", before);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
