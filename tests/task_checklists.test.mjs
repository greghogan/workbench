import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { syncTaskChecklists } from "../src/task-checklists.ts";

const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-task-checklists-"));
  temporary.push(root);
  mkdirSync(join(root, "workbench/tasks"), { recursive: true });
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="app"\npath="."\n');
  const task = (number, status, parent, body) => {
    const path = join(root, `workbench/tasks/TSK-0${number}.md`);
    writeFileSync(
      path,
      `---\nstatus: ${status}\nparent: ${parent ?? "null"}\ndepends_on: []\n---\n\n# TSK-${number}: Task\n\n${body}\n`,
    );
    return path;
  };
  return { root, task };
}

test("linked child items synchronize all lifecycle states without changing ordinary steps or fenced examples", () => {
  const { root, task } = fixture();
  const parent = task(
    0,
    "Active",
    null,
    "## Progress\n\n- [ ] app:TSK-1: Child\n- [x] Inline step\n\n```md\n- [ ] app:TSK-9: Example\n```",
  );
  for (const state of ["Planned", "Active", "Blocked", "Done", "Canceled", "Active"]) {
    task(1, state, "app:TSK-0", "## Progress\n");
    expect(() => syncTaskChecklists(root, true)).toThrow(/stale/);
    expect(syncTaskChecklists(root)).toEqual([parent]);
    const contents = readFileSync(parent, "utf8");
    expect(contents).toContain(`- [${["Done", "Canceled"].includes(state) ? "x" : " "}] app:TSK-1 (${state}): Child`);
    expect(contents).toContain("- [x] Inline step\n\n```md\n- [ ] app:TSK-9: Example\n```");
    expect(syncTaskChecklists(root, true)).toEqual([]);
    expect(syncTaskChecklists(root)).toEqual([]);
  }
});

test("checklist validation rejects missing and unrelated children, and unfinished steps in Done tasks", () => {
  const { root, task } = fixture();
  const parent = task(0, "Active", null, "- [ ] app:TSK-1: Child");
  expect(() => syncTaskChecklists(root)).toThrow(/child not found/);
  task(1, "Done", null, "");
  expect(() => syncTaskChecklists(root)).toThrow(/not a child/);
  task(1, "Done", "app:TSK-0", "- [ ] Verify behavior");
  expect(() => syncTaskChecklists(root)).toThrow(/Done task has an unchecked step/);
  expect(readFileSync(parent, "utf8")).toContain("- [ ] app:TSK-1: Child");
  task(1, "Done", "app:TSK-0", "- [x] Verify behavior");
  expect(syncTaskChecklists(root)).toEqual([parent]);
  task(0, "Done", null, "- [ ] Finish review");
  expect(() => syncTaskChecklists(root)).toThrow(/Done task/);
  task(0, "Canceled", null, "- [ ] Finish review");
  expect(syncTaskChecklists(root)).toEqual([]);
});
