import { registerConsumingProject, relocateConsumingProject } from "../../../src/core/projects/project-registration.ts";
import { projectIdentity } from "../../../src/core/projects/project-registry.ts";
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToString } from "preact-render-to-string";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { registerTaskCommands } from "../../../src/cli/tasks.ts";
import {
  attachTaskImplementations,
  recordTaskImplementation,
  taskImplementationPath,
} from "../../../src/core/tasks/task-implementations.ts";
import { readTaskGraph } from "../../../src/core/tasks/task-model.ts";
import { changeTaskQueue, inspectTaskQueue, readTaskQueue, TaskReadiness } from "../../../src/core/tasks/task-queue.ts";
import { changeTaskStatus } from "../../../src/core/tasks/task-service.ts";
import { readTaskDecisions } from "../../../src/core/tasks/task-decisions.ts";
import { WorkspaceCollector, WorkspaceIndex } from "../../../src/server/workspace/workspace-service.ts";
import { taskControls } from "../../../src/server/views/task-pages.tsx";
import { git } from "../../fixtures/adoption.mjs";
import { workPage } from "../../../src/server/views/workflow-pages.tsx";
import { reviewsPage } from "../../../src/server/views/review-list.tsx";
import { parseDOM } from "../../fixtures/dom.mjs";
import { webFixture } from "../../fixtures/web.mjs";

const roots: string[] = [];
let root: string, initial: string;
beforeEach(() => {
  root = webFixture();
  roots.push(root);
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/local-state"));
  mkdirSync(join(root, "workbench/tasks"));
  for (const number of [0, 1, 2])
    writeFileSync(
      join(root, `workbench/tasks/TSK-0${String(number)}.md`),
      `---\nstatus: Approved\n${number === 1 ? "depends_on: [demo:TSK-0]\n" : ""}---\n\n# TSK-${String(number)}: Work ${String(number)}\n\n## Overview\n\nDeliver useful behavior.\n\n## Details\n\n- [x] Verify the outcome.\n`,
    );
  git(root, "add", ".");
  git(root, "commit", "-qm", "Approved plans");
  initial = git(root, "rev-parse", "HEAD");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of roots.splice(0).reverse()) rmSync(path, { recursive: true, force: true });
});
function worktree(commit: string): string {
  const path = mkdtempSync(join(tmpdir(), "workbench-task-worktree-"));
  roots.push(path);
  git(root, "worktree", "add", "--detach", path, commit);
  return path;
}
function implement(): string {
  writeFileSync(join(root, "implementation.txt"), "The verified implementation.\n");
  changeTaskQueue(root, { action: "add", references: ["TSK-0", "TSK-2"] });
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Integration tests passed." });
  changeTaskQueue(root, { action: "start", reference: "TSK-2" });
  git(root, "add", ".");
  git(root, "commit", "-qm", "Verified prerequisite implementation");
  return git(root, "rev-parse", "HEAD");
}

test("worktrees share human decisions and historical implementation without copying execution queues", () => {
  const config = join(root, "workbench/config.toml");
  writeFileSync(config, readFileSync(config, "utf8") + "\n[review]\ntask_approvals=true\n");
  changeTaskStatus(root, "TSK-0", "Approved", undefined, true);
  expect(readTaskDecisions(root)).toHaveLength(1);
  const baseline = implement(),
    checkout = worktree(baseline);
  expect(taskImplementationPath(checkout)).toBe(taskImplementationPath(root));
  expect(readTaskQueue(checkout).entries).toEqual([]);
  expect(readTaskDecisions(checkout)).toEqual(readTaskDecisions(root));
  changeTaskQueue(checkout, { action: "add", references: ["TSK-2", "TSK-1"] });
  const selected = readTaskQueue(checkout);
  const graph = readTaskGraph(checkout);
  expect(graph.require("demo:TSK-0").implementation).toMatchObject({
    baseline,
    checkout: root,
    evidence: "Integration tests passed.",
  });
  expect(graph.require("demo:TSK-0").metadata.status).toBe("Approved");
  expect(graph.require("demo:TSK-2").implementation).toBeUndefined();
  expect(inspectTaskQueue(checkout).ready).toEqual(["demo:TSK-2", "demo:TSK-1"]);
  expect(readTaskQueue(checkout)).toEqual(selected);
  changeTaskQueue(checkout, { action: "start", reference: "TSK-1" });
  changeTaskQueue(checkout, { action: "implemented", reference: "TSK-1", detail: "Dependent behavior passed." });
  expect(() => {
    changeTaskStatus(checkout, "TSK-1", "Accepted", undefined, true);
  }).toThrow(/Waiting for demo:TSK-0/);
  changeTaskStatus(checkout, "TSK-0", "Accepted", undefined, true);
  changeTaskStatus(checkout, "TSK-1", "Accepted", undefined, true);
  expect(readTaskGraph(checkout).require("demo:TSK-1").metadata.status).toBe("Accepted");
  expect(readTaskGraph(root).require("demo:TSK-0").metadata.status).toBe("Approved");
  expect(readTaskQueue(root).entries.map((entry) => entry.state)).toEqual(["Implemented", "Active"]);
});

test("an explicit local queue selection overrides shared evidence without reordering other work", () => {
  const checkout = worktree(implement());
  changeTaskQueue(checkout, { action: "add", references: ["TSK-1", "TSK-0", "TSK-2"] });
  expect(inspectTaskQueue(checkout).ready).toEqual(["demo:TSK-0", "demo:TSK-2"]);
  changeTaskQueue(checkout, { action: "start", reference: "TSK-0" });
  expect(inspectTaskQueue(checkout).ready).toEqual(["demo:TSK-2"]);
  changeTaskQueue(checkout, { action: "implemented", reference: "TSK-0", detail: "Reverified locally." });
  expect(inspectTaskQueue(checkout).ready).toEqual(["demo:TSK-1", "demo:TSK-2"]);
  expect(readTaskQueue(checkout).entries.map((entry) => entry.reference)).toEqual([
    "demo:TSK-1",
    "demo:TSK-0",
    "demo:TSK-2",
  ]);
  changeTaskQueue(checkout, { action: "implemented", reference: "TSK-0", detail: "Refreshed verification." });
  expect(readTaskQueue(checkout).entries[1]?.evidence).toBe("Refreshed verification.");
});

test("Git-normalized CRLF evidence preserves the index and still rejects raw task changes", () => {
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
  git(root, "config", "--local", "core.autocrlf", "true");
  const path = join(root, "workbench/tasks/TSK-00.md"),
    contents = readFileSync(path, "utf8").replaceAll("\n", "\r\n");
  writeFileSync(path, contents);
  writeFileSync(join(root, "implementation.txt"), "Staged version.\n");
  git(root, "add", "implementation.txt");
  const staged = git(root, "write-tree");
  writeFileSync(join(root, "implementation.txt"), "Verified working version.\n");
  changeTaskQueue(root, { action: "add", references: ["TSK-0"] });
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Verified CRLF checkout." });
  expect(git(root, "write-tree")).toBe(staged);
  expect(readFileSync(path, "utf8")).toBe(contents);
  const task = readTaskGraph(root).require("demo:TSK-0");
  writeFileSync(path, contents.replaceAll("\r\n", "\n"));
  expect(() => {
    recordTaskImplementation(root, task, "Task changed only in its raw line endings.");
  }).toThrow(/Task changed while recording/);
  expect(git(root, "write-tree")).toBe(staged);
  writeFileSync(path, contents);
  git(root, "add", ".");
  git(root, "commit", "-qm", "Verified normalized snapshot");
  const baseline = git(root, "rev-parse", "HEAD"),
    checkout = worktree(baseline);
  expect(readTaskGraph(checkout).require("demo:TSK-0").implementation).toMatchObject({
    baseline,
    checkout: root,
    evidence: "Verified CRLF checkout.",
  });
});

test("edited plans, unrelated history, and independent repositories cannot borrow evidence", () => {
  const baseline = implement(),
    checkout = worktree(baseline),
    unrelated = worktree(initial),
    independent = webFixture();
  roots.push(independent);
  expect(readTaskGraph(unrelated).require("demo:TSK-0").implementation).toBeUndefined();
  expect(taskImplementationPath(independent)).not.toBe(taskImplementationPath(root));
  mkdirSync(join(independent, "workbench/tasks"));
  writeFileSync(join(independent, "workbench/tasks/TSK-00.md"), readFileSync(join(root, "workbench/tasks/TSK-00.md")));
  expect(readTaskGraph(independent).require("demo:TSK-0").implementation).toBeUndefined();
  const path = join(checkout, "workbench/tasks/TSK-00.md");
  const original = readTaskGraph(checkout).require("demo:TSK-0");
  writeFileSync(path, readFileSync(path, "utf8") + "\nA materially different outcome.\n");
  expect(() => {
    recordTaskImplementation(checkout, original, "Verification of an outdated task.");
  }).toThrow(/Task changed while recording/);
  const graph = readTaskGraph(checkout);
  expect(graph.require("demo:TSK-0").implementation).toBeUndefined();
  expect(new TaskReadiness(graph, readTaskQueue(checkout)).blockers(graph.require("demo:TSK-1"))).toContainEqual({
    kind: "dependency",
    reference: "demo:TSK-0",
    message: "Waiting for demo:TSK-0 (Approved)",
  });
  const previous = readTaskGraph(root).tasks;
  attachTaskImplementations(unrelated, previous);
  expect(previous[0]?.implementation).toBeUndefined();
});

test("merged implementation baselines remain eligible even outside the first-parent history", () => {
  git(root, "checkout", "-qb", "implemented-work");
  const baseline = implement();
  git(root, "checkout", "--detach", initial);
  writeFileSync(join(root, "other-work.txt"), "Independent mainline work.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Mainline work");
  git(root, "merge", "--no-ff", "-m", "Integrate verified implementation", baseline);
  const checkout = worktree("HEAD");
  expect(readTaskGraph(checkout).require("demo:TSK-0").implementation?.baseline).toBe(baseline);
});

test("older verified baselines remain discoverable across long histories", () => {
  const baseline = implement();
  const input = Array.from({ length: 1200 }, (_, index) => {
    const contents = `History ${String(index)}\n`;
    return `commit refs/heads/long-history\ncommitter Fixture <fixture@example.invalid> ${String(1700000000 + index)} +0000\ndata 7\nHistory\n${index === 0 ? `from ${baseline}\n` : ""}M 100644 inline history.txt\ndata ${String(Buffer.byteLength(contents))}\n${contents}\n`;
  }).join("");
  const imported = spawnSync("git", ["-C", root, "fast-import", "--quiet"], { input, encoding: "utf8" });
  expect(imported.status, imported.stderr).toBe(0);
  const checkout = worktree("long-history");
  expect(readTaskGraph(checkout).require("demo:TSK-0").implementation?.baseline).toBe(baseline);
});

test("verified work appears as an outcome while the CLI retains its proof provenance", async () => {
  const baseline = implement(),
    checkout = worktree(baseline),
    collector = new WorkspaceCollector(checkout),
    snapshot = collector.collect(),
    context = Object.assign(new WorkspaceIndex(snapshot).select({}), {
      csrf: "fixture-csrf",
      refreshing: false,
      problem: "",
    });
  expect(context.taskReviews.map((item) => [item.record.id, item.decision])).toEqual([["demo:TSK-0", "outcome"]]);
  const page = parseDOM(reviewsPage(context)).window.document;
  expect(page.querySelector('[data-task-group="task:demo:TSK-0"]')?.textContent).toContain("Work 0");
  expect(parseDOM(workPage(context)).window.document.querySelector('[data-task-node="demo:TSK-0"]')).toBeNull();
  const record = context.index.byId.get("demo:TSK-0");
  if (!record) throw new Error("Missing prerequisite record");
  const controls = taskControls(context, record);
  if (!controls) throw new Error("Missing task controls");
  const html = renderToString(controls);
  expect(html).toContain("Accept outcome");
  const messages: unknown[] = [];
  const capture = vi.spyOn(console, "log").mockImplementation((message: unknown) => messages.push(message));
  try {
    const cli = new Command().exitOverride();
    registerTaskCommands(cli, checkout);
    await cli.parseAsync(["task", "show", "TSK-0", "--json"], { from: "user" });
  } finally {
    capture.mockRestore();
  }
  expect(JSON.parse(String(messages[0]))).toMatchObject({
    status: "Approved",
    implementation: { baseline, checkout: root, evidence: "Integration tests passed." },
  });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Additional source verification." });
  const refreshed = collector.collect();
  expect(refreshed.revision).not.toBe(snapshot.revision);
  expect(refreshed.tasks.records[0]?.implementation?.evidence).toBe("Additional source verification.");
});

test("malformed repository evidence is rejected without changing existing checkout queues", () => {
  implement();
  const checkout = worktree("HEAD"),
    path = taskImplementationPath(root);
  if (!path) throw new Error("Missing implementation catalogue");
  const before = readTaskQueue(root);
  const catalogue = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, unknown>[] };
  if (!catalogue.entries[0]) throw new Error("Missing implementation receipt");
  catalogue.entries[0].tree = "not-a-tree";
  writeFileSync(path, JSON.stringify(catalogue));
  expect(() => readTaskGraph(checkout)).toThrow(/implementation snapshot/);
  expect(readTaskQueue(root)).toEqual(before);
  expect(readTaskQueue(checkout).entries).toEqual([]);
});

test("relocating a repository preserves queue, historical implementation evidence, and its original provenance", async () => {
  const state = mkdtempSync(join(tmpdir(), "workbench-relocation-state-"));
  roots.push(state);
  vi.stubEnv("WORKBENCH_STATE_HOME", state);
  await registerConsumingProject(root);
  const config = join(root, "workbench/config.toml");
  writeFileSync(config, readFileSync(config, "utf8") + "\n[review]\ntask_approvals=true\n");
  changeTaskStatus(root, "TSK-0", "Approved", undefined, true);
  const decisions = readTaskDecisions(root);
  const id = projectIdentity(root),
    baseline = implement(),
    queue = readTaskQueue(root);
  const original = root,
    moved = root + "-moved";
  roots.push(moved);
  renameSync(original, moved);
  await relocateConsumingProject(original, moved);
  expect(projectIdentity(moved)).toBe(id);
  expect(readTaskQueue(moved)).toEqual(queue);
  expect(readTaskDecisions(moved)).toEqual(decisions);
  expect(readTaskGraph(moved).require("demo:TSK-0").implementation).toMatchObject({
    baseline,
    checkout: original,
    evidence: "Integration tests passed.",
  });
});
