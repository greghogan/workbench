import { git } from "../../fixtures/adoption.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { readWebPage, postWebForm } from "../../fixtures/web.mjs";
import { breadcrumbLinks, parseDOM } from "../../fixtures/dom.mjs";
import { changeTaskQueue, readTaskQueue } from "../../../src/core/tasks/task-queue.ts";
import { taskWorkflowServers, workflowForm, writeWorkflowTask } from "../../fixtures/task-workflow.mjs";

const servers = taskWorkflowServers();
let root: string;
beforeEach(() => {
  root = servers.project();
});

test("queue view reorders accessibly, rejects stale actions, and observes external queue changes", async () => {
  writeWorkflowTask(root, 0, "Approved");
  writeWorkflowTask(root, 1, "Approved", "parent: demo:TSK-0\n");
  const third = writeWorkflowTask(root, 2, "Approved");
  changeTaskQueue(root, { action: "add", references: ["TSK-0", "TSK-1", "TSK-2"] });
  const web = await servers.start(root, { pollInterval: 50 });
  const plans = parseDOM((await readWebPage(web, "/records?type=TSK")).html).window.document;
  expect(plans.querySelector('[data-task-branch="demo:TSK-0"] [data-task-node="demo:TSK-1"]')).not.toBeNull();
  const before = readFileSync(join(root, "workbench/tasks/TSK-01.md"), "utf8");
  const page = await readWebPage(web, "/work");
  const document = parseDOM(page.html).window.document;
  const queueForm = workflowForm(page.html, 'form:has(input[name="operation"][value="move-after"])'),
    snapshot = readTaskQueue(root);
  for (const operation of ["start", "block", "implemented", "release", "remove", "add"])
    expect(
      (
        await postWebForm(web, queueForm.path, {
          ...queueForm.values,
          operation,
          detail: "Browser must not claim agent progress.",
        })
      ).status,
    ).toBe(400);
  expect(readTaskQueue(root)).toEqual(snapshot);
  expect(document.querySelector('nav[aria-label="Task views"]')).toBeNull();
  const navigation = document.querySelector('nav[aria-label="Main navigation"]');
  expect(navigation?.querySelector('[aria-current="page"] > span:first-child')?.textContent).toBe("Work");
  expect(navigation?.querySelector('[aria-current="page"] .nav-count')?.textContent).toBe("3");
  expect([...(navigation?.querySelectorAll(".nav-group-label") ?? [])].map((group) => group.textContent)).toEqual([
    "Workflow",
    "Records",
  ]);
  expect(
    [...(navigation?.querySelectorAll(".nav-group:first-child a") ?? [])].map((link) => link.getAttribute("href")),
  ).toEqual(["/plans?scope=demo", "/work?scope=demo", "/reviews?scope=demo"]);
  expect(plans.querySelector('nav[aria-label="Main navigation"] a[aria-current="page"]')?.textContent).toBe("Tasks3");
  const rows = [...document.querySelectorAll(".task-queue > li")];
  expect(rows).toHaveLength(3);
  for (const [index, row] of rows.entries()) {
    const controls = row.querySelector("fieldset");
    expect(controls?.querySelector("legend")?.textContent).toBe(`Queue controls: Work ${String(index)}`);
    const buttons = [...(controls?.querySelectorAll("button") ?? [])];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      `Move up: Work ${String(index)}`,
      `Move down: Work ${String(index)}`,
    ]);
    expect(buttons.map((button) => button.disabled)).toEqual([index === 0, index === rows.length - 1]);
    expect(
      [...(controls?.querySelectorAll('input[name="reference"]') ?? [])].map((input) => input.getAttribute("value")),
    ).toEqual(Array(2).fill(`demo:TSK-${String(index)}`));
  }
  const move = workflowForm(page.html, '.task-queue > li form:has(input[name="operation"][value="move-after"])');
  expect((await postWebForm(web, move.path, move.values)).status).toBe(200);
  expect(readTaskQueue(root).entries.map((entry) => entry.reference)).toEqual([
    "demo:TSK-1",
    "demo:TSK-0",
    "demo:TSK-2",
  ]);
  const reordered = parseDOM((await readWebPage(web, "/work")).html).window.document;
  const firstLink = reordered
    .querySelector<HTMLAnchorElement>(".task-queue > li:first-child h3 a")
    ?.getAttribute("href");
  if (!firstLink) throw new Error("Missing ordered work link");
  const firstTask = parseDOM((await readWebPage(web, firstLink)).html).window.document;
  expect(
    new URL(firstTask.querySelector<HTMLAnchorElement>('a[rel="next"]')?.getAttribute("href") ?? "", web.url).pathname,
  ).toBe("/records/demo:TSK-0");
  expect((await postWebForm(web, move.path, move.values)).status).toBe(409);
  expect(readFileSync(join(root, "workbench/tasks/TSK-01.md"), "utf8")).toBe(before);
  const revision = web.monitor.revision;
  changeTaskQueue(root, { action: "start", reference: "TSK-1" });
  await expect.poll(() => web.monitor.revision, { timeout: 10000 }).not.toBe(revision);
  const active = await readWebPage(web, "/work");
  expect(active.html).toContain("Implementing");
  expect(active.html).not.toContain("Remove from queue");
  changeTaskQueue(root, { action: "remove", reference: "TSK-2" });
  expect(readTaskQueue(root).entries.map((entry) => entry.reference)).toEqual(["demo:TSK-1", "demo:TSK-0"]);
  expect(readFileSync(third, "utf8")).toContain("status: Approved");
});

test("small task trees show completed subtasks beneath their parent immediately", async () => {
  writeWorkflowTask(root, 0, "Accepted");
  writeWorkflowTask(root, 1, "Accepted", "parent: demo:TSK-0\n");
  writeWorkflowTask(root, 2, "Canceled");
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

test("plans retain ancestry while Work shows the selected execution queue", async () => {
  writeWorkflowTask(root, 0, "Planned");
  writeWorkflowTask(root, 1, "Planned", "parent: demo:TSK-0\n");
  writeWorkflowTask(root, 2, "Planned", "parent: demo:TSK-1\n");
  writeWorkflowTask(root, 3, "Planned");
  const web = await servers.start(root);
  const plans = parseDOM((await readWebPage(web, "/plans")).html).window.document;
  const section = plans.querySelector("main");
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
  writeWorkflowTask(root, 0, "Approved");
  writeWorkflowTask(root, 1, "Approved", "parent: demo:TSK-0\n");
  await web.monitor.reconcileAfterChange();
  const revised = parseDOM((await readWebPage(web, "/work")).html).window.document;
  expect(revised.querySelector("[data-task-node]")).toBeNull();
  changeTaskQueue(root, { action: "add", references: ["TSK-1"] });
  await web.monitor.reconcileAfterChange();
  const scheduled = parseDOM((await readWebPage(web, "/work")).html).window.document;
  expect(scheduled.querySelector('.task-queue > [data-task-node="demo:TSK-1"]')).not.toBeNull();
  const child = parseDOM((await readWebPage(web, "/plans")).html).window.document.querySelector(
    '[data-task-node="demo:TSK-2"]',
  );
  expect(child?.querySelector('[aria-label="Parent task"] a[data-record-reference="demo:TSK-1"]')).not.toBeNull();
});

test("automatic branches and continuation links share the initial task budget", async () => {
  writeWorkflowTask(root, 0, "Approved");
  for (let index = 1; index < 106; index++) writeWorkflowTask(root, index, "Approved", "parent: demo:TSK-0\n");
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

test("task trees load 100 roots or children per batch, preserve context, and reject stale cursors", async () => {
  for (let index = 0; index < 130; index++) writeWorkflowTask(root, index, index % 2 ? "Planned" : "Approved");
  for (let index = 130; index < 235; index++) writeWorkflowTask(root, index, "Approved", "parent: demo:TSK-0\n");
  const web = await servers.start(root);
  const first = parseDOM((await readWebPage(web, "/records?type=TSK")).html).window.document;
  expect(first.querySelectorAll("[data-task-node]")).toHaveLength(100);
  expect(first.querySelector('details[data-task-branch="demo:TSK-0"]')).toBeNull();
  const more = first
    .querySelector<HTMLAnchorElement>('[data-task-window="roots"] > [data-task-loader] [data-task-more]')
    ?.getAttribute("href");
  if (!more) throw new Error("Missing continuation");
  const second = parseDOM((await readWebPage(web, more)).html).window.document;
  expect(second.querySelectorAll('[data-task-window="roots"] > .task-tree > [data-task-node]')).toHaveLength(30);
  const branch = second
    .querySelector<HTMLAnchorElement>('[data-task-branch="demo:TSK-0"] [data-task-more]')
    ?.getAttribute("href");
  if (!branch) throw new Error("Missing branch");
  const children = parseDOM((await readWebPage(web, branch)).html).window.document;
  expect(children.querySelectorAll("[data-task-node]")).toHaveLength(35);
  expect(children.querySelector('nav[aria-label="Task hierarchy"]')?.textContent).toContain("Work 0");
  writeWorkflowTask(root, 236, "Approved");
  await web.monitor.reconcileAfterChange();
  expect((await readWebPage(web, more)).response.status).toBe(409);
});

test("browser reversion previews the affected work and stages an outcome requiring renewed verification", async () => {
  writeWorkflowTask(root, 0, "Accepted");
  writeFileSync(join(root, "feature.txt"), "An implemented feature.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Feature delivery\n\nWorkbench-Provisional: true");
  const head = git(root, "rev-parse", "HEAD"),
    web = await servers.start(root),
    record = parseDOM((await readWebPage(web, "/records/demo:TSK-0")).html).window.document,
    link = [...record.querySelectorAll<HTMLAnchorElement>("a")]
      .find((candidate) => candidate.textContent === "Revert work")
      ?.getAttribute("href");
  if (!link) throw new Error("Reversion is not discoverable from the task");
  const reasonForm = workflowForm(
      (await readWebPage(web, link)).html,
      'form[method="get"]:has(textarea[name="reason"])',
    ),
    destination = new URL(reasonForm.path, "http://workbench.invalid");
  destination.search = new URLSearchParams({
    ...reasonForm.values,
    reason: "The original approach is no longer wanted.",
  }).toString();
  const preview = (await readWebPage(web, destination.pathname + destination.search)).html,
    confirm = workflowForm(preview, 'form[action$="/actions/task-disposition"]');
  expect(preview).toContain("feature.txt");
  const previewDocument = parseDOM(preview).window.document;
  const commitLink = [...previewDocument.querySelectorAll("main a")]
    .find((candidate) => candidate.textContent === head.slice(0, 12))
    ?.getAttribute("href");
  if (!commitLink) throw new Error("Missing affected commit link");
  const commit = await readWebPage(web, commitLink);
  expect(commit.response.status).toBe(200);
  expect(breadcrumbLinks(parseDOM(commit.html).window.document).map(([label]) => label)).toEqual([
    "demo",
    "Tasks",
    "TSK-0: Work 0",
    "Commits",
  ]);
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  const response = await postWebForm(web, confirm.path, confirm.values);
  expect(response.status).toBe(200);
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(git(root, "diff", "--cached", "--name-only")).toContain("feature.txt");
  expect(readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8")).toContain(
    "The original approach is no longer wanted.",
  );
  expect(readTaskQueue(root).entries[0]?.state).toBe("Queued");
});

test("task cancellation is explicit and optional, and cannot cancel accepted or active work", async () => {
  const path = writeWorkflowTask(root, 0, "Approved");
  changeTaskQueue(root, { action: "add", references: ["TSK-0"] });
  const web = await servers.start(root);
  const read = parseDOM((await readWebPage(web, "/records/demo:TSK-0?workflow=1")).html).window.document;
  expect(read.querySelector('textarea[name="reason"]')).toBeNull();
  const destination = [...read.querySelectorAll<HTMLAnchorElement>("a")].find(
    (link) => link.textContent === "Cancel task",
  )?.href;
  expect(destination).toBeDefined();
  let page = await readWebPage(web, destination ?? "");
  expect(breadcrumbLinks(parseDOM(page.html).window.document)).toEqual([
    ["demo", "/?scope=demo"],
    ["Work", "/work?scope=demo"],
    ["TSK-0: Work 0", "/records/demo:TSK-0?workflow=1&scope=demo"],
  ]);
  expect(
    parseDOM(page.html).window.document.querySelector('form[action$="/actions/task-state"] input[value="Accepted"]'),
  ).toBeNull();
  const cancel = workflowForm(page.html, 'form[action$="/actions/task-state"]');
  changeTaskQueue(root, { action: "add", references: ["TSK-0"] });
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  expect((await postWebForm(web, cancel.path, cancel.values)).status).toBe(409);
  changeTaskQueue(root, { action: "block", reference: "TSK-0", detail: "Stop for cancellation." });
  expect((await postWebForm(web, cancel.path, cancel.values)).status).toBe(200);
  expect(readFileSync(path, "utf8")).toContain("status: Canceled");
  expect(readFileSync(path, "utf8")).not.toContain("## Cancellation");
  writeWorkflowTask(root, 1, "Accepted");
  page = await readWebPage(web, "/records/demo:TSK-1");
  expect(parseDOM(page.html).window.document.querySelector('a[href*="kind=cancel"]')).toBeNull();
  const reopen = workflowForm(
    page.html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Planned"])',
  );
  expect((await postWebForm(web, reopen.path, { ...reopen.values, state: "Canceled" })).status).toBe(409);
});

test.for(["cancel-remove", "cancel-revert"] as const)(
  "canceling committed work with %s keeps its record and leaves the receiver unchanged",
  async (kind) => {
    const base = git(root, "rev-parse", "HEAD");
    const path = writeWorkflowTask(root, 0, "Approved");
    const file = join(root, "feature.txt");
    writeFileSync(file, "Initial delivery.\n");
    git(root, "add", "feature.txt", "workbench/tasks/TSK-00.md");
    git(root, "commit", "-qm", "Deliver the task");
    const published = git(root, "rev-parse", "HEAD");
    const branch = git(root, "branch", "--show-current");
    const receiver = join(root, ".git/receiver.git");
    git(root, "init", "--bare", "-q", receiver);
    git(root, "remote", "add", "fixture", join(root, ".git/unavailable.git"));
    git(root, "remote", "set-url", "--push", "fixture", receiver);
    git(root, "tag", "published");
    git(root, "push", "-q", "fixture", `HEAD:${branch}`, "refs/tags/published");
    if (kind === "cancel-remove") git(root, "commit", "--amend", "-qm", "Amend the delivered task");
    const delivered = git(root, "rev-parse", "HEAD");
    changeTaskQueue(root, { action: "add", references: ["TSK-0"] });
    const web = await servers.start(root);
    const details = await readWebPage(web, "/records/demo:TSK-0");
    const revise = workflowForm(
      details.html,
      'form[action$="/actions/task-state"]:has(input[name="state"][value="Planned"])',
    );
    expect((await postWebForm(web, revise.path, { ...revise.values, state: "Canceled" })).status).toBe(409);
    const record = parseDOM(details.html).window.document;
    const choice = record.querySelector('a[href*="kind=cancel"]')?.getAttribute("href");
    if (!choice) throw new Error("Missing cancellation choices");
    const choices = parseDOM((await readWebPage(web, choice)).html).window.document;
    expect([...choices.querySelectorAll('button[name="kind"]')].map((button) => button.textContent)).toEqual([
      "Remove task commits",
      "Revert with a new commit",
    ]);
    const previewURL = new URL(choice, web.url);
    previewURL.searchParams.set("kind", kind);
    previewURL.searchParams.set("reason", "Retain the existing product design.");
    const preview = () => readWebPage(web, previewURL.pathname + previewURL.search);
    let page = await preview();
    expect(page.response.status).toBe(200);
    expect(page.html).toContain("feature.txt");
    expect(git(root, "rev-parse", "HEAD")).toBe(delivered);
    expect(git(root, "status", "--porcelain")).toBe("");
    if (kind === "cancel-remove") {
      expect(page.html).toContain(`fixture (endpoint 2)/${branch}`);
      expect(page.html).toContain(published.slice(0, 12));
      expect(page.html).toContain("Publication could not be verified on fixture (endpoint 1)");
      expect(page.html).toContain("Remove published commits locally");
      const original = workflowForm(page.html, 'form[action$="/actions/task-disposition"]');
      expect((await postWebForm(web, original.path, { ...original.values, confirmPublished: "" })).status).toBe(409);
      git(root, "tag", "second-publication");
      git(root, "push", "-q", "fixture", "refs/tags/second-publication");
      await web.monitor.reconcileAfterChange();
      expect((await postWebForm(web, original.path, original.values)).status).toBe(409);
      page = await preview();
      expect(page.html).toContain("fixture (endpoint 2)/tags/second-publication");
    }
    const confirm = workflowForm(page.html, 'form[action$="/actions/task-disposition"]');
    const applied = await postWebForm(web, confirm.path, confirm.values);
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect(git(root, "rev-parse", "HEAD^")).toBe(kind === "cancel-remove" ? base : delivered);
    expect(git(receiver, "rev-parse", `refs/heads/${branch}`)).toBe(published);
    expect(readFileSync(path, "utf8")).toContain("status: Canceled");
    expect(readFileSync(path, "utf8")).toContain("Retain the existing product design.");
    expect(git(root, "ls-tree", "HEAD", "feature.txt")).toBe("");
    expect(readTaskQueue(root).entries).toEqual([]);
    expect(git(root, "for-each-ref", "--format=%(objectname)", "refs/workbench/recovery/task-disposition")).toContain(
      delivered,
    );
  },
);

test("verification stays valid for unrelated edits and returns changed delivery to Work", async () => {
  writeWorkflowTask(root, 0, "Approved");
  writeWorkflowTask(root, 1, "Approved", "depends_on: [demo:TSK-0]\n");
  const feature = join(root, "implementation.txt");
  writeFileSync(feature, "Verified implementation.\n");
  const verify = () => {
    changeTaskQueue(root, { action: "start", reference: "TSK-0" });
    changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Verified exact source." });
  };
  changeTaskQueue(root, { action: "add", references: ["TSK-0", "TSK-1"] });
  verify();
  const web = await servers.start(root);
  const selector = 'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])';
  const record = "/records/demo:TSK-0";
  writeFileSync(join(root, "unrelated.txt"), "An independent task.\n");
  await web.monitor.reconcileAfterChange();
  const previouslyPresented = workflowForm((await readWebPage(web, record)).html, selector);
  writeFileSync(feature, "The delivered file changed.\n");
  const rejected = await postWebForm(web, previouslyPresented.path, previouslyPresented.values);
  expect(rejected.status).toBe(409);
  expect(await rejected.text()).toContain("Verify the task again");
  await web.monitor.reconcileAfterChange();
  const work = (await readWebPage(web, "/work")).html;
  expect(work).toContain("The delivered source changed");
  expect(work).toMatch(/Waiting for .*TSK-0/);
  expect(() => changeTaskQueue(root, { action: "start", reference: "TSK-1" })).toThrow(/Waiting for demo:TSK-0/);
  expect((await readWebPage(web, "/reviews")).html).not.toContain('data-record-id="demo:TSK-0"');
  changeTaskQueue(root, { action: "release", reference: "TSK-0" });
  verify();
  await web.monitor.reconcileAfterChange();
  const renewed = workflowForm((await readWebPage(web, record)).html, selector);
  expect((await postWebForm(web, renewed.path, renewed.values)).status).toBe(200);
});
