import { git } from "../../fixtures/adoption.mjs";
import { configurePlanning, savePlanDraft } from "../../../src/core/tasks/planning/planning-operations.ts";
import { gitBytes, updatedReviewTree, writeReviewBlobs } from "../../../src/core/git/git-snapshot.ts";
import { workspaceSchemaVersion } from "../../../src/core/projects/project-model.ts";
import { planIdentity, planPrefix, planningPaths } from "../../../src/core/tasks/planning/plan-model.ts";
import { readPlan } from "../../../src/core/tasks/planning/planning-store.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { webServers, readWebPage, postWebForm } from "../../fixtures/web.mjs";
import { parseDOM } from "../../fixtures/dom.mjs";
import { changeTaskQueue, readTaskQueue } from "../../../src/core/tasks/task-queue.ts";
import { readTaskDecisions } from "../../../src/core/tasks/task-decisions.ts";

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
  const oldTree = readTaskDecisions(root).findLast((decision) => decision.status === "Accepted")?.tree;
  writeFileSync(join(root, "implementation.ts"), "export const revised=true;\n");
  const accepted = await readWebPage(web, "/records/demo:TSK-0");
  expect(accepted.html).toContain("Renew acceptance");
  const renew = form(accepted.html, 'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])');
  expect((await postWebForm(web, renew.path, renew.values)).status).toBe(200);
  expect(readTaskDecisions(root).findLast((decision) => decision.status === "Accepted")?.tree).not.toBe(oldTree);
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
  expect(navigation?.querySelector('[aria-current="page"] > span:first-child')?.textContent).toBe("Task queue");
  expect(navigation?.querySelector('[aria-current="page"] .nav-count')?.textContent).toBe("2");
  expect([...(navigation?.querySelectorAll(".nav-group-label") ?? [])].map((group) => group.textContent)).toEqual([
    "Workflow",
    "Records",
  ]);
  expect(
    [...(navigation?.querySelectorAll(".nav-group:first-child a") ?? [])].map((link) => link.getAttribute("href")),
  ).toEqual(["/review?scope=demo", "/queue?scope=demo"]);
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
    [...(section?.querySelectorAll(":scope > [data-task-window] > .task-tree > [data-task-node]") ?? [])].map((node) =>
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

test("task approval diffs show the retained plan and reject supporting files changed after inspection", async () => {
  const config = join(root, "workbench/config.toml");
  writeFileSync(config, readFileSync(config, "utf8") + "\n[review]\ntask_approvals=true\n");
  const path = task(0, "Planned"),
    supporting = join(root, "workbench/tasks/TSK-00/requirements.txt");
  mkdirSync(join(root, "workbench/tasks/TSK-00"));
  writeFileSync(supporting, "User service.\n");
  const web = await servers.start(root),
    page = "/records/demo:TSK-0";
  let approve = form(
    (await readWebPage(web, page)).html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Approved"])',
  );
  expect((await postWebForm(web, approve.path, approve.values)).status).toBe(200);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("Human-readable outcome.", "Automatic recovery after restart."),
  );
  let viewed = await readWebPage(web, page + "?view=changes");
  expect(viewed.response.status).toBe(200);
  let document = parseDOM(viewed.html).window.document;
  expect(document.querySelector(".document-diff del")?.textContent).toContain("Human-readable");
  expect(document.querySelector(".document-diff ins")?.textContent).toContain("Automatic");
  expect(document.querySelector('[aria-label="Record views"] [aria-current]')?.textContent).toBe("Diff");
  expect(
    parseDOM((await readWebPage(web, "/queue")).html).window.document.querySelector('[aria-label="Plans"]')
      ?.textContent,
  ).toContain("Work 0");
  expect(
    parseDOM((await readWebPage(web, "/queue")).html).window.document.querySelector('[aria-label="Work"]')?.textContent,
  ).not.toContain("Work 0");
  approve = form(viewed.html, 'form[action$="/actions/task-state"]:has(input[name="state"][value="Approved"])');
  writeFileSync(supporting, "System service.\n");
  expect((await postWebForm(web, approve.path, approve.values)).status).toBe(409);
  viewed = await readWebPage(web, page + "?view=changes");
  document = parseDOM(viewed.html).window.document;
  expect(document.querySelector('[aria-label="Supporting file changes"]')?.textContent).toContain(
    "requirements.txt: changed",
  );
  approve = form(viewed.html, 'form[action$="/actions/task-state"]:has(input[name="state"][value="Approved"])');
  expect((await postWebForm(web, approve.path, approve.values)).status).toBe(200);
  expect(
    parseDOM((await readWebPage(web, "/queue")).html).window.document.querySelector('[aria-label="Plans"]')
      ?.textContent,
  ).not.toContain("Work 0");
});

test("named plans remain durable drafts through browser editing, approval diffs, and local queue selection", async () => {
  configurePlanning(root, { branch: "future", auto_prune: true });
  const initial = git(root, "rev-parse", "HEAD"),
    web = await servers.start(root);
  const fresh = await readWebPage(web, "/plan/new"),
    create = form(fresh.html, 'form[action$="/actions/plan-create"]');
  const contents = "---\nstatus: Planned\n---\n\n# Background service\n\nInstall for the current user.\n";
  expect((await postWebForm(web, create.path, { ...create.values, name: "service", contents })).status).toBe(200);
  let saved = readPlan(root, planIdentity("demo", "service"));
  expect(saved.contents).toBe(contents);
  savePlanDraft(
    root,
    planIdentity("demo", "service"),
    saved.contents + "\n[Requirements](files/requirements.md#requirements)\n",
    {
      expected: saved.digest,
      files: new Map([["requirements.md", { contents: Buffer.from("# Requirements\n\nPreserve user data.\n") }]]),
    },
  );
  expect(git(root, "for-each-ref", "--format=%(refname)", "refs/heads/future")).toBe("");
  const page = "/plans/demo:plan%2Fservice";
  let viewed = await readWebPage(web, page);
  let approve = form(viewed.html, 'form[action$="/actions/plan-approve"]');
  expect((await postWebForm(web, approve.path, approve.values)).status).toBe(200);
  expect(git(root, "rev-list", "--count", "future")).toBe("1");
  expect(git(root, "rev-parse", "HEAD")).toBe(initial);
  let queue = parseDOM((await readWebPage(web, "/queue")).html).window.document;
  expect(queue.querySelector('[aria-label="Plans"]')?.textContent).not.toContain("Background service");
  expect(queue.querySelector('[aria-label="Work"]')?.textContent).toContain("Background service");
  const add = form(
    (await readWebPage(web, "/queue")).html,
    'form[action$="/actions/task-queue"]:has(input[name="reference"][value="demo:plan/service"])',
  );
  expect((await postWebForm(web, add.path, add.values)).status).toBe(200);
  expect(readTaskQueue(root).entries[0]?.reference).toBe("demo:plan/service");
  viewed = await readWebPage(web, page + "?view=edit");
  const edit = form(viewed.html, 'form[action$="/actions/plan-save"]');
  const revised = readPlan(root, planIdentity("demo", "service")).contents.replace("current user", "all users");
  expect((await postWebForm(web, edit.path, { ...edit.values, contents: revised })).status).toBe(200);
  expect((await postWebForm(web, edit.path, { ...edit.values, contents: "Stale overwrite" })).status).toBe(409);
  expect(git(root, "rev-list", "--count", "future")).toBe("1");
  viewed = await readWebPage(web, page + "?view=changes&layout=split");
  const document = parseDOM(viewed.html).window.document;
  expect(document.querySelector(".document-diff.split")?.textContent).toContain("all users");
  approve = form(viewed.html, 'form[action$="/actions/plan-approve"]');
  expect((await postWebForm(web, approve.path, approve.values)).status).toBe(200);
  saved = readPlan(root, planIdentity("demo", "service"));
  expect(saved.approval?.current).toBe(true);
  expect(git(root, "rev-list", "--count", "future")).toBe("2");
  queue = parseDOM((await readWebPage(web, "/queue")).html).window.document;
  expect(queue.querySelector('[aria-label="Work"]')?.textContent).toContain("Background service");
  const editPage = (await readWebPage(web, page + "?view=edit")).html,
    rename = form(editPage, 'form[action$="/actions/plan-rename"]');
  expect((await postWebForm(web, rename.path, { ...rename.values, name: "background" })).status).toBe(200);
  expect(readTaskQueue(root).entries[0]?.reference).toBe("demo:plan/background");
  const movedPage = await readWebPage(web, "/plans/demo:plan%2Fbackground");
  const supportingLink = parseDOM(movedPage.html).window.document.querySelector<HTMLAnchorElement>(
    '.document a[href*="requirements.md"]',
  );
  expect(supportingLink?.getAttribute("href")).toContain("/files?path=requirements.md");
  const queuePage = (await readWebPage(web, "/queue")).html,
    start = form(queuePage, 'form[action$="/actions/task-queue"]:has(input[name="operation"][value="start"])');
  expect((await postWebForm(web, start.path, start.values)).status).toBe(200);
  expect(readTaskQueue(root).entries[0]?.reference).toBe("demo:TSK-0");
  expect(readFileSync(join(root, "workbench/tasks/TSK-00/requirements.md"), "utf8")).toContain("Preserve user data");
  const implemented = parseDOM((await readWebPage(web, "/records/demo:TSK-0")).html).window.document;
  expect(implemented.body.textContent).toContain("Background service");
  const sourceLink = implemented
    .querySelector<HTMLAnchorElement>('.document a[href*="requirements.md"]')
    ?.getAttribute("href");
  expect(sourceLink).toContain(
    "/records/demo:TSK-0/files?path=workbench%2Ftasks%2FTSK-00%2Frequirements.md#document-requirements",
  );
  expect(git(root, "rev-parse", "HEAD")).toBe(initial);
});

test("workflow continuation includes named plans in local order and rejects stale cursors", async () => {
  configurePlanning(root, { branch: "future", auto_prune: true });
  const identities = Array.from({ length: 82 }, (_, index) =>
      planIdentity("demo", "plan-" + String(index).padStart(3, "0")),
    ),
    contents = identities.map((_, index) => Buffer.from(`---\nstatus: Planned\n---\n\n# Plan ${String(index)}\n`)),
    objects = writeReviewBlobs(root, [
      ...contents,
      Buffer.from(JSON.stringify({ schema_version: workspaceSchemaVersion, scopes: [{ id: "demo", path: "." }] })),
    ]),
    scopeObject = objects.at(-1);
  if (!scopeObject) throw new Error("Missing planning scopes");
  const tree = updatedReviewTree(root, "", [
      ...identities.map((identity, index) => {
        const oid = objects[index];
        if (!oid) throw new Error("Missing fixture plan");
        return { path: planPrefix(identity) + planningPaths.document, entry: { mode: "100644", oid } };
      }),
      { path: planningPaths.scopes, entry: { mode: "100644", oid: scopeObject } },
    ]),
    tip = git(root, "commit-tree", tree, "-m", "Plan fixture");
  gitBytes(root, ["update-ref", "refs/heads/future", tip]);
  changeTaskQueue(root, { action: "add", references: ["demo:plan/plan-081", "demo:plan/plan-000"] });
  const web = await servers.start(root),
    page = parseDOM((await readWebPage(web, "/queue")).html).window.document;
  const plans = page.querySelector('[data-task-window="workflow-plans"]');
  expect(plans?.querySelector("[data-task-node]")?.getAttribute("data-task-node")).toBe("demo:plan/plan-081");
  const firstIds = [...(plans?.querySelectorAll("[data-task-node]") ?? [])].map((node) =>
    node.getAttribute("data-task-node"),
  );
  expect(firstIds.length).toBeGreaterThan(0);
  expect(firstIds.length).toBeLessThan(82);
  const continuation = plans?.querySelector<HTMLAnchorElement>("[data-task-more]")?.getAttribute("href");
  if (!continuation) throw new Error("Missing workflow continuation");
  const next = parseDOM((await readWebPage(web, continuation)).html).window.document;
  const nextIds = [...next.querySelectorAll('[data-task-window="workflow-plans"] [data-task-node]')].map((node) =>
    node.getAttribute("data-task-node"),
  );
  expect(nextIds.length).toBeGreaterThan(0);
  expect([...firstIds, ...nextIds]).toHaveLength(82);
  expect(new Set([...firstIds, ...nextIds]).size).toBe(82);
  savePlanDraft(root, planIdentity("demo", "extra"), "---\nstatus: Planned\n---\n\n# New plan\n");
  expect((await readWebPage(web, continuation)).response.status).toBe(409);
});

test("task outcome links and numeric navigation remain available alongside named future plans", async () => {
  task(0, "Approved");
  task(1, "Planned");
  savePlanDraft(root, planIdentity("demo", "artifacts"), "---\nstatus: Planned\n---\n\n# Artifact delivery\n");
  savePlanDraft(root, planIdentity("demo", "service-tools"), "---\nstatus: Planned\n---\n\n# Service tools\n");
  changeTaskQueue(root, { action: "add", references: ["demo:TSK-0"] });
  changeTaskQueue(root, { action: "start", reference: "demo:TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "demo:TSK-0", detail: "Fixture outcome verified." });
  const web = await servers.start(root),
    workflow = parseDOM((await readWebPage(web, "/queue")).html).window.document,
    outcome = workflow
      .querySelector<HTMLAnchorElement>('[aria-label="Outcomes"] [data-record-id="demo:TSK-0"] a[data-card-link]')
      ?.getAttribute("href");
  if (!outcome) throw new Error("Missing task outcome link");
  const first = await readWebPage(web, outcome),
    document = parseDOM(first.html).window.document;
  expect(first.response.status).toBe(200);
  expect(document.querySelector('button[aria-label="Previous record"]')?.hasAttribute("disabled")).toBe(true);
  const next = document.querySelector<HTMLAnchorElement>('a[rel="next"]')?.getAttribute("href");
  if (!next) throw new Error("Missing next numeric task");
  const second = await readWebPage(web, next);
  expect(second.response.status).toBe(200);
  const secondDocument = parseDOM(second.html).window.document,
    previous = secondDocument.querySelector<HTMLAnchorElement>('a[rel="prev"]')?.getAttribute("href"),
    planned = secondDocument.querySelector<HTMLAnchorElement>('a[rel="next"]')?.getAttribute("href");
  expect(previous).toBe(outcome);
  if (!planned) throw new Error("Missing neighboring named plan");
  const plan = await readWebPage(web, planned);
  expect(plan.response.status).toBe(200);
  expect(parseDOM(plan.html).window.document.querySelector("main")?.textContent).toContain("Artifact delivery");
});

test("named plans remain searchable without inflating the Tasks record count", async () => {
  task(0, "Planned");
  savePlanDraft(root, planIdentity("demo", "future"), "---\nstatus: Planned\n---\n\n# A future design\n");
  const web = await servers.start(root);
  const records = parseDOM((await readWebPage(web, "/records?type=TSK")).html).window.document;
  expect(records.querySelectorAll("main [data-record-id]").length).toBe(1);
  expect(records.querySelector('nav[aria-label="Main navigation"] a[href*="type=TSK"]')?.textContent).toMatch(
    /Tasks\s*1/,
  );
  expect((await readWebPage(web, "/queue")).html).toContain("A future design");
  const search = form((await readWebPage(web, "/")).html, 'form[role="search"]');
  expect(
    (
      await readWebPage(
        web,
        search.path + "?" + new URLSearchParams({ ...search.values, q: "future design" }).toString(),
      )
    ).html,
  ).toContain("A future design");
});
