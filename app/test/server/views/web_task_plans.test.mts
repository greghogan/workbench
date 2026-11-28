import { git, distribution } from "../../fixtures/adoption.mjs";
import {
  configurePlanning,
  checkpointPlans,
  savePlanDraft,
} from "../../../src/core/tasks/planning/planning-operations.ts";
import { gitBytes, updatedReviewTree, writeReviewBlobs } from "../../../src/core/git/git-snapshot.ts";
import { workspaceSchemaVersion } from "../../../src/core/projects/project-model.ts";
import { planIdentity, planPrefix, planningPaths } from "../../../src/core/tasks/planning/plan-model.ts";
import { readPlan } from "../../../src/core/tasks/planning/planning-store.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { readWebPage, postWebForm } from "../../fixtures/web.mjs";
import { breadcrumbLinks, parseDOM } from "../../fixtures/dom.mjs";
import { readTaskQueue } from "../../../src/core/tasks/task-queue.ts";
import { taskWorkflowServers, workflowForm, writeWorkflowTask } from "../../fixtures/task-workflow.mjs";

const servers = taskWorkflowServers();
let root: string;
beforeEach(() => {
  root = servers.project();
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
  await web.monitor.reconcileAfterChange();
  await readWebPage(web, "/reviews");
  expect((await readWebPage(web, continuation)).response.status).toBe(200);
  savePlanDraft(root, planIdentity("demo", "extra"), "---\nstatus: Planned\n---\n\n# New plan\n");
  await web.monitor.reconcileAfterChange();
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
  const cancel = workflowForm(page.html, 'form[action$="/actions/plan-cancel"]');
  expect(
    (await postWebForm(web, cancel.path, { ...cancel.values, reason: "The idea is no longer needed." })).status,
  ).toBe(200);
  expect(readPlan(root, identity).contents).toContain("The idea is no longer needed.");
  expect(readTaskQueue(root).entries).toEqual([]);
  page = await readWebPage(web, url + "?view=delete");
  expect(parseDOM(page.html).window.document.querySelector('textarea[name="reason"]')).toBeNull();
  expect(parseDOM(page.html).window.document.querySelector('form[action$="/actions/plan-approve"]')).toBeNull();
  const remove = workflowForm(page.html, 'form[action$="/actions/plan-delete"]');
  expect((await postWebForm(web, remove.path, remove.values)).status).toBe(200);
  expect(() => readPlan(root, identity)).toThrow(/removed locally/);
  checkpointPlans(root);
  const final = (await readWebPage(web, "/work")).html;
  expect(final).not.toContain("An optional idea");
  expect(final).not.toContain("Checkpoint plans");
});

test("named plans are searchable beyond their previews without inflating the Tasks record count", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  writeWorkflowTask(root, 0, "Planned");
  const contents =
    "---\nstatus: Planned\n---\n\n# Searchable service plan\n\n" +
    "Ordinary project context. ".repeat(60) +
    "\n\n## Recovery\n\nA unique recovery sentinel.\n";
  savePlanDraft(root, planIdentity("demo", "searchable"), contents);
  const web = await servers.start(root);
  const records = parseDOM((await readWebPage(web, "/records?type=TSK")).html).window.document;
  expect(records.querySelectorAll("main [data-record-id]").length).toBe(1);
  expect(records.querySelector('nav[aria-label="Main navigation"] a[href*="type=TSK"]')?.textContent).toMatch(
    /Tasks\s*1/,
  );
  expect((await readWebPage(web, "/plans")).html).toContain("Searchable service plan");
  const search = workflowForm((await readWebPage(web, "/")).html, 'form[role="search"]');
  expect(
    (
      await readWebPage(
        web,
        search.path +
          "?" +
          new URLSearchParams({ ...search.values, q: "unique recovery sentinel", type: "TSK" }).toString(),
      )
    ).html,
  ).toContain("Searchable service plan");
});
