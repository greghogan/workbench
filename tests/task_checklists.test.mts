import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { syncTaskChecklists } from "../src/task-checklists.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-task-checklists-"));
  temporary.push(root);
  mkdirSync(join(root, "workbench/tasks"), { recursive: true });
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="app"\npath="."\n');
  const task = (number: number, status: string, parent: string | null, body: string) => {
    const path = join(root, `workbench/tasks/TSK-0${String(number)}.md`);
    writeFileSync(
      path,
      `---\nstatus: ${status}\n${parent ? `parent: ${parent}\n` : ""}---\n\n# TSK-${String(number)}: Task\n\n${body}\n`,
    );
    return path;
  };
  return { root, task };
}

test("linked child items synchronize all lifecycle states without changing ordinary steps or fenced examples", () => {
  const { root, task } = fixture();
  const parent = task(
    0,
    "Approved",
    null,
    "## Progress\n\n- [ ] app:TSK-1: Child\n- [x] Inline step\n\n```md\n- [ ] app:TSK-9: Example\n```",
  );
  for (const state of ["Planned", "Approved", "Accepted", "Canceled", "Approved"]) {
    task(1, state, "app:TSK-0", "## Progress\n");
    expect(() => syncTaskChecklists(root, true)).toThrow(/stale/);
    expect(syncTaskChecklists(root)).toEqual([parent]);
    const contents = readFileSync(parent, "utf8");
    expect(contents).toContain(
      `- [${["Accepted", "Canceled"].includes(state) ? "x" : " "}] app:TSK-1 (${state}): Child`,
    );
    expect(contents).toContain("- [x] Inline step\n\n```md\n- [ ] app:TSK-9: Example\n```");
    expect(syncTaskChecklists(root, true)).toEqual([]);
    expect(syncTaskChecklists(root)).toEqual([]);
  }
});

test("checklist validation rejects missing and unrelated children, and unfinished steps in Accepted tasks", () => {
  const { root, task } = fixture();
  const parent = task(0, "Approved", null, "- [ ] app:TSK-1: Child");
  expect(() => syncTaskChecklists(root)).toThrow(/child not found/);
  task(1, "Accepted", null, "");
  expect(() => syncTaskChecklists(root)).toThrow(/not a child/);
  task(1, "Accepted", "app:TSK-0", "- [ ] Verify behavior");
  expect(() => syncTaskChecklists(root)).toThrow(/Accepted task has an unchecked step/);
  expect(readFileSync(parent, "utf8")).toContain("- [ ] app:TSK-1: Child");
  task(1, "Accepted", "app:TSK-0", "- [x] Verify behavior");
  expect(syncTaskChecklists(root)).toEqual([parent]);
  task(0, "Accepted", null, "- [ ] Finish review");
  expect(() => syncTaskChecklists(root)).toThrow(/Accepted task/);
  task(0, "Canceled", null, "- [ ] Finish review");
  expect(syncTaskChecklists(root)).toEqual([]);
});

test("indented examples are preserved and do not block acceptance or resolve fictional child references", () => {
  const { root, task } = fixture();
  const path = task(
    0,
    "Accepted",
    null,
    "## Progress\n\n- [x] Verified outcome\n\nExample:\n\n    - [ ] app:TSK-9: Example only",
  );
  const original = readFileSync(path, "utf8");
  expect(syncTaskChecklists(root)).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(original);
});
