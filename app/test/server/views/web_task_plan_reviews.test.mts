import { formatTimestamp } from "../../../src/server/presentation/date-time.ts";
import { parseProseRecord } from "../../../src/core/records/record-document.ts";
import { git, distribution } from "../../fixtures/adoption.mjs";
import {
  configurePlanning,
  approvePlanDraft,
  savePlanDraft,
} from "../../../src/core/tasks/planning/planning-operations.ts";
import { planIdentity, planningPaths } from "../../../src/core/tasks/planning/plan-model.ts";
import { readPlan } from "../../../src/core/tasks/planning/planning-store.ts";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { readWebPage, postWebForm } from "../../fixtures/web.mjs";
import { breadcrumbLinks, parseDOM } from "../../fixtures/dom.mjs";
import { changeTaskQueue, readTaskQueue } from "../../../src/core/tasks/task-queue.ts";
import { changeWorkQueue } from "../../../src/core/tasks/planning/plan-transfer.ts";
import { formatDocument } from "../../../src/core/records/formatting.ts";
import { taskWorkflowServers, workflowForm, writeWorkflowTask } from "../../fixtures/task-workflow.mjs";

const servers = taskWorkflowServers();
let root: string;
beforeEach(() => {
  root = servers.project();
});

test("named plan approval catches a prerequisite removed after the page was presented", async () => {
  const prerequisite = writeWorkflowTask(root, 0, "Approved");
  const contents = readFileSync(prerequisite, "utf8");
  const plan = planIdentity("demo", "service");
  const draft = "---\nstatus: Planned\ndepends_on:\n  - demo:TSK-0\n---\n\n# Deploy a service\n";
  savePlanDraft(root, plan, draft);
  const web = await servers.start(root);
  const page = "/plans/demo:plan%2Fservice";
  const approve = 'form[action$="/actions/plan-approve"]';
  const original = workflowForm((await readWebPage(web, page)).html, approve);

  rmSync(prerequisite);
  await web.monitor.reconcileAfterChange();
  expect((await postWebForm(web, original.path, original.values)).status).toBe(409);
  expect(readPlan(root, plan).approval).toBeUndefined();
  const blocked = parseDOM((await readWebPage(web, page)).html).window.document;
  expect(blocked.querySelector("main")?.textContent).toContain("Referenced work is unavailable: demo:TSK-0");
  expect(blocked.querySelector(approve)).toBeNull();

  writeFileSync(prerequisite, contents);
  await web.monitor.reconcileAfterChange();
  const restored = workflowForm((await readWebPage(web, page)).html, approve);
  expect((await postWebForm(web, restored.path, restored.values)).status).toBe(200);
  expect(readPlan(root, plan).approval?.current).toBe(true);
});

test("task approval diffs show the retained plan and reject supporting files changed after inspection", async () => {
  const config = join(root, "workbench/config.toml");
  writeFileSync(config, readFileSync(config, "utf8") + "\n[review]\ntask_approvals=true\n");
  const path = writeWorkflowTask(root, 0, "Planned"),
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
  let approve = workflowForm(
    initialPage.html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Approved"])',
  );
  expect((await postWebForm(web, approve.path, approve.values)).status).toBe(200);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("Human-readable outcome.", "Automatic recovery after restart."),
  );
  await web.monitor.reconcileAfterChange();
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
  approve = workflowForm(viewed.html, 'form[action$="/actions/task-state"]:has(input[name="state"][value="Approved"])');
  writeFileSync(supporting, "System service.\n");
  expect((await postWebForm(web, approve.path, approve.values)).status).toBe(409);
  const image = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 16"><title>Recovery layout</title></svg>';
  rmSync(originalPath);
  writeFileSync(join(root, "workbench/tasks/TSK-00/recovery.svg"), image);
  writeFileSync(path, readFileSync(path, "utf8").replace(originalImage, "![Recovery layout](TSK-00/recovery.svg)"));
  await web.monitor.reconcileAfterChange();
  viewed = await readWebPage(web, page + "?view=changes");
  document = parseDOM(viewed.html).window.document;
  expect(document.querySelector('[aria-label="Supporting file changes"]')?.textContent).toContain(
    "requirements.txt: changed",
  );
  const imageURL = document.querySelector('.document-diff ins img[alt="Recovery layout"]')?.getAttribute("src");
  if (!imageURL) throw new Error("The plan comparison omitted its wireframe");
  const preview = await readWebPage(web, imageURL);
  expect(preview.response.status).toBe(200);
  expect(preview.response.headers.get("content-type")).toBe("image/svg+xml");
  expect(preview.response.headers.get("content-security-policy")).toContain("sandbox; default-src 'none'");
  expect(preview.html).toBe(image);
  const removedURL = document.querySelector('.document-diff del img[alt="Initial layout"]')?.getAttribute("src");
  if (!removedURL) throw new Error("The plan comparison omitted the removed wireframe");
  const removed = await readWebPage(web, removedURL);
  expect(removed.response.status).toBe(200);
  expect(removed.html).toBe(initialSvg);
  const unowned = new URL(removedURL, web.url);
  unowned.searchParams.set("path", "workbench/unowned.svg");
  writeFileSync(join(root, "workbench/unowned.svg"), initialSvg);
  expect((await readWebPage(web, unowned.pathname + unowned.search)).response.status).toBe(404);
  const splitPlan = parseDOM((await readWebPage(web, page + "?layout=split")).html).window.document;
  expect(splitPlan.querySelector('[data-diff-side="before"] del img[alt="Initial layout"]')).not.toBeNull();
  expect(splitPlan.querySelector('[data-diff-side="after"] ins img[alt="Recovery layout"]')).not.toBeNull();
  approve = workflowForm(viewed.html, 'form[action$="/actions/task-state"]:has(input[name="state"][value="Approved"])');
  expect((await postWebForm(web, approve.path, approve.values)).status).toBe(200);
  expect(
    parseDOM((await readWebPage(web, "/reviews")).html).window.document.querySelector("main")?.textContent,
  ).not.toContain("Work 0");
  changeTaskQueue(root, { action: "start", reference: "TSK-0" });
  writeFileSync(path, readFileSync(path, "utf8").replace("[ ]", "[x]") + "\nRecovery is delivered.\n");
  changeTaskQueue(root, { action: "implemented", reference: "TSK-0", detail: "Recovery verified." });
  await web.monitor.reconcileAfterChange();
  const outcome = parseDOM((await readWebPage(web, page)).html).window.document;
  expect(outcome.querySelector(".document-diff ins")?.textContent).toBeTruthy();
  expect(outcome.querySelector(".document-diff")?.textContent).toContain("Recovery is delivered.");
  expect(outcome.querySelector('input[name="state"][value="Approved"]')).toBeNull();
  expect(outcome.querySelector('input[name="state"][value="Accepted"]')).not.toBeNull();
  const accept = workflowForm(
    (await readWebPage(web, page)).html,
    'form[action$="/actions/task-state"]:has(input[name="state"][value="Accepted"])',
  );
  expect((await postWebForm(web, accept.path, accept.values)).status).toBe(200);
  writeFileSync(path, readFileSync(path, "utf8") + "\nRenewed verification adds a restart check.\n");
  await web.monitor.reconcileAfterChange();
  const renewal = parseDOM((await readWebPage(web, page)).html).window.document;
  const added = [...renewal.querySelectorAll(".document-diff ins")].map((node) => node.textContent).join(" ");
  expect(added).toContain("Renewed verification");
  expect(added).not.toContain("Recovery is delivered");
  expect(renewal.querySelector(".document-diff del img")).toBeNull();
  const reopen = workflowForm(
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
  await web.monitor.reconcileAfterChange();
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
  let approve = workflowForm(viewed.html, 'form[action$="/actions/plan-approve"]');
  for (const retired of ["/actions/plan-create", "/actions/plan-checkpoint"])
    expect((await postWebForm(web, retired, approve.values)).status).toBe(404);
  const approved = await postWebForm(web, approve.path, approve.values);
  expect(approved.status).toBe(200);
  const { redirect } = (await approved.json()) as { redirect: string };
  expect(new URL(redirect, web.url).pathname).toBe("/work");
  const work = parseDOM((await readWebPage(web, redirect)).html).window.document;
  expect(work.querySelector("main")?.textContent).toContain("Background service");
  expect(git(root, "rev-list", "--count", "future")).toBe("1");
  expect(git(root, "rev-parse", "HEAD")).toBe(initial);
  let queue = parseDOM((await readWebPage(web, "/plans")).html).window.document;
  expect(queue.querySelector("main")?.textContent).not.toContain("Background service");
  expect(readTaskQueue(root).entries[0]?.reference).toBe("demo:plan/service");
  viewed = await readWebPage(web, page + "?view=edit");
  const edit = workflowForm(viewed.html, 'form[action$="/actions/plan-save"]');
  const revised = readPlan(root, planIdentity("demo", "service")).contents.replace("current user", "all users");
  expect((await postWebForm(web, edit.path, { ...edit.values, contents: revised })).status).toBe(200);
  expect((await postWebForm(web, edit.path, { ...edit.values, contents: "Stale overwrite" })).status).toBe(409);
  expect(git(root, "rev-list", "--count", "future")).toBe("1");
  viewed = await readWebPage(web, page + "?view=changes&layout=split");
  const document = parseDOM(viewed.html).window.document;
  expect(document.querySelector(".document-diff.split")?.textContent).toContain("all users");
  approve = workflowForm(viewed.html, 'form[action$="/actions/plan-approve"]');
  expect((await postWebForm(web, approve.path, approve.values)).status).toBe(200);
  saved = readPlan(root, planIdentity("demo", "service"));
  expect(saved.approval?.current).toBe(true);
  expect(git(root, "rev-list", "--count", "future")).toBe("2");
  queue = parseDOM((await readWebPage(web, "/work")).html).window.document;
  expect(queue.querySelector("main")?.textContent).toContain("Background service");
  const editPage = (await readWebPage(web, page + "?view=edit")).html,
    rename = workflowForm(editPage, 'form[action$="/actions/plan-rename"]');
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
  await web.monitor.reconcileAfterChange();
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
    const stale = workflowForm(viewed.html, "form[data-review-prepare]");
    const later = original + "\nPreserve user preferences too.\n";
    if (saved) savePlanDraft(root, identity, later, { expected: readPlan(root, identity).digest });
    else writeFileSync(path, later);
    expect((await postWebForm(web, stale.path, stale.values)).status).toBe(409);
    expect(current()).toBe(later);
    await web.monitor.reconcileAfterChange();
    viewed = await readWebPage(web, page);
    const prepare = workflowForm(viewed.html, "form[data-review-prepare]");
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
