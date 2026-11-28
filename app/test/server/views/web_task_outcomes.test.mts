import { git, distribution } from "../../fixtures/adoption.mjs";
import { savePlanDraft } from "../../../src/core/tasks/planning/planning-operations.ts";
import { planIdentity } from "../../../src/core/tasks/planning/plan-model.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { readWebPage, postWebForm } from "../../fixtures/web.mjs";
import { breadcrumbLinks, parseDOM } from "../../fixtures/dom.mjs";
import { changeTaskQueue, readTaskQueue } from "../../../src/core/tasks/task-queue.ts";
import { readTaskDecisions } from "../../../src/core/tasks/task-decisions.ts";
import { spawnSync } from "node:child_process";
import { pendingFinalizationStatus } from "../../../src/core/git/finalization-requests.ts";
import { checkProvisionalPush, provisionalCommits } from "../../../src/core/git/commit-history.ts";
import { workflowWindows } from "../../../src/server/routes/workflow-window.ts";
import { Route } from "../../../src/server/routes/routes.ts";
import { recordWindowLimit } from "../../../src/server/routes/record-window.ts";
import { taskWorkflowServers, workflowForm, writeWorkflowTask } from "../../fixtures/task-workflow.mjs";

const servers = taskWorkflowServers();
let root: string;
beforeEach(() => {
  root = servers.project();
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

test("the Reviews arrows follow the rendered order from a task outcome across subproject charters", async () => {
  writeWorkflowTask(root, 0, "Approved");
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

test("plans advance through approval, ordered work, and separate outcome review while records remain browsable", async () => {
  writeWorkflowTask(root, 0, "Planned");
  writeWorkflowTask(root, 1, "Approved", "parent: demo:TSK-0\n");
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
  const approve = workflowForm(
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
  await web.monitor.reconcileAfterChange();
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
  const accept = workflowForm(acceptancePage, acceptanceForm);
  const accepted = await postWebForm(web, accept.path, accept.values);
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ redirect: "/reviews?scope=demo" });
  expect(ids(await read("/reviews"))).toEqual([]);
  expect((await read("/records/demo:TSK-1")).querySelector(".record-metadata")?.textContent).toContain("Accepted");
});

test("a revised implemented plan returns to Reviews, then needs new verification before outcome review", async () => {
  const path = writeWorkflowTask(root, 0, "Planned"),
    web = await servers.start(root);
  const approve = async () => {
    const action = workflowForm(
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
  await web.monitor.reconcileAfterChange();
  expect(await membership("/reviews")).toBe(1);
  writeFileSync(path, readFileSync(path, "utf8").replace("Human-readable outcome.", "Recover work after restart."));
  await web.monitor.reconcileAfterChange();
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
  await web.monitor.reconcileAfterChange();
  expect(await membership("/work")).toBe(0);
  expect(await membership("/reviews")).toBe(1);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("Recover work after restart.", "Recover work after interruption."),
  );
  expect(() =>
    changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Interruption recovery verified." }),
  ).toThrow(/revoked/);
  await web.monitor.reconcileAfterChange();
  expect(await membership("/plans")).toBe(0);
  expect(await membership("/reviews")).toBe(1);
  await approve();
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Interruption recovery verified." });
  await web.monitor.reconcileAfterChange();
  expect(await membership("/plans")).toBe(0);
  expect(await membership("/work")).toBe(0);
  expect(await membership("/reviews")).toBe(1);
});

test("browser acceptance during a merge resumes at a CLI handoff with the server stopped", async () => {
  const configHome = join(root, ".git/local-config");
  mkdirSync(configHome);
  // This fixture owns Git state, while the detached CLI may finish writing diagnostics after its Git work is done.
  writeFileSync(join(configHome, "config.toml"), "[logs]\ncli_max_bytes = 0\n");
  vi.stubEnv("WORKBENCH_CONFIG_HOME", configHome);
  const file = writeWorkflowTask(root, 0, "Approved"),
    branch = git(root, "branch", "--show-current");
  git(root, "add", "workbench/tasks");
  git(root, "commit", "-qm", "Approve the delivery");
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(file, readFileSync(file, "utf8") + "\n## Implementation account\n\nDelivered the feature.\n");
  writeFileSync(join(root, "feature.txt"), "Reviewed feature.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Deliver feature\n\nWorkbench-Provisional: true");
  const delivery = git(root, "rev-parse", "HEAD");
  git(root, "switch", "-qc", "related", base);
  writeFileSync(join(root, "related.txt"), "Reviewed related change.\n");
  git(root, "add", "related.txt");
  git(root, "commit", "-qm", "Prepare related change");
  git(root, "switch", "-q", branch);
  git(root, "merge", "--no-commit", "--no-ff", "related");
  changeTaskQueue(root, { action: "add", references: ["TSK-0"] });
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(root, {
    action: "implemented",
    reference: "TSK-0",
    detail: "Verified the feature and both merge sides.",
  });

  const web = await servers.start(root, { backgroundFinalization: true });
  const accept = workflowForm(
    (await readWebPage(web, "/records/demo:TSK-0")).html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])',
  );
  const accepted = await postWebForm(web, accept.path, accept.values);
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  expect(await accepted.json()).toMatchObject({ redirect: "/reviews?scope=demo" });
  await expect.poll(() => pendingFinalizationStatus(root), { timeout: 15000 }).toMatch(/active Git operation/);
  expect(readFileSync(file, "utf8")).toContain("status: Accepted");
  expect(git(root, "rev-parse", "HEAD")).toBe(delivery);
  await web.close();

  git(root, "add", "workbench/tasks");
  git(root, "commit", "-qm", "Retain accepted outcome");
  const tree = git(root, "rev-parse", "HEAD^{tree}"),
    working = git(root, "status", "--porcelain");
  const handoff = spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), "review", "finish-commit"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution },
  });
  expect(handoff.status, handoff.stderr).toBe(0);
  await expect
    .poll(() => ({ pending: pendingFinalizationStatus(root), provisional: provisionalCommits(root) }), {
      timeout: 15000,
    })
    .toEqual({ pending: undefined, provisional: [] });
  expect(git(root, "rev-parse", "HEAD^{tree}")).toBe(tree);
  expect(git(root, "status", "--porcelain")).toBe(working);
  expect(() => {
    checkProvisionalPush(root, delivery, base);
  }).toThrow(/Cannot push 1 provisional commit/);
}, 35000);

test("browser decisions bind approval to exact task versions and acceptance to verified work", async () => {
  const config = join(root, "workbench/config.toml");
  writeFileSync(config, readFileSync(config, "utf8") + "\n[review]\ntask_approvals=true\n");
  const path = writeWorkflowTask(root, 0, "Planned");
  const web = await servers.start(root);
  const page = await readWebPage(web, "/records/demo:TSK-0");
  const actions = parseDOM(page.html).window.document.querySelector('[aria-label="Task actions"]');
  expect([...(actions?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toEqual([
    "Approve plan",
  ]);
  const approve = workflowForm(
    page.html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Approved"])',
  );
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
  await web.monitor.reconcileAfterChange();
  const implemented = await readWebPage(web, "/records/demo:TSK-0");
  const footer = parseDOM(implemented.html).window.document.querySelector('[aria-label="Task actions"]');
  expect(footer).not.toBeNull();
  expect(footer?.textContent).not.toContain("Unit and browser checks passed.");
  const accept = workflowForm(
    implemented.html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])',
  );
  expect(accept.values.state).toBe("Accepted");
  expect((await postWebForm(web, accept.path, accept.values)).status).toBe(200);
  expect(readFileSync(path, "utf8")).toContain("status: Accepted");
  const historical = writeWorkflowTask(root, 1, "Accepted");
  const outcomeCards = async () => [
    ...parseDOM((await readWebPage(web, "/reviews")).html).window.document.querySelectorAll<HTMLElement>(
      '[data-task-group^="task:"] [data-record-id]',
    ),
  ];
  expect(await outcomeCards()).toHaveLength(0);

  writeFileSync(path, readFileSync(path, "utf8") + "\n## Implementation account\n\nClarified the delivered result.\n");
  await web.monitor.reconcileAfterChange();
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
  const renewal = workflowForm(revised.html, acceptanceForm);
  expect((await postWebForm(web, renewal.path, renewal.values)).status).toBe(200);
  expect(await outcomeCards()).toHaveLength(0);
  expect(readFileSync(path, "utf8")).toContain("status: Accepted");
  expect(readFileSync(historical, "utf8")).toContain("status: Accepted");
  const accepted = parseDOM((await readWebPage(web, "/records/demo:TSK-0")).html).window.document;
  expect(accepted.querySelector(".document-diff")).toBeNull();
  expect(accepted.querySelector("main")?.textContent).toContain("Clarified the delivered result.");

  writeFileSync(path, readFileSync(path, "utf8").replace("- [x] Verified.", "- [x] Verified recovery."));
  await web.monitor.reconcileAfterChange();
  const unverified = await readWebPage(web, "/records/demo:TSK-0");
  expect(unverified.html).toContain("The current delivery needs verification before it can be accepted.");
  expect(await outcomeCards()).toHaveLength(0);
  expect(parseDOM(unverified.html).window.document.querySelector(acceptanceForm)).toBeNull();

  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Verified recovery after interruption." });
  await web.monitor.reconcileAfterChange();
  const ready = (await outcomeCards())[0]?.querySelector("a[data-card-link]")?.getAttribute("href");
  if (!ready) throw new Error("Missing reverified outcome link");
  const rereview = await readWebPage(web, ready);
  const confirmation = workflowForm(rereview.html, acceptanceForm);
  expect((await postWebForm(web, confirmation.path, confirmation.values)).status).toBe(200);
  expect(await outcomeCards()).toHaveLength(0);

  const decisions = readTaskDecisions(root);
  writeFileSync(join(root, "implementation.ts"), "export const revised=true;\n");
  expect(await outcomeCards()).toHaveLength(0);
  expect(readTaskDecisions(root)).toEqual(decisions);
});

test("outcome review links a blocking prerequisite to its review or task page", async () => {
  writeWorkflowTask(root, 0, "Approved");
  writeWorkflowTask(root, 1, "Approved", "depends_on: [demo:TSK-0]\n");
  changeTaskQueue(root, { action: "add", references: ["TSK-0", "TSK-1"] });
  for (const reference of ["TSK-0", "TSK-1"]) {
    changeTaskQueue(root, { action: "start", reference });
    changeTaskQueue(root, { action: "implemented", reference, detail: "Delivery verified." });
  }
  const web = await servers.start(root);
  const outcome = 'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])';
  const dependent = "/records/demo:TSK-1?workflow=1";
  const taskActions = async () =>
    parseDOM((await readWebPage(web, dependent)).html).window.document.querySelector('[aria-label="Task actions"]');
  const link = (actions: Element | null | undefined) =>
    actions?.querySelector('.notice a[data-record-reference="demo:TSK-0"]')?.getAttribute("href");
  const actions = await taskActions();
  expect(actions?.querySelector(outcome)).toBeNull();
  expect(actions?.querySelector(".notice")?.textContent.trim()).toBe("Accept demo:TSK-0 first.");
  const review = link(actions);
  if (!review) throw new Error("Missing prerequisite review link");
  expect(new URL(review, web.url).searchParams.get("workflow")).toBe("1");

  changeTaskQueue(root, { action: "release", reference: "TSK-0" });
  await web.monitor.reconcileAfterChange();
  const record = link(await taskActions());
  if (!record) throw new Error("Missing prerequisite task link");
  expect(new URL(record, web.url).pathname).toBe("/records/demo:TSK-0");
  expect(new URL(record, web.url).searchParams.has("workflow")).toBe(false);
  expect(parseDOM((await readWebPage(web, record)).html).window.document.querySelector(outcome)).toBeNull();

  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Delivery reverified." });
  await web.monitor.reconcileAfterChange();
  const prerequisite = workflowForm((await readWebPage(web, review)).html, outcome);
  expect((await postWebForm(web, prerequisite.path, prerequisite.values)).status).toBe(200);
  const unblocked = workflowForm((await readWebPage(web, dependent)).html, outcome);
  expect((await postWebForm(web, unblocked.path, unblocked.values)).status).toBe(200);
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

test("incomplete task acceptance reports an actionable input error and preserves the record", async () => {
  const path = writeWorkflowTask(root, 0, "Approved");
  const contents = readFileSync(path, "utf8").replace("[x]", "[ ]");
  writeFileSync(path, contents);
  changeTaskQueue(root, { action: "add", references: ["TSK-0"] });
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Checked the candidate." });
  const web = await servers.start(root);
  const page = await readWebPage(web, "/records/demo:TSK-0");
  const accept = workflowForm(
    page.html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])',
  );
  const response = await postWebForm(web, accept.path, accept.values);
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("unchecked step");
  expect(readFileSync(path, "utf8")).toBe(contents);
});

test("outcome navigation stays in Reviews while record browsing includes numeric tasks and future plans", async () => {
  writeWorkflowTask(root, 0, "Approved");
  writeWorkflowTask(root, 1, "Planned");
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
  expect(document.querySelector<HTMLButtonElement>('button[aria-label="Previous review"]')?.disabled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('button[aria-label="Next review"]')?.disabled).toBe(true);
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

test("an unrelated provisional delivery leaves a finalized task discoverable", async () => {
  writeWorkflowTask(root, 0, "Accepted");
  git(root, "add", "workbench/tasks/TSK-00.md");
  git(root, "commit", "-qm", "Retain the accepted outcome");
  writeWorkflowTask(root, 1, "Accepted");
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
