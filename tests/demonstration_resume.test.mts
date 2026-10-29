import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createDemonstration } from "../src/demonstration.ts";
import { readTaskQueue } from "../src/task-queue.ts";
import { distribution } from "./fixtures/adoption.mjs";

test("reopening an owned demonstration resumes its edits and queue instead of reseeding it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-demo-resume-"));
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", "");
  let demo: Awaited<ReturnType<typeof createDemonstration>> | undefined;
  try {
    demo = await createDemonstration(distribution, directory);
    const path = join(demo.root, "workbench/decisions/ADR-00.md"),
      queue = readTaskQueue(demo.root);
    const contents = readFileSync(path, "utf8") + "\nRetain this human edit.\n";
    writeFileSync(path, contents);
    const defaults = demo.collectionDefaults;
    await demo.close();
    demo = await createDemonstration(distribution, directory);
    expect(readFileSync(path, "utf8")).toBe(contents);
    expect(readTaskQueue(demo.root)).toEqual(queue);
    expect(demo.collectionDefaults).toEqual(defaults);
  } finally {
    await demo?.close();
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
