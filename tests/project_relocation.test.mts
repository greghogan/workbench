import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { registerConsumingProject, relocateConsumingProject } from "../src/project-registration.ts";
import { registeredProjects } from "../src/project-registry.ts";
import { recordTaskImplementation, taskImplementationPath } from "../src/task-implementations.ts";
import { readTaskGraph } from "../src/task-model.ts";
import { git } from "./fixtures/adoption.mjs";
import { webFixture } from "./fixtures/web.mjs";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each(["conflicting destination", "unrelated repository"])(
  "relocation refuses %s evidence without changing registration or either catalogue",
  async (failure) => {
    const root = webFixture(),
      state = mkdtempSync(join(tmpdir(), "workbench-relocation-")),
      moved = root + "-moved";
    roots.push(root, moved, state);
    vi.stubEnv("WORKBENCH_STATE_HOME", state);
    mkdirSync(join(root, "workbench/tasks"));
    writeFileSync(
      join(root, "workbench/tasks/TSK-00.md"),
      "---\nstatus: Approved\n---\n\n# TSK-0: Deliver work\n\n## Overview\n\nDeliver useful behavior.\n",
    );
    git(root, "add", ".");
    git(root, "commit", "-qm", "Approved plan");
    await registerConsumingProject(root);
    recordTaskImplementation(root, readTaskGraph(root).require("demo:TSK-0"), "Verified behavior.");
    const source = taskImplementationPath(root);
    if (!source) throw new Error("Missing evidence catalogue");
    const catalogue = JSON.parse(readFileSync(source, "utf8")) as {
      version: 1;
      entries: { evidence: string; tree: string }[];
    };
    renameSync(root, moved);
    const destination = taskImplementationPath(moved);
    if (!destination || !catalogue.entries[0]) throw new Error("Missing moved evidence catalogue");
    if (failure === "conflicting destination") catalogue.entries[0].evidence = "Independent destination verification.";
    else catalogue.entries[0].tree = "f".repeat(40);
    writeFileSync(failure === "conflicting destination" ? destination : source, JSON.stringify(catalogue));
    const original = readFileSync(source, "utf8"),
      before = registeredProjects();
    const existing = failure === "conflicting destination" ? readFileSync(destination, "utf8") : undefined;
    await expect(relocateConsumingProject(root, moved)).rejects.toThrow(
      failure === "conflicting destination" ? /Conflicting implementation/ : /does not contain/,
    );
    expect(registeredProjects()).toEqual(before);
    expect(readFileSync(source, "utf8")).toBe(original);
    if (existing !== undefined) expect(readFileSync(destination, "utf8")).toBe(existing);
  },
);
