import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { webServers, readWebPage, postWebForm } from "./fixtures/web.mjs";
import { parseDOM } from "./fixtures/dom.mjs";
import { changeTaskQueue, readTaskQueue } from "../src/task-queue.ts";

const servers = webServers();
let root: string;
beforeEach(() => {
  root = servers.project();
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/local-state"));
  mkdirSync(join(root, "workbench/tasks"));
});
function task(number: number, status: string, fields = "") {
  const path = join(root, `workbench/tasks/TSK-${number.toString(36).toUpperCase().padStart(2, "0")}.md`);
  writeFileSync(
    path,
    `---\nstatus: ${status}\n${fields}---\n\n# TSK-${number.toString(36).toUpperCase()}: Work ${String(number)}\n\n## Overview\n\nHuman-readable outcome.\n\n## Details\n\n- [x] Verified.\n`,
  );
  return path;
}
function form(html: string, selector: string): { path: string; values: Record<string, string> } {
  const document = parseDOM(html).window.document;
  const selected = document.querySelector<HTMLFormElement>(selector);
  if (!selected) throw new Error(`Missing form: ${selector}`);
  const values = Object.fromEntries(
    [...selected.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [input.name, input.value]),
  );
  return { path: selected.getAttribute("action") ?? "", values };
}

test("task workflow separates plans, work and outcomes, and parents link to children with previews", async () => {
  task(0, "Planned");
  task(1, "Approved", "parent: demo:TSK-0\n");
  const web = await servers.start(root);
  const page = () => readWebPage(web, "/queue");
  let document = parseDOM((await page()).html).window.document;
  expect(
    [...document.querySelectorAll("main > section[aria-label]")].map((section) => section.getAttribute("aria-label")),
  ).toEqual(["Plans", "Work", "Outcomes"]);
  expect(document.querySelector('[aria-label="Plans"]')?.textContent).toContain("Work 0");
  expect(document.querySelector('[aria-label="Work"]')?.textContent).toContain("Work 1");
  const navigation = document.querySelector('nav[aria-label="Main navigation"]');
  expect(
    [...(navigation?.querySelectorAll('a[href*="type=ENV"], a[href*="type=EXP"]') ?? [])].map(
      (link) => link.querySelector("span")?.textContent,
    ),
  ).toEqual(["Environments", "Experiments"]);
  expect(document.querySelector("#queue-mode")).toBeNull();
  const parent = parseDOM((await readWebPage(web, "/records/demo:TSK-0")).html).window.document;
  expect(parent.querySelector(".record-location")?.firstElementChild?.textContent).toBe("workbench/tasks/TSK-00.md");
  const actions = parent.querySelector('[aria-label="Task actions"]');
  expect([...(actions?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toEqual([
    "Approve plan",
  ]);
  expect(actions?.querySelector("h2")).toBeNull();
  expect(actions?.querySelector('a[href$="/queue"]')).toBeNull();
  const child = parent.querySelector<HTMLAnchorElement>(
    '[aria-label="Subtasks"] a[data-record-reference="demo:TSK-1"]',
  );
  expect(child?.textContent).toContain("Work 1");
  expect(child?.dataset.recordTitle).toContain("Work 1");
  expect(child?.dataset.recordSummary).toContain("Human-readable outcome");
  expect(parent.querySelector('[aria-label="Record views"]')).toBeNull();
  const approve = form(
    (await readWebPage(web, "/records/demo:TSK-0")).html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Approved"])',
  );
  expect((await postWebForm(web, approve.path, approve.values)).status).toBe(200);
  changeTaskQueue(root, { action: "add", references: ["TSK-1"] });
  changeTaskQueue(root, { action: "start", reference: "TSK-1" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-1", detail: "Verified the child outcome." });
  document = parseDOM((await page()).html).window.document;
  expect(document.querySelector('[aria-label="Plans"]')?.textContent).not.toContain("Work 0");
  expect(document.querySelector('[aria-label="Outcomes"]')?.textContent).toContain("Work 1");
  expect(document.querySelector('[aria-label="Work"]')?.textContent).not.toContain("Work 1");
  const accept = form(
    (await readWebPage(web, "/records/demo:TSK-1")).html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])',
  );
  expect(accept.values.state).toBe("Accepted");
  expect((await postWebForm(web, accept.path, accept.values)).status).toBe(200);
  expect(
    parseDOM((await page()).html).window.document.querySelector('[aria-label="Outcomes"]')?.textContent,
  ).not.toContain("Work 1");
});

test("browser decisions bind approval to exact task versions and acceptance to verified work", async () => {
  const config = join(root, "workbench/config.toml");
  writeFileSync(config, readFileSync(config, "utf8") + "\n[review]\ntask_approvals=true\n");
  const path = task(0, "Planned");
  const web = await servers.start(root);
  const page = await readWebPage(web, "/records/demo:TSK-0");
  const actions = parseDOM(page.html).window.document.querySelector('[aria-label="Task actions"]');
  expect([...(actions?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toEqual([
    "Cancel task",
    "Approve plan",
  ]);
  const approve = form(page.html, 'form[action$="/actions/task-state"]:has(input[name="state"][value="Approved"])');
  expect(
    parseDOM(page.html).window.document.querySelector('form[action$="/actions/task-state"] input[type="checkbox"]'),
  ).toBeNull();
  expect((await postWebForm(web, approve.path, { ...approve.values, expected: "" })).status).toBe(400);
  expect((await postWebForm(web, approve.path, { ...approve.values, csrf: "wrong" })).status).toBe(403);
  const approval = await postWebForm(web, approve.path, approve.values);
  expect(approval.status, await approval.text()).toBe(200);
  expect(readFileSync(path, "utf8")).toContain("status: Approved");
  expect((await postWebForm(web, approve.path, approve.values)).status).toBe(409);
  const approved = await readWebPage(web, "/records/demo:TSK-0");
  const add = form(approved.html, 'form[action$="/actions/task-queue"]');
  expect((await postWebForm(web, add.path, add.values)).status).toBe(200);
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Unit and browser checks passed." });
  const implemented = await readWebPage(web, "/records/demo:TSK-0");
  expect(implemented.html).toContain("Unit and browser checks passed.");
  const accept = form(
    implemented.html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])',
  );
  expect(accept.values.state).toBe("Accepted");
  expect((await postWebForm(web, accept.path, accept.values)).status).toBe(200);
  expect(readFileSync(path, "utf8")).toContain("status: Accepted");
  const oldTree = readTaskQueue(root).decisions?.find((decision) => decision.status === "Accepted")?.tree;
  writeFileSync(join(root, "implementation.ts"), "export const revised=true;\n");
  const accepted = await readWebPage(web, "/records/demo:TSK-0");
  expect(accepted.html).toContain("Renew acceptance");
  const renew = form(accepted.html, 'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])');
  expect((await postWebForm(web, renew.path, renew.values)).status).toBe(200);
  expect(readTaskQueue(root).decisions?.find((decision) => decision.status === "Accepted")?.tree).not.toBe(oldTree);
});

test("queue view reorders accessibly, rejects stale actions, and observes external queue changes", async () => {
  task(0, "Approved");
  task(1, "Approved", "parent: demo:TSK-0\n");
  changeTaskQueue(root, { action: "add", references: ["TSK-0", "TSK-1"] });
  const web = await servers.start(root, { pollInterval: 50 });
  const plans = parseDOM((await readWebPage(web, "/records?type=TSK")).html).window.document;
  expect(plans.querySelector('[data-task-branch="demo:TSK-0"] [data-task-node="demo:TSK-1"]')).not.toBeNull();
  const before = readFileSync(join(root, "workbench/tasks/TSK-01.md"), "utf8");
  const page = await readWebPage(web, "/queue");
  const document = parseDOM(page.html).window.document;
  expect(document.querySelector('nav[aria-label="Task views"]')).toBeNull();
  const navigation = document.querySelector('nav[aria-label="Main navigation"]');
  expect(navigation?.querySelector('[aria-current="page"]')?.textContent).toBe("Task queue");
  expect([...(navigation?.querySelectorAll(".nav-group-label") ?? [])].map((group) => group.textContent)).toEqual([
    "Workflow",
    "Records",
  ]);
  expect(
    [...(navigation?.querySelectorAll(".nav-group:first-child a") ?? [])].map((link) => link.getAttribute("href")),
  ).toEqual(["/review", "/queue"]);
  expect(plans.querySelector('nav[aria-label="Main navigation"] a[aria-current="page"]')?.textContent).toBe("Tasks2");
  const move = form(page.html, '.task-queue > li form:has(input[name="operation"][value="move-after"])');
  expect((await postWebForm(web, move.path, move.values)).status).toBe(200);
  expect(readTaskQueue(root).entries.map((entry) => entry.reference)).toEqual(["demo:TSK-1", "demo:TSK-0"]);
  expect((await postWebForm(web, move.path, move.values)).status).toBe(409);
  expect(readFileSync(join(root, "workbench/tasks/TSK-01.md"), "utf8")).toBe(before);
  const revision = web.monitor.revision;
  changeTaskQueue(root, { action: "start", reference: "TSK-1" });
  await expect.poll(() => web.monitor.revision, { timeout: 10000 }).not.toBe(revision);
  expect((await readWebPage(web, "/queue", false)).html).toContain("Active");
});

test("small task trees show completed subtasks beneath their parent immediately", async () => {
  task(0, "Accepted");
  task(1, "Accepted", "parent: demo:TSK-0\n");
  task(2, "Canceled");
  const web = await servers.start(root);
  const page = parseDOM((await readWebPage(web, "/records?type=TSK")).html).window.document;
  expect(page.querySelector('[data-task-node="demo:TSK-0"]')).not.toBeNull();
  expect(page.querySelector('[data-task-node="demo:TSK-2"]')).not.toBeNull();
  const branch = page.querySelector<HTMLDetailsElement>('[data-task-branch="demo:TSK-0"]');
  expect(branch?.open).toBe(true);
  expect(branch?.querySelector('[data-task-node="demo:TSK-1"]')).not.toBeNull();
  expect(branch?.querySelector("[data-task-more]")).toBeNull();
  expect(page.querySelector('nav[aria-label="Task views"] [aria-current="page"]')?.textContent).toBe("All tasks");
  const collapsed = parseDOM(
    (
      await readWebPage(
        web,
        "/records?type=TSK&task_windows=" + encodeURIComponent(JSON.stringify({ "demo:TSK-0": false })),
      )
    ).html,
  ).window.document;
  expect(collapsed.querySelector<HTMLDetailsElement>('[data-task-branch="demo:TSK-0"]')?.open).toBe(false);
  expect(collapsed.querySelector('[data-task-node="demo:TSK-1"]')).toBeNull();
});

test("plans and available work nest descendants without promoting children to separate roots", async () => {
  task(0, "Planned");
  task(1, "Planned", "parent: demo:TSK-0\n");
  task(2, "Planned", "parent: demo:TSK-1\n");
  task(3, "Planned");
  const web = await servers.start(root);
  const plans = parseDOM((await readWebPage(web, "/queue")).html).window.document;
  const section = plans.querySelector('[aria-label="Plans"]');
  expect(
    [...(section?.querySelectorAll(":scope > .task-tree > [data-task-node]") ?? [])].map((node) =>
      node.getAttribute("data-task-node"),
    ),
  ).toEqual(["demo:TSK-0", "demo:TSK-3"]);
  expect(
    section?.querySelector(
      '[data-task-node="demo:TSK-0"] > .task-tree > [data-task-node="demo:TSK-1"] > .task-tree > [data-task-node="demo:TSK-2"]',
    ),
  ).not.toBeNull();
  expect(section?.querySelectorAll('[data-record-id="demo:TSK-2"]')).toHaveLength(1);
  task(0, "Approved");
  task(1, "Approved", "parent: demo:TSK-0\n");
  const revised = parseDOM((await readWebPage(web, "/queue")).html).window.document;
  expect(
    revised.querySelector(
      '[aria-label="Work"] [data-task-node="demo:TSK-0"] > .task-tree > [data-task-node="demo:TSK-1"]',
    ),
  ).not.toBeNull();
  const child = revised.querySelector('[aria-label="Plans"] [data-task-node="demo:TSK-2"]');
  expect(child?.querySelector('[aria-label="Parent task"] a[data-record-reference="demo:TSK-1"]')).not.toBeNull();
});

test("automatic branches and continuation links share the initial task budget", async () => {
  task(0, "Approved");
  for (let index = 1; index < 106; index++) task(index, "Approved", "parent: demo:TSK-0\n");
  const web = await servers.start(root);
  const first = parseDOM((await readWebPage(web, "/records?type=TSK")).html).window.document;
  expect(first.querySelectorAll("[data-task-node]")).toHaveLength(100);
  expect(first.querySelector('details[data-task-branch="demo:TSK-0"]')?.hasAttribute("open")).toBe(true);
  const more = first
    .querySelector<HTMLAnchorElement>('[data-task-branch="demo:TSK-0"] [data-task-more]')
    ?.getAttribute("href");
  if (!more) throw new Error("Missing child continuation");
  const next = parseDOM((await readWebPage(web, more)).html).window.document;
  expect(next.querySelectorAll("[data-task-node]")).toHaveLength(6);
  const seen = new Set(
    [...first.querySelectorAll("[data-task-node]")].map((node) => node.getAttribute("data-task-node")),
  );
  expect(
    [...next.querySelectorAll("[data-task-node]")].some((node) => seen.has(node.getAttribute("data-task-node"))),
  ).toBe(false);
});

test("incomplete task acceptance reports an actionable input error and preserves the record", async () => {
  const path = task(0, "Approved");
  const contents = readFileSync(path, "utf8").replace("[x]", "[ ]");
  writeFileSync(path, contents);
  const web = await servers.start(root);
  const page = await readWebPage(web, "/records/demo:TSK-0");
  const accept = form(page.html, 'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])');
  const response = await postWebForm(web, accept.path, accept.values);
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("unchecked step");
  expect(readFileSync(path, "utf8")).toBe(contents);
});

test("task trees load 100 roots or children per batch, preserve context, and reject stale cursors", async () => {
  for (let index = 0; index < 130; index++) task(index, index % 2 ? "Planned" : "Approved");
  for (let index = 130; index < 235; index++) task(index, "Approved", "parent: demo:TSK-0\n");
  const web = await servers.start(root);
  const first = parseDOM((await readWebPage(web, "/records?type=TSK")).html).window.document;
  expect(first.querySelectorAll("[data-task-node]")).toHaveLength(100);
  expect(first.querySelector('details[data-task-branch="demo:TSK-0"]')?.hasAttribute("open")).toBe(false);
  const more = first
    .querySelector<HTMLAnchorElement>('[data-task-window="roots"] > [data-task-loader] [data-task-more]')
    ?.getAttribute("href");
  if (!more) throw new Error("Missing continuation");
  const second = parseDOM((await readWebPage(web, more)).html).window.document;
  expect(second.querySelectorAll("[data-task-node]")).toHaveLength(30);
  const branch = first
    .querySelector<HTMLAnchorElement>('[data-task-branch="demo:TSK-0"] [data-task-more]')
    ?.getAttribute("href");
  if (!branch) throw new Error("Missing branch");
  const children = parseDOM((await readWebPage(web, branch)).html).window.document;
  expect(children.querySelectorAll("[data-task-node]")).toHaveLength(100);
  expect(children.querySelector('nav[aria-label="Task hierarchy"]')?.textContent).toContain("Work 0");
  task(236, "Approved");
  expect((await readWebPage(web, more)).response.status).toBe(409);
});
