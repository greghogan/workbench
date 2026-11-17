import { formatTimestamp } from "../../../src/server/presentation/date-time.ts";
import { parseProseRecord } from "../../../src/core/records/record-document.ts";
import { git, distribution } from "../../fixtures/adoption.mjs";
import {
  configurePlanning,
  approvePlanDraft,
  checkpointPlans,
  savePlanDraft,
} from "../../../src/core/tasks/planning/planning-operations.ts";
import { gitBytes, updatedReviewTree, writeReviewBlobs } from "../../../src/core/git/git-snapshot.ts";
import { workspaceSchemaVersion } from "../../../src/core/projects/project-model.ts";
import { planIdentity, planPrefix, planningPaths } from "../../../src/core/tasks/planning/plan-model.ts";
import { readPlan } from "../../../src/core/tasks/planning/planning-store.ts";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { webServers, readWebPage, postWebForm } from "../../fixtures/web.mjs";
import { breadcrumbLinks, parseDOM } from "../../fixtures/dom.mjs";
import { changeTaskQueue, readTaskQueue } from "../../../src/core/tasks/task-queue.ts";
import { changeWorkQueue } from "../../../src/core/tasks/planning/plan-transfer.ts";
import { readTaskDecisions } from "../../../src/core/tasks/task-decisions.ts";
import { formatDocument } from "../../../src/core/records/formatting.ts";
import { workflowWindows } from "../../../src/server/routes/workflow-window.ts";
import { Route } from "../../../src/server/routes/routes.ts";
import { recordWindowLimit } from "../../../src/server/routes/record-window.ts";

const servers = webServers();
let root: string;
beforeEach(() => {
  root = servers.project();
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/local-state"));
  mkdirSync(join(root, "workbench/tasks"));
});

test("restored Reviews windows share the page's row limit", () => {
  const approvalCount = Math.floor(recordWindowLimit / 2);
  const approvals = Array.from({ length: approvalCount }, (_, index) => `approval-${String(index)}`);
  const outcomes = Array.from({ length: recordWindowLimit }, (_, index) => `outcome-${String(index)}`);
  const context = { scope: "demo", selection: "", all: false, revision: "same" };
  const page = (last: number) =>
    workflowWindows(
      context,
      {
        task_windows: JSON.stringify({ "workflow-approvals": approvals.at(-1), "workflow-reviews": outcomes[last] }),
      },
      Route.Reviews,
    );
  const id = (entry: string) => entry;

  const withinLimit = page(recordWindowLimit - approvalCount - 1);
  expect(
    withinLimit("approvals", approvals, id).visible.length + withinLimit("reviews", outcomes, id).visible.length,
  ).toBe(recordWindowLimit);

  const oversized = page(recordWindowLimit - approvalCount);
  expect(oversized("approvals", approvals, id).visible).toHaveLength(approvalCount);
  expect(() => oversized("reviews", outcomes, id)).toThrow(/exceeds its limit/);
});

function task(number: number, status: string, fields = "") {
  const path = join(root, `workbench/tasks/TSK-${number.toString(36).toUpperCase().padStart(2, "0")}.md`);
  writeFileSync(
    path,
    `---\nstatus: ${status}\n${fields}---\n\n# TSK-${number.toString(36).toUpperCase()}: Work ${String(number)}\n\n## Overview\n\nHuman-readable outcome.\n\n## Details\n\n- [x] Verified.\n`,
  );
  return path;
}

test("the Reviews arrows follow the rendered order from a task outcome across subproject charters", async () => {
  task(0, "Approved");
  const config = join(root, "workbench/projects.toml");
  for (const id of ["api", "docs"]) {
    writeFileSync(config, readFileSync(config, "utf8") + `\n[[project]]\nid = "${id}"\npath = "${id}"\n`);
  }
  changeTaskQueue(root, { action: "add", references: ["demo:TSK-0"] });
  changeTaskQueue(root, { action: "start", reference: "demo:TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "demo:TSK-0", detail: "Verified the workflow." });
  for (const id of ["api", "docs"]) {
    mkdirSync(join(root, id, "workbench"), { recursive: true });
    writeFileSync(join(root, id, "workbench/CHARTER.md"), `# Charter\n\nDescribe ${id}.\n`);
  }

  const web = await servers.start(root);
  const read = async (path: string) => parseDOM((await readWebPage(web, path)).html).window.document;
  const queue = await read("/reviews?scope=demo");
  const links = [...queue.querySelectorAll<HTMLAnchorElement>("[data-task-node] a[data-card-link]")].map(
    (link) => link.getAttribute("href") ?? "",
  );
  expect(links.map((href) => new URL(href, web.url).pathname)).toEqual([
    "/records/demo:TSK-0",
    "/records/api:CHARTER/review",
    "/records/docs:CHARTER/review",
  ]);
  for (const [index, href] of links.entries()) {
    const current = new URL(href, web.url);
    current.searchParams.set("layout", "split");
    const pane = (await read(current.pathname + current.search)).querySelector(".record-pane");
    for (const [rel, offset, name] of [
      ["prev", -1, "Previous"],
      ["next", 1, "Next"],
    ] as const) {
      const link = pane?.querySelector(`a[rel="${rel}"]`)?.getAttribute("href");
      const neighbor = links[index + offset];
      if (neighbor) {
        expect(link).toBeDefined();
        const expected = new URL(neighbor, web.url),
          actual = new URL(link ?? "", web.url);
        expected.searchParams.set("layout", "split");
        expect(actual.pathname).toBe(expected.pathname);
        expect(Object.fromEntries(actual.searchParams)).toEqual(Object.fromEntries(expected.searchParams));
      } else expect(pane?.querySelector(`button:disabled[aria-label="${name} review"]`)).not.toBeNull();
    }
  }
});

function form(html: string, selector: string): { path: string; values: Record<string, string> } {
  const document = parseDOM(html).window.document;
  const selected = document.querySelector<HTMLFormElement>(selector);
  if (!selected) throw new Error(`Missing form: ${selector}`);
  const values = Object.fromEntries(
    [...selected.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [input.name, input.value]),
  );
  return { path: selected.getAttribute("action") ?? "", values };
}

test.each([false, true])(
  "review preparation formats the selected plan, preserves navigation, and rejects stale versions (saved=%s)",
  async (saved) => {
    const config = join(root, "workbench/config.toml");
    writeFileSync(config, readFileSync(config, "utf8").replace("wrap_width=120", "wrap_width=60"));
    const contents =
      "---\nstatus: Planned\n---\n\n# " +
      (saved ? "Service plan" : "TSK-0: Service plan") +
      "\n\n" +
      "Preserve existing user work while installing and restarting the service. ".repeat(8).trim() +
      "\n";
    const identity = planIdentity("demo", "service"),
      path = join(root, "workbench/tasks/TSK-00.md");
    if (saved) savePlanDraft(root, identity, contents);
    else writeFileSync(path, contents);
    const page = saved
      ? "/plans/demo:plan%2Fservice?layout=split&scope=demo"
      : "/records/demo:TSK-0?layout=split&workflow=1&scope=demo";
    const current = () => (saved ? readPlan(root, identity).contents : readFileSync(path, "utf8"));
    const original = current(),
      staged = git(root, "write-tree"),
      head = git(root, "rev-parse", "HEAD"),
      web = await servers.start(root);
    let viewed = await readWebPage(web, page);
    const preparation = parseDOM(viewed.html).window.document;
    expect(preparation.querySelector("form[data-review-prepare]")).not.toBeNull();
    if (saved) {
      expect(preparation.querySelector("article.document")?.textContent).toContain(
        "Preserve existing user work while installing and restarting the service.",
      );
      expect(preparation.querySelector('form[action$="/actions/plan-approve"]')).toBeNull();
    }
    expect(breadcrumbLinks(preparation)).toEqual([
      ["demo", "/?scope=demo"],
      ["Plans", "/plans?scope=demo"],
    ]);
    expect(current()).toBe(original);
    const stale = form(viewed.html, "form[data-review-prepare]");
    const later = original + "\nPreserve user preferences too.\n";
    if (saved) savePlanDraft(root, identity, later, { expected: readPlan(root, identity).digest });
    else writeFileSync(path, later);
    expect((await postWebForm(web, stale.path, stale.values)).status).toBe(409);
    expect(current()).toBe(later);
    viewed = await readWebPage(web, page);
    const prepare = form(viewed.html, "form[data-review-prepare]");
    const response = await postWebForm(web, prepare.path, prepare.values);
    expect(response.status, await response.clone().text()).toBe(200);
    const next = new URL(((await response.json()) as { redirect: string }).redirect, web.url);
    expect(next.searchParams.get("layout")).toBe("split");
    expect(next.searchParams.get("scope")).toBe("demo");
    expect(current()).toBe(await formatDocument(later, "plan.md", 60));
    const ready = parseDOM((await readWebPage(web, next.pathname + next.search)).html).window.document;
    expect(breadcrumbLinks(ready)).toEqual([
      ["demo", "/?scope=demo"],
      ["Plans", "/plans?scope=demo"],
    ]);
    expect(ready.querySelector("form[data-review-prepare]")).toBeNull();
    expect(
      ready.querySelector(saved ? 'form[action$="/actions/plan-approve"]' : 'form[action$="/actions/task-state"]'),
    ).not.toBeNull();
    expect(git(root, "write-tree")).toBe(staged);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  },
);

test("plans advance through approval, ordered work, and separate outcome review while records remain browsable", async () => {
  task(0, "Planned");
  task(1, "Approved", "parent: demo:TSK-0\n");
  const web = await servers.start(root);
  const read = async (path: string) => parseDOM((await readWebPage(web, path)).html).window.document;
  const ids = (document: Document) =>
    [...document.querySelectorAll("[data-task-node]")].map((node) => node.getAttribute("data-task-node"));
  const counts = (document: Document) =>
    [...document.querySelectorAll(".nav-group:first-child .nav-count")].map((node) => Number(node.textContent));
  expect(ids(await read("/plans"))).toEqual(["demo:TSK-0"]);
  expect(ids(await read("/work"))).toEqual([]);
  expect(counts(await read("/reviews"))).toEqual([1, 0, 0]);
  const parent = await read("/records/demo:TSK-0");
  const child = parent.querySelector<HTMLAnchorElement>(
    '[aria-label="Subtasks"] a[data-record-reference="demo:TSK-1"]',
  );
  expect(child?.textContent).toContain("Work 1");
  expect(child?.dataset.recordTitle).toContain("Work 1");
  expect(child?.dataset.recordSummary).toContain("Human-readable outcome");
  const approve = form(
    (await readWebPage(web, "/records/demo:TSK-0")).html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Approved"])',
  );
  const approved = await postWebForm(web, approve.path, approve.values);
  expect(approved.status).toBe(200);
  expect(await approved.json()).toMatchObject({ redirect: "/work?scope=demo" });
  expect(ids(await read("/plans"))).toEqual([]);
  expect(ids(await read("/work"))).toEqual(["demo:TSK-0"]);
  changeTaskQueue(root, { action: "add", references: ["TSK-1"] });
  changeTaskQueue(root, { action: "start", reference: "TSK-1" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-1", detail: "Verified the child outcome." });
  expect(ids(await read("/work"))).toEqual(["demo:TSK-0"]);
  const outcome = await read("/reviews");
  expect(ids(outcome)).toEqual(["demo:TSK-1"]);
  expect(outcome.querySelector('[data-record-id="demo:TSK-1"] .badge.pending')?.textContent).toBe(
    "Awaiting acceptance",
  );
  expect(counts(await read("/reviews"))).toEqual([0, 1, 1]);
  const acceptancePage = (await readWebPage(web, "/records/demo:TSK-1")).html;
  const acceptanceForm = 'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])';
  expect(parseDOM(acceptancePage).window.document.querySelector(acceptanceForm + " button")?.textContent).toBe(
    "Accept outcome",
  );
  const accept = form(acceptancePage, acceptanceForm);
  const accepted = await postWebForm(web, accept.path, accept.values);
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ redirect: "/reviews?scope=demo" });
  expect(ids(await read("/reviews"))).toEqual([]);
  expect((await read("/records/demo:TSK-1")).querySelector(".record-metadata")?.textContent).toContain("Accepted");
});

test("a revised implemented plan returns to Reviews, then needs new verification before outcome review", async () => {
  const path = task(0, "Planned"),
    web = await servers.start(root);
  const approve = async () => {
    const action = form(
      (await readWebPage(web, "/records/demo:TSK-0")).html,
      'form[action$="/actions/task-state"]:has(input[name="state"][value="Approved"])',
    );
    const result = await postWebForm(web, action.path, action.values);
    expect(result.status).toBe(200);
    return result.json() as Promise<{ redirect: string }>;
  };
  const membership = async (location: string) =>
    parseDOM((await readWebPage(web, location)).html).window.document.querySelectorAll('[data-task-node="demo:TSK-0"]')
      .length;
  await approve();
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "First outcome verified." });
  expect(await membership("/reviews")).toBe(1);
  writeFileSync(path, readFileSync(path, "utf8").replace("Human-readable outcome.", "Recover work after restart."));
  expect(await membership("/plans")).toBe(0);
  expect(await membership("/work")).toBe(0);
  expect(await membership("/reviews")).toBe(1);
  expect(readTaskQueue(root).entries.map(({ reference }) => reference)).toEqual(["demo:TSK-0"]);
  const approvalBadge = parseDOM((await readWebPage(web, "/records?type=TSK")).html).window.document.querySelector(
    '[data-task-node="demo:TSK-0"] a.badge.pending',
  );
  expect(approvalBadge?.textContent).toBe("Awaiting approval");
  const approvalLocation = approvalBadge?.getAttribute("href");
  if (!approvalLocation) throw new Error("Missing revised-plan link");
  const approvalDocument = parseDOM((await readWebPage(web, approvalLocation)).html).window.document;
  expect(breadcrumbLinks(approvalDocument)).toContainEqual(["Reviews", "/reviews?scope=demo"]);
  await approve();
  expect(await membership("/plans")).toBe(0);
  expect(await membership("/work")).toBe(1);
  expect(await membership("/reviews")).toBe(0);
  expect((await readWebPage(web, "/work")).html).toContain("Ready to resume");
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Revised recovery verified." });
  expect(await membership("/work")).toBe(0);
  expect(await membership("/reviews")).toBe(1);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("Recover work after restart.", "Recover work after interruption."),
  );
  expect(() =>
    changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Interruption recovery verified." }),
  ).toThrow(/revoked/);
  expect(await membership("/plans")).toBe(0);
  expect(await membership("/reviews")).toBe(1);
  await approve();
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Interruption recovery verified." });
  expect(await membership("/plans")).toBe(0);
  expect(await membership("/work")).toBe(0);
  expect(await membership("/reviews")).toBe(1);
});

test("browser decisions bind approval to exact task versions and acceptance to verified work", async () => {
  const config = join(root, "workbench/config.toml");
  writeFileSync(config, readFileSync(config, "utf8") + "\n[review]\ntask_approvals=true\n");
  const path = task(0, "Planned");
  const web = await servers.start(root);
  const page = await readWebPage(web, "/records/demo:TSK-0");
  const actions = parseDOM(page.html).window.document.querySelector('[aria-label="Task actions"]');
  expect([...(actions?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toEqual([
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
  expect(readTaskQueue(root).entries.map((entry) => [entry.reference, entry.state])).toEqual([
    ["demo:TSK-0", "Queued"],
  ]);
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Unit and browser checks passed." });
  const implemented = await readWebPage(web, "/records/demo:TSK-0");
  const footer = parseDOM(implemented.html).window.document.querySelector('[aria-label="Task actions"]');
  expect(footer).not.toBeNull();
  expect(footer?.textContent).not.toContain("Unit and browser checks passed.");
  const accept = form(
    implemented.html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])',
  );
  expect(accept.values.state).toBe("Accepted");
  expect((await postWebForm(web, accept.path, accept.values)).status).toBe(200);
  expect(readFileSync(path, "utf8")).toContain("status: Accepted");
  const historical = task(1, "Accepted");
  const outcomeCards = async () => [
    ...parseDOM((await readWebPage(web, "/reviews")).html).window.document.querySelectorAll<HTMLElement>(
      '[data-task-group^="task:"] [data-record-id]',
    ),
  ];
  expect(await outcomeCards()).toHaveLength(0);

  writeFileSync(path, readFileSync(path, "utf8") + "\n## Implementation account\n\nClarified the delivered result.\n");
  const outcomes = await outcomeCards();
  expect(outcomes.map((card) => card.dataset.recordId)).toEqual(["demo:TSK-0"]);
  expect(outcomes[0]?.querySelector(".badge.pending")?.textContent).toBe("Awaiting acceptance");
  const outcomeLink = outcomes[0]?.querySelector<HTMLAnchorElement>("a[data-card-link]")?.getAttribute("href");
  if (!outcomeLink) throw new Error("Missing outcome review link");
  const revised = await readWebPage(web, outcomeLink);
  const acceptanceForm = 'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])';
  expect(parseDOM(revised.html).window.document.querySelector(acceptanceForm + " button")?.textContent).toBe(
    "Accept outcome",
  );
  const renewal = form(revised.html, acceptanceForm);
  expect((await postWebForm(web, renewal.path, renewal.values)).status).toBe(200);
  expect(await outcomeCards()).toHaveLength(0);
  expect(readFileSync(path, "utf8")).toContain("status: Accepted");
  expect(readFileSync(historical, "utf8")).toContain("status: Accepted");
  const accepted = parseDOM((await readWebPage(web, "/records/demo:TSK-0")).html).window.document;
  expect(accepted.querySelector(".document-diff")).toBeNull();
  expect(accepted.querySelector("main")?.textContent).toContain("Clarified the delivered result.");

  const decisions = readTaskDecisions(root);
  writeFileSync(join(root, "implementation.ts"), "export const revised=true;\n");
  expect(await outcomeCards()).toHaveLength(0);
  expect(readTaskDecisions(root)).toEqual(decisions);
});

test("queue view reorders accessibly, rejects stale actions, and observes external queue changes", async () => {
  task(0, "Approved");
  task(1, "Approved", "parent: demo:TSK-0\n");
  const third = task(2, "Approved");
  changeTaskQueue(root, { action: "add", references: ["TSK-0", "TSK-1", "TSK-2"] });
  const web = await servers.start(root, { pollInterval: 50 });
  const plans = parseDOM((await readWebPage(web, "/records?type=TSK")).html).window.document;
  expect(plans.querySelector('[data-task-branch="demo:TSK-0"] [data-task-node="demo:TSK-1"]')).not.toBeNull();
  const before = readFileSync(join(root, "workbench/tasks/TSK-01.md"), "utf8");
  const page = await readWebPage(web, "/work");
  const document = parseDOM(page.html).window.document;
  const queueForm = form(page.html, 'form:has(input[name="operation"][value="move-after"])'),
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
  const move = form(page.html, '.task-queue > li form:has(input[name="operation"][value="move-after"])');
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
  const active = await readWebPage(web, "/work", false);
  expect(active.html).toContain("Implementing");
  expect(active.html).not.toContain("Remove from queue");
  changeTaskQueue(root, { action: "remove", reference: "TSK-2" });
  expect(readTaskQueue(root).entries.map((entry) => entry.reference)).toEqual(["demo:TSK-1", "demo:TSK-0"]);
  expect(readFileSync(third, "utf8")).toContain("status: Approved");
});

test("an experiment and its evidence are found through the Experiments record list", async () => {
  const evidence = "workbench/experiments/EXP-00/observations.md";
  mkdirSync(join(root, "workbench/experiments/EXP-00"), { recursive: true });
  writeFileSync(
    join(root, "workbench/experiments/EXP-00.md"),
    "---\nstatus: Planned\nenvironment: null\n---\n\n# EXP-0: Compare alternatives\n",
  );
  writeFileSync(join(root, evidence), "# Observations\n\nNotes from the trial.\n");
  const web = await servers.start(root);
  const read = async (href: string) => parseDOM((await readWebPage(web, href)).html).window.document;
  expect((await read("/work")).querySelector('[data-record-id="demo:EXP-0"]')).toBeNull();
  const experiments = await read("/records?type=EXP");
  const recordHref = experiments.querySelector('[data-record-id="demo:EXP-0"] a[data-card-link]')?.getAttribute("href");
  if (!recordHref) throw new Error("Missing experiment link in Experiments");
  const experiment = await read(recordHref);
  expect(breadcrumbLinks(experiment)).toEqual([
    ["demo", "/?scope=demo"],
    ["Experiments", "/records?type=EXP&scope=demo"],
  ]);
  const evidenceHref = [...experiment.querySelectorAll("main a")]
    .find((link) => link.textContent.trim().startsWith("observations.md"))
    ?.getAttribute("href");
  if (!evidenceHref) throw new Error("Missing experiment evidence link");
  const document = await read(evidenceHref);
  expect(document.querySelector("h1")?.textContent).toBe("observations.md");
  expect(breadcrumbLinks(document).slice(0, 3)).toEqual([
    ["demo", "/?scope=demo"],
    ["Experiments", "/records?type=EXP&scope=demo"],
    ["EXP-0: Compare alternatives", "/records/demo:EXP-0?scope=demo"],
  ]);
});

test("unapproved plans appear by Added date without execution queue controls or implicit approval", async () => {
  const identity = planIdentity("demo", "service");
  savePlanDraft(
    root,
    identity,
    "---\nstatus: Planned\nadded_at: 2026-01-02T00:00:00.000Z\n---\n\n# Background service\n\n## Decisions\n\nWhich service manager?\n\n## Review summary\n\nInstall for the current user.\n",
  );
  savePlanDraft(
    root,
    planIdentity("demo", "earlier"),
    "---\nstatus: Planned\nadded_at: 2026-01-01T00:00:00.000Z\n---\n\n# Earlier idea\n\nConsider this first.\n",
  );
  const web = await servers.start(root);
  const page = await readWebPage(web, "/plans"),
    document = parseDOM(page.html).window.document;
  expect(document.querySelector("main")?.textContent).toContain("Background service");
  expect(document.querySelector('[data-task-node="demo:plan/service"] article')?.textContent).toContain(
    "Install for the current user.",
  );
  expect(document.querySelector("main")?.textContent).not.toContain("Which service manager?");
  expect(
    [...document.querySelectorAll("main [data-task-node]")].map((node) => node.getAttribute("data-task-node")),
  ).toEqual(["demo:plan/earlier", identity.reference]);
  expect((await readWebPage(web, "/work")).html).not.toContain("Background service");
  expect(document.querySelector("main form")).toBeNull();
  expect(readTaskQueue(root).entries).toEqual([]);
  const plan = readPlan(root, identity);
  expect(plan.document?.metadata.status).toBe("Planned");
  expect(plan.approval).toBeUndefined();
  expect((await readWebPage(web, "/plans")).html).toContain("Background service");
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

test("plans retain ancestry while Work shows the selected execution queue", async () => {
  task(0, "Planned");
  task(1, "Planned", "parent: demo:TSK-0\n");
  task(2, "Planned", "parent: demo:TSK-1\n");
  task(3, "Planned");
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
  task(0, "Approved");
  task(1, "Approved", "parent: demo:TSK-0\n");
  const revised = parseDOM((await readWebPage(web, "/work")).html).window.document;
  expect(revised.querySelector("[data-task-node]")).toBeNull();
  changeTaskQueue(root, { action: "add", references: ["TSK-1"] });
  const scheduled = parseDOM((await readWebPage(web, "/work")).html).window.document;
  expect(scheduled.querySelector('.task-queue > [data-task-node="demo:TSK-1"]')).not.toBeNull();
  const child = parseDOM((await readWebPage(web, "/plans")).html).window.document.querySelector(
    '[data-task-node="demo:TSK-2"]',
  );
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
  changeTaskQueue(root, { action: "add", references: ["TSK-0"] });
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Checked the candidate." });
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
  task(236, "Approved");
  expect((await readWebPage(web, more)).response.status).toBe(409);
});

test("task approval diffs show the retained plan and reject supporting files changed after inspection", async () => {
  const config = join(root, "workbench/config.toml");
  writeFileSync(config, readFileSync(config, "utf8") + "\n[review]\ntask_approvals=true\n");
  const path = task(0, "Planned"),
    supporting = join(root, "workbench/tasks/TSK-00/requirements.txt");
  const originalImage = "![Initial layout](TSK-00/initial.svg)";
  const initialSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 16"><title>Initial layout</title></svg>';
  const originalPath = join(root, "workbench/tasks/TSK-00/initial.svg");
  mkdirSync(join(root, "workbench/tasks/TSK-00"));
  writeFileSync(originalPath, initialSvg);
  writeFileSync(supporting, "User service.\n");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("[x]", "[ ]") + "\n## Implementation account\n\n" + originalImage + "\n",
  );
  const web = await servers.start(root),
    page = "/records/demo:TSK-0";
  const initialPage = await readWebPage(web, page);
  expect(
    parseDOM(initialPage.html).window.document.querySelector('.document img[alt="Initial layout"]'),
  ).not.toBeNull();
  let approve = form(
    initialPage.html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Approved"])',
  );
  expect((await postWebForm(web, approve.path, approve.values)).status).toBe(200);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("Human-readable outcome.", "Automatic recovery after restart."),
  );
  let viewed = await readWebPage(web, page);
  expect(viewed.response.status).toBe(200);
  let document = parseDOM(viewed.html).window.document;
  expect(document.querySelector(".document-diff del")?.textContent).toContain("Human-readable");
  expect(document.querySelector(".document-diff ins")?.textContent).toContain("Automatic");
  expect(document.querySelector('[aria-label="Record views"]')).toBeNull();
  expect(document.querySelector('[aria-label="Difference layout"] [aria-current]')?.textContent).toBe("Unified");
  const split = parseDOM((await readWebPage(web, page + "?layout=split")).html).window.document;
  expect(split.querySelector(".document-diff.split")).not.toBeNull();
  expect(split.querySelector('[aria-label="Difference layout"] [aria-current]')?.textContent).toBe("Side-by-side");
  expect(
    parseDOM((await readWebPage(web, "/reviews")).html).window.document.querySelector("main")?.textContent,
  ).toContain("Work 0");
  expect(
    parseDOM((await readWebPage(web, "/work")).html).window.document.querySelector("main")?.textContent,
  ).not.toContain("Work 0");
  approve = form(viewed.html, 'form[action$="/actions/task-state"]:has(input[name="state"][value="Approved"])');
  writeFileSync(supporting, "System service.\n");
  expect((await postWebForm(web, approve.path, approve.values)).status).toBe(409);
  const image = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 16"><title>Recovery layout</title></svg>';
  rmSync(originalPath);
  writeFileSync(join(root, "workbench/tasks/TSK-00/recovery.svg"), image);
  writeFileSync(path, readFileSync(path, "utf8").replace(originalImage, "![Recovery layout](TSK-00/recovery.svg)"));
  viewed = await readWebPage(web, page + "?view=changes");
  document = parseDOM(viewed.html).window.document;
  expect(document.querySelector('[aria-label="Supporting file changes"]')?.textContent).toContain(
    "requirements.txt: changed",
  );
  const imageURL = document.querySelector('.document-diff ins img[alt="Recovery layout"]')?.getAttribute("src");
  if (!imageURL) throw new Error("The plan comparison omitted its wireframe");
  const preview = await readWebPage(web, imageURL, false);
  expect(preview.response.status).toBe(200);
  expect(preview.response.headers.get("content-type")).toBe("image/svg+xml");
  expect(preview.response.headers.get("content-security-policy")).toContain("sandbox; default-src 'none'");
  expect(preview.html).toBe(image);
  const removedURL = document.querySelector('.document-diff del img[alt="Initial layout"]')?.getAttribute("src");
  if (!removedURL) throw new Error("The plan comparison omitted the removed wireframe");
  const removed = await readWebPage(web, removedURL, false);
  expect(removed.response.status).toBe(200);
  expect(removed.html).toBe(initialSvg);
  const unowned = new URL(removedURL, web.url);
  unowned.searchParams.set("path", "workbench/unowned.svg");
  writeFileSync(join(root, "workbench/unowned.svg"), initialSvg);
  expect((await readWebPage(web, unowned.pathname + unowned.search)).response.status).toBe(404);
  const splitPlan = parseDOM((await readWebPage(web, page + "?layout=split")).html).window.document;
  expect(splitPlan.querySelector('[data-diff-side="before"] del img[alt="Initial layout"]')).not.toBeNull();
  expect(splitPlan.querySelector('[data-diff-side="after"] ins img[alt="Recovery layout"]')).not.toBeNull();
  approve = form(viewed.html, 'form[action$="/actions/task-state"]:has(input[name="state"][value="Approved"])');
  expect((await postWebForm(web, approve.path, approve.values)).status).toBe(200);
  expect(
    parseDOM((await readWebPage(web, "/reviews")).html).window.document.querySelector("main")?.textContent,
  ).not.toContain("Work 0");
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  writeFileSync(path, readFileSync(path, "utf8").replace("[ ]", "[x]") + "\nRecovery is delivered.\n");
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Recovery verified." });
  const outcome = parseDOM((await readWebPage(web, page)).html).window.document;
  expect(outcome.querySelector(".document-diff ins")?.textContent).toBeTruthy();
  expect(outcome.querySelector(".document-diff")?.textContent).toContain("Recovery is delivered.");
  expect(outcome.querySelector('input[name="state"][value="Approved"]')).toBeNull();
  expect(outcome.querySelector('input[name="state"][value="Accepted"]')).not.toBeNull();
  const accept = form(
    (await readWebPage(web, page)).html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])',
  );
  expect((await postWebForm(web, accept.path, accept.values)).status).toBe(200);
  writeFileSync(path, readFileSync(path, "utf8") + "\nRenewed verification adds a restart check.\n");
  const renewal = parseDOM((await readWebPage(web, page)).html).window.document;
  const added = [...renewal.querySelectorAll(".document-diff ins")].map((node) => node.textContent).join(" ");
  expect(added).toContain("Renewed verification");
  expect(added).not.toContain("Recovery is delivered");
  expect(renewal.querySelector(".document-diff del img")).toBeNull();
  const reopen = form(
    (await readWebPage(web, page)).html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Planned"])',
  );
  expect((await postWebForm(web, reopen.path, reopen.values)).status).toBe(200);
  const reopened = parseDOM((await readWebPage(web, page)).html).window.document;
  expect([...reopened.querySelectorAll(".document-diff ins")].map((node) => node.textContent).join(" ")).toContain(
    "Renewed verification",
  );
  expect(reopened.querySelector('input[name="state"][value="Approved"]')).not.toBeNull();
});

test("named plans remain durable drafts through browser editing, approval diffs, and local queue selection", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  configurePlanning(root, { branch: "future", auto_prune: true });
  const initial = git(root, "rev-parse", "HEAD");
  const contents = "---\nstatus: Planned\n---\n\n# Background service\n\nInstall for the current user.\n";
  savePlanDraft(root, planIdentity("demo", "service"), contents);
  const web = await servers.start(root);
  expect((await readWebPage(web, "/plan/new")).response.status).toBe(404);
  let saved = readPlan(root, planIdentity("demo", "service"));
  expect(parseProseRecord(saved.contents, "saved plan").body).toBe(parseProseRecord(contents, "input plan").body);
  const added = saved.document?.metadata.added_at;
  expect(added).toBeDefined();
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
  const decisions = parseDOM(viewed.html).window.document.querySelector(".task-primary-action");
  expect([...(decisions?.querySelectorAll("a, button") ?? [])].map((control) => control.textContent)).toEqual([
    "Approve plan",
  ]);
  const secondary = parseDOM(viewed.html).window.document.querySelector('[aria-label="Plan actions"] details');
  expect(secondary?.hasAttribute("open")).toBe(false);
  expect(secondary?.querySelector(".task-show-actions")?.textContent).toBe("Show plan actions");
  expect([...(secondary?.querySelectorAll("a") ?? [])].map((control) => control.textContent)).toEqual([
    "Delete plan",
    "Cancel plan",
  ]);
  expect(decisions?.querySelector("button")?.classList.contains("secondary")).toBe(false);
  const addedTag = parseDOM(viewed.html).window.document.querySelector(".record-location time");
  expect(addedTag?.getAttribute("datetime")).toBe(added);
  expect(addedTag?.textContent).toBe(formatTimestamp(String(added)));
  let approve = form(viewed.html, 'form[action$="/actions/plan-approve"]');
  for (const retired of ["/actions/plan-create", "/actions/plan-checkpoint"])
    expect((await postWebForm(web, retired, approve.values)).status).toBe(404);
  const approved = await postWebForm(web, approve.path, approve.values);
  expect(approved.status).toBe(200);
  const { redirect } = (await approved.json()) as { redirect: string };
  expect(new URL(redirect, web.url).pathname).toBe("/work");
  const work = parseDOM((await readWebPage(web, redirect, false)).html).window.document;
  expect(work.querySelector("main")?.textContent).toContain("Background service");
  expect(git(root, "rev-list", "--count", "future")).toBe("1");
  expect(git(root, "rev-parse", "HEAD")).toBe(initial);
  let queue = parseDOM((await readWebPage(web, "/plans")).html).window.document;
  expect(queue.querySelector("main")?.textContent).not.toContain("Background service");
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
  queue = parseDOM((await readWebPage(web, "/work")).html).window.document;
  expect(queue.querySelector("main")?.textContent).toContain("Background service");
  const editPage = (await readWebPage(web, page + "?view=edit")).html,
    rename = form(editPage, 'form[action$="/actions/plan-rename"]');
  expect((await postWebForm(web, rename.path, { ...rename.values, name: "background" })).status).toBe(200);
  expect(readTaskQueue(root).entries[0]?.reference).toBe("demo:plan/background");
  const movedPage = await readWebPage(web, "/plans/demo:plan%2Fbackground");
  const supportingLink = parseDOM(movedPage.html).window.document.querySelector<HTMLAnchorElement>(
    '.document a[href*="requirements.md"]',
  );
  const supportingAddress = new URL(supportingLink?.getAttribute("href") ?? "", web.url);
  expect(supportingAddress.pathname.endsWith("/files")).toBe(true);
  expect(supportingAddress.searchParams.get("path")).toBe("requirements.md");
  const supportingPage = await readWebPage(web, supportingAddress.pathname + supportingAddress.search);
  expect(supportingPage.response.status).toBe(200);
  const supportingDocument = parseDOM(supportingPage.html).window.document;
  expect(supportingDocument.querySelector('a.nav-item[aria-current="page"] > span')?.textContent).toBe("Work");
  expect(supportingDocument.querySelector('nav[aria-label="Breadcrumb"] a[href$="/work?scope=demo"]')).not.toBeNull();
  await changeWorkQueue(root, { action: "start", reference: "demo:plan/background" });
  expect(readTaskQueue(root).entries[0]?.reference).toBe("demo:TSK-0");
  expect(readFileSync(join(root, "workbench/tasks/TSK-00/requirements.md"), "utf8")).toContain("Preserve user data");
  const implemented = parseDOM((await readWebPage(web, "/records/demo:TSK-0")).html).window.document;
  expect(implemented.body.textContent).toContain("Background service");
  const sourceLink = implemented
    .querySelector<HTMLAnchorElement>('.document a[href*="requirements.md"]')
    ?.getAttribute("href");
  const sourceAddress = new URL(sourceLink ?? "", web.url);
  expect(sourceAddress.pathname).toBe("/records/demo:TSK-0/files");
  expect(sourceAddress.searchParams.get("path")).toBe("workbench/tasks/TSK-00/requirements.md");
  expect(sourceAddress.hash).toBe("#document-requirements");
  expect(git(root, "rev-parse", "HEAD")).toBe(initial);
});

test("named plan reviews display sandboxed SVGs from their saved and approved Git versions", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  configurePlanning(root, { branch: "future", auto_prune: false });
  const identity = planIdentity("demo", "layout");
  const contents = "---\nstatus: Planned\n---\n\n# Review layout\n\n![Service flow](files/flow.svg)\n";
  const svg = (text: string) =>
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20"><text y="12">${text}</text></svg>`);
  const before = svg("Previous flow");
  const after = svg("Current flow");
  savePlanDraft(root, identity, contents, { files: new Map([["flow.svg", { contents: before }]]) });
  approvePlanDraft(root, identity, readPlan(root, identity).digest, true);
  git(root, "switch", "-c", "independent-work");
  const approved = readPlan(root, identity);
  savePlanDraft(root, identity, approved.contents, {
    expected: approved.digest,
    files: new Map([["flow.svg", { contents: after }]]),
  });
  const web = await servers.start(root);
  const page = "/plans/demo:plan%2Flayout";
  const read = parseDOM((await readWebPage(web, page + "?view=read")).html).window.document;
  expect(read.querySelector('.document img[alt="Service flow"]')).not.toBeNull();
  const diffResponse = await readWebPage(web, page + "?view=changes&layout=split");
  expect(diffResponse.response.status).toBe(200);
  const diff = parseDOM(diffResponse.html).window.document;
  expect([...diff.querySelectorAll<HTMLImageElement>("main img")].map((entry) => entry.alt)).toContain(
    "Previous flow.svg",
  );
  const image = (selector: string) => {
    const src = diff.querySelector(selector)?.getAttribute("src");
    if (!src) throw new Error(`Missing plan image ${selector}`);
    return src;
  };
  const previous = image('[data-diff-side="before"] img[alt="Service flow"]');
  const current = image('[data-diff-side="after"] img[alt="Service flow"]');
  expect(previous).not.toBe(current);
  const unified = parseDOM((await readWebPage(web, page + "?view=changes")).html).window.document;
  expect(unified.querySelector('.document-diff del img[alt="Service flow"]')?.getAttribute("src")).toBe(previous);
  expect(unified.querySelector('.document-diff ins img[alt="Service flow"]')?.getAttribute("src")).toBe(current);
  for (const [address, expected] of [
    [previous, before],
    [current, after],
  ] as const) {
    const result = await readWebPage(web, address);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
    expect(result.response.headers.get("content-security-policy")).toContain("sandbox; default-src 'none'");
    expect(result.response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(result.html).toBe(expected.toString());
  }
  const stale = new URL(current, web.url);
  stale.searchParams.set("image", "0".repeat(40));
  expect((await readWebPage(web, stale.pathname + stale.search)).response.status).toBe(404);
  expect(git(root, "branch", "--show-current")).toBe("independent-work");
  expect(readPlan(root, identity).entries.get(planningPaths.files + "flow.svg")?.oid).toBe(
    new URL(current, web.url).searchParams.get("image"),
  );
});

test("workflow continuation preserves named-plan date order and rejects stale cursors", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  configurePlanning(root, { branch: "future", auto_prune: true });
  const identities = Array.from({ length: 102 }, (_, index) =>
      planIdentity("demo", "plan-" + String(index).padStart(3, "0")),
    ),
    contents = identities.map((_, index) =>
      Buffer.from(
        `---\nstatus: Planned\nadded_at: ${new Date(Date.UTC(2026, 0, 1, 0, 0, 101 - index)).toISOString()}\n---\n\n# Plan ${String(index)}\n`,
      ),
    ),
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
  const decision = join(root, "workbench/decisions/ADR-00.md");
  const original = readFileSync(decision, "utf8");
  writeFileSync(decision, original + "\nA first wording change.\n");
  const web = await servers.start(root),
    page = parseDOM((await readWebPage(web, "/plans")).html).window.document;
  const plans = page.querySelector('[data-task-window="workflow-plans"]');
  expect(plans?.querySelector("[data-task-node]")?.getAttribute("data-task-node")).toBe("demo:plan/plan-101");
  const firstIds = [...(plans?.querySelectorAll("[data-task-node]") ?? [])].map((node) =>
    node.getAttribute("data-task-node"),
  );
  expect(firstIds.length).toBeGreaterThan(0);
  expect(firstIds.length).toBeLessThan(102);
  const continuation = plans?.querySelector<HTMLAnchorElement>("[data-task-more]")?.getAttribute("href");
  if (!continuation) throw new Error("Missing workflow continuation");
  const next = parseDOM((await readWebPage(web, continuation)).html).window.document;
  const nextIds = [...next.querySelectorAll('[data-task-window="workflow-plans"] [data-task-node]')].map((node) =>
    node.getAttribute("data-task-node"),
  );
  expect(nextIds.length).toBeGreaterThan(0);
  expect([...firstIds, ...nextIds]).toHaveLength(102);
  expect(new Set([...firstIds, ...nextIds]).size).toBe(102);
  writeFileSync(decision, original + "\nA second wording change.\n");
  await readWebPage(web, "/reviews");
  expect((await readWebPage(web, continuation)).response.status).toBe(200);
  savePlanDraft(root, planIdentity("demo", "extra"), "---\nstatus: Planned\n---\n\n# New plan\n");
  expect((await readWebPage(web, continuation)).response.status).toBe(409);
});

test("browser cancellation retains its reason and deletion remains a durable draft for CLI checkpointing", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  configurePlanning(root, { branch: "future", auto_prune: true });
  const identity = planIdentity("demo", "discarded");
  savePlanDraft(root, identity, "---\nstatus: Planned\n---\n\n# An optional idea\n\nKeep the design available.\n");
  checkpointPlans(root);
  expect(readTaskQueue(root).entries).toEqual([]);
  const web = await servers.start(root),
    url = "/plans/demo:plan%2Fdiscarded";
  let page = await readWebPage(web, url);
  const read = parseDOM(page.html).window.document;
  expect(read.querySelector('textarea[name="reason"]')).toBeNull();
  const cancelLink = [...read.querySelectorAll<HTMLAnchorElement>("a")].find(
    (link) => link.textContent === "Cancel plan",
  );
  page = await readWebPage(web, cancelLink?.getAttribute("href") ?? "");
  const confirm = parseDOM(page.html).window.document;
  expect(breadcrumbLinks(confirm)).toEqual([
    ["demo", "/?scope=demo"],
    ["Plans", "/plans?scope=demo"],
    ["An optional idea", "/plans/demo:plan%2Fdiscarded?scope=demo"],
  ]);
  expect(confirm.querySelector('textarea[name="reason"]')?.hasAttribute("required")).toBe(false);
  expect(confirm.querySelector('form[action$="/actions/plan-approve"]')).toBeNull();
  const cancel = form(page.html, 'form[action$="/actions/plan-cancel"]');
  expect(
    (await postWebForm(web, cancel.path, { ...cancel.values, reason: "The idea is no longer needed." })).status,
  ).toBe(200);
  expect(readPlan(root, identity).contents).toContain("The idea is no longer needed.");
  expect(readTaskQueue(root).entries).toEqual([]);
  page = await readWebPage(web, url + "?view=delete");
  expect(parseDOM(page.html).window.document.querySelector('textarea[name="reason"]')).toBeNull();
  expect(parseDOM(page.html).window.document.querySelector('form[action$="/actions/plan-approve"]')).toBeNull();
  const remove = form(page.html, 'form[action$="/actions/plan-delete"]');
  expect((await postWebForm(web, remove.path, remove.values)).status).toBe(200);
  expect(() => readPlan(root, identity)).toThrow(/removed locally/);
  checkpointPlans(root);
  const final = (await readWebPage(web, "/work")).html;
  expect(final).not.toContain("An optional idea");
  expect(final).not.toContain("Checkpoint plans");
});

test("record search finds named-plan details beyond their metadata preview", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const identity = planIdentity("demo", "searchable"),
    contents =
      "---\nstatus: Planned\n---\n\n# Searchable service plan\n\n" +
      "Ordinary project context. ".repeat(60) +
      "\n\n## Recovery\n\nA unique recovery sentinel.\n";
  savePlanDraft(root, identity, contents);
  const web = await servers.start(root),
    search = form((await readWebPage(web, "/")).html, 'form[role="search"]'),
    parameters = new URLSearchParams({ ...search.values, q: "unique recovery sentinel", type: "TSK" }),
    page = await readWebPage(web, search.path + "?" + parameters.toString());
  expect(page.response.status).toBe(200);
  expect(parseDOM(page.html).window.document.querySelector("main")?.textContent).toContain("Searchable service plan");
});

test("browser reversion previews the affected work and stages an outcome requiring renewed verification", async () => {
  task(0, "Accepted");
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
  const reasonForm = form((await readWebPage(web, link)).html, 'form[method="get"]:has(textarea[name="reason"])'),
    destination = new URL(reasonForm.path, "http://workbench.invalid");
  destination.search = new URLSearchParams({
    ...reasonForm.values,
    reason: "The original approach is no longer wanted.",
  }).toString();
  const preview = (await readWebPage(web, destination.pathname + destination.search)).html,
    confirm = form(preview, 'form[action$="/actions/task-disposition"]');
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

test("outcome navigation stays in Reviews while record browsing includes numeric tasks and future plans", async () => {
  task(0, "Approved");
  task(1, "Planned");
  savePlanDraft(root, planIdentity("demo", "artifacts"), "---\nstatus: Planned\n---\n\n# Artifact delivery\n");
  savePlanDraft(root, planIdentity("demo", "service-tools"), "---\nstatus: Planned\n---\n\n# Service tools\n");
  changeTaskQueue(root, { action: "add", references: ["demo:TSK-0"] });
  changeTaskQueue(root, { action: "start", reference: "demo:TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "demo:TSK-0", detail: "Fixture outcome verified." });
  const web = await servers.start(root),
    workflow = parseDOM((await readWebPage(web, "/reviews")).html).window.document,
    outcome = workflow
      .querySelector<HTMLAnchorElement>('[data-task-group^="task:"] [data-record-id="demo:TSK-0"] a[data-card-link]')
      ?.getAttribute("href");
  if (!outcome) throw new Error("Missing task outcome link");
  const first = await readWebPage(web, outcome),
    document = parseDOM(first.html).window.document;
  expect(first.response.status).toBe(200);
  expect(document.querySelector('button[aria-label="Previous record"]')?.hasAttribute("disabled")).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('button[aria-label="Next record"]')?.disabled).toBe(true);
  expect(document.querySelector('a.nav-item[aria-current="page"] > span')?.textContent).toBe("Reviews");
  const ordinary = parseDOM((await readWebPage(web, "/records/demo:TSK-1")).html).window.document;
  const next = ordinary.querySelector<HTMLAnchorElement>('a[rel="next"]')?.getAttribute("href");
  if (!next) throw new Error("Missing next numeric task");
  const second = await readWebPage(web, next);
  expect(new URL(next, web.url).pathname).toBe("/records/demo:TSK-0");
  expect(second.response.status).toBe(200);
  const secondDocument = parseDOM(second.html).window.document,
    previous = secondDocument.querySelector<HTMLAnchorElement>('a[rel="prev"]')?.getAttribute("href"),
    planned = secondDocument.querySelector<HTMLAnchorElement>('a[rel="next"]')?.getAttribute("href");
  expect(new URL(previous ?? "", web.url).pathname).toBe("/records/demo:TSK-1");
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
  expect((await readWebPage(web, "/plans")).html).toContain("A future design");
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

test("task cancellation is explicit and optional, and cannot cancel accepted or active work", async () => {
  const path = task(0, "Approved");
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
  const cancel = form(page.html, 'form[action$="/actions/task-state"]');
  changeTaskQueue(root, { action: "add", references: ["TSK-0"] });
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  expect((await postWebForm(web, cancel.path, cancel.values)).status).toBe(409);
  changeTaskQueue(root, { action: "block", reference: "TSK-0", detail: "Stop for cancellation." });
  expect((await postWebForm(web, cancel.path, cancel.values)).status).toBe(200);
  expect(readFileSync(path, "utf8")).toContain("status: Canceled");
  expect(readFileSync(path, "utf8")).not.toContain("## Cancellation");
  task(1, "Accepted");
  page = await readWebPage(web, "/records/demo:TSK-1");
  expect(parseDOM(page.html).window.document.querySelector('a[href*="kind=cancel"]')).toBeNull();
  const reopen = form(page.html, 'form[action$="/actions/task-state"]:has(input[name="state"][value="Planned"])');
  expect((await postWebForm(web, reopen.path, { ...reopen.values, state: "Canceled" })).status).toBe(409);
});

test.for(["cancel-remove", "cancel-revert"] as const)(
  "canceling committed work with %s keeps its record and leaves the receiver unchanged",
  async (kind) => {
    const base = git(root, "rev-parse", "HEAD");
    const path = task(0, "Approved");
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
    const revise = form(details.html, 'form[action$="/actions/task-state"]:has(input[name="state"][value="Planned"])');
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
      const original = form(page.html, 'form[action$="/actions/task-disposition"]');
      expect((await postWebForm(web, original.path, { ...original.values, confirmPublished: "" })).status).toBe(409);
      git(root, "tag", "second-publication");
      git(root, "push", "-q", "fixture", "refs/tags/second-publication");
      expect((await postWebForm(web, original.path, original.values)).status).toBe(409);
      page = await preview();
      expect(page.html).toContain("fixture (endpoint 2)/tags/second-publication");
    }
    const confirm = form(page.html, 'form[action$="/actions/task-disposition"]');
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
  task(0, "Approved");
  task(1, "Approved", "depends_on: [demo:TSK-0]\n");
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
  const previouslyPresented = form((await readWebPage(web, record)).html, selector);
  writeFileSync(feature, "The delivered file changed.\n");
  const rejected = await postWebForm(web, previouslyPresented.path, previouslyPresented.values);
  expect(rejected.status).toBe(409);
  expect(await rejected.text()).toContain("Verify the task again");
  const work = (await readWebPage(web, "/work")).html;
  expect(work).toContain("The delivered source changed");
  expect(work).toMatch(/Waiting for .*TSK-0/);
  expect(() => changeTaskQueue(root, { action: "start", reference: "TSK-1" })).toThrow(/Waiting for demo:TSK-0/);
  expect((await readWebPage(web, "/reviews")).html).not.toContain('data-record-id="demo:TSK-0"');
  changeTaskQueue(root, { action: "release", reference: "TSK-0" });
  verify();
  const renewed = form((await readWebPage(web, record)).html, selector);
  expect((await postWebForm(web, renewed.path, renewed.values)).status).toBe(200);
});

test("an unrelated provisional delivery leaves a finalized task discoverable", async () => {
  task(0, "Accepted");
  git(root, "add", "workbench/tasks/TSK-00.md");
  git(root, "commit", "-qm", "Retain the accepted outcome");
  task(1, "Accepted");
  git(root, "add", "workbench/tasks/TSK-01.md");
  git(root, "commit", "-qm", "Retain provisional outcome\n\nWorkbench-Provisional: true");
  const web = await servers.start(root);
  const page = await readWebPage(web, "/records?type=TSK&status=Finalized");
  const finalized = parseDOM(page.html).window.document;
  expect(
    [...finalized.querySelectorAll("[data-record-id]")].map((item) => item.getAttribute("data-record-id")),
  ).toEqual(["demo:TSK-0"]);
  expect((await readWebPage(web, "/records/demo:TSK-1")).html).toContain('class="badge">Accepted</span>');
});
