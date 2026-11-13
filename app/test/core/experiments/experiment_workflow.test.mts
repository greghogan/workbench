import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { webServers, readWebPage, postWebForm } from "../../fixtures/web.mjs";
import { git } from "../../fixtures/adoption.mjs";
import { parseDOM } from "../../fixtures/dom.mjs";
import { changeExperimentStatus, readExperiment } from "../../../src/core/experiments/experiment-workflow.ts";
import { readTaskQueue } from "../../../src/core/tasks/task-queue.ts";
import { requiredExperimentProtocol } from "../../../src/core/records/records.ts";
import { reviewStatus, ReviewSource } from "../../../src/core/review/review-service.ts";
import { checkReview } from "../../../src/core/review/review-check.js";
import { syncMaps } from "../../../src/core/records/maps.ts";

const servers = webServers();
let root: string, path: string;
beforeEach(() => {
  root = servers.project();
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/local-state"));
  mkdirSync(join(root, "workbench/experiments"));
  path = join(root, "workbench/experiments/EXP-00.md");
  writeFileSync(
    path,
    "---\nstatus: Planned\nenvironment: null\n---\n\n# EXP-0: Compare parsers\n\n" +
      requiredExperimentProtocol.map((heading) => `## ${heading}\n\nDeclared protocol.\n`).join("\n"),
  );
});
const evidence =
  "\n## Execution provenance\n\nLocal synthetic fixture.\n\n## Evidence\n\nNo conclusive difference.\n\n## Decision\n\nInconclusive; retain the baseline.\n";
const changes = (source: ReviewSource = ReviewSource.Working) =>
  reviewStatus(root, source).changes.filter((change) => change.path.includes("/experiments/"));

test("plans and refinements need no approval; completed records and supporting evidence require review", () => {
  const queue = readTaskQueue(root);
  const support = join(root, "workbench/experiments/EXP-00/measurements.json");
  mkdirSync(join(root, "workbench/experiments/EXP-00"));
  writeFileSync(support, '{"samples":[1,2,3]}\n');
  expect(changes()).toEqual([]);
  changeExperimentStatus(root, "EXP-0", "Running");
  expect(syncMaps(root, true)).toEqual([]);
  expect(readFileSync(join(root, "workbench/experiment-map.md"), "utf8")).toContain("(Running)");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("Declared protocol.", "Evaluate a more representative design."),
  );
  expect(() => {
    changeExperimentStatus(root, "EXP-0", "Inconclusive");
  }).toThrow(/Execution provenance/);
  git(root, "add", ".");
  expect(changes(ReviewSource.Staged)).toEqual([]);
  expect(() => {
    checkReview(root);
  }).not.toThrow();
  writeFileSync(path, readFileSync(path, "utf8") + evidence);
  changeExperimentStatus(root, "EXP-0", "Inconclusive");
  expect(readExperiment(root, "EXP-0").metadata.status).toBe("Inconclusive");
  expect(syncMaps(root, true)).toEqual([]);
  expect(readFileSync(join(root, "workbench/experiment-map.md"), "utf8")).toContain("(Inconclusive)");
  expect(
    changes()
      .map((change) => change.path)
      .sort(),
  ).toEqual(["workbench/experiments/EXP-00.md", "workbench/experiments/EXP-00/measurements.json"]);
  git(root, "add", ".");
  expect(() => {
    checkReview(root);
  }).toThrow(/human review/);
  expect(readTaskQueue(root)).toEqual(queue);
});

test("execution validates protocol completeness and stale requests cannot overwrite a newer record", () => {
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("## Hypothesis\n\nDeclared protocol.", "## Hypothesis\n"));
  expect(() => {
    changeExperimentStatus(root, "EXP-0", "Running");
  }).toThrow(/protocol requires ## Hypothesis/);
  expect(readExperiment(root, "EXP-0").metadata.status).toBe("Planned");
  writeFileSync(path, original);
  const planned = readExperiment(root, "EXP-0");
  changeExperimentStatus(root, "EXP-0", "Running", planned.digest);
  const current = readFileSync(path, "utf8");
  expect(() => {
    changeExperimentStatus(root, "EXP-0", "Planned", planned.digest);
  }).toThrow(/changed/);
  expect(readFileSync(path, "utf8")).toBe(current);
});

test("agent execution needs no plan approval and the browser only reviews the completed outcome", async () => {
  const web = await servers.start(root);
  const initial = parseDOM((await readWebPage(web, "/queue")).html).window.document;
  expect(initial.querySelector('[aria-label="Work"]')?.textContent).toContain("Compare parsers");
  expect(initial.querySelector('[aria-label="Plans"]')?.textContent).not.toContain("Compare parsers");
  const page = parseDOM((await readWebPage(web, "/records/demo:EXP-0")).html).window.document;
  expect(page.querySelector('form[action$="/actions/task-state"]')).toBeNull();
  expect(page.body.textContent).not.toContain("Approve plan");
  changeExperimentStatus(root, "EXP-0", "Running", readExperiment(root, "EXP-0").digest);
  expect(readExperiment(root, "EXP-0").metadata.status).toBe("Running");
  writeFileSync(path, readFileSync(path, "utf8") + evidence);
  changeExperimentStatus(root, "EXP-0", "Inconclusive");
  const outcomes = parseDOM((await readWebPage(web, "/queue")).html).window.document;
  expect(outcomes.querySelector('[aria-label="Outcomes"]')?.textContent).toContain("Compare parsers");
  const completedPage = parseDOM((await readWebPage(web, "/records/demo:EXP-0")).html).window.document;
  expect(completedPage.querySelector('form[action$="/actions/task-state"]')).toBeNull();
  const reviewURL = [...completedPage.querySelectorAll("a")]
    .find((link) => link.textContent === "Review outcome")
    ?.getAttribute("href");
  if (!reviewURL) throw new Error("Missing outcome review link");
  const review = parseDOM((await readWebPage(web, reviewURL)).html).window.document;
  const approval = review.querySelector<HTMLFormElement>("form[data-review]");
  if (!approval) throw new Error("Missing outcome review");
  const fields = Object.fromEntries(
    [...approval.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [input.name, input.value]),
  );
  const completed = readExperiment(root, "EXP-0");
  const transition = await postWebForm(web, "/actions/task-state", {
    csrf: fields.csrf ?? "",
    reference: "demo:EXP-0",
    expected: completed.digest,
    state: "Planned",
  });
  expect(transition.status).toBe(400);
  expect(await transition.text()).toContain("Expected a task reference");
  expect(readFileSync(path, "utf8")).toBe(completed.contents);
  expect((await postWebForm(web, approval.getAttribute("action") ?? "", fields)).status).toBe(200);
  const accepted = parseDOM((await readWebPage(web, "/queue")).html).window.document;
  expect(accepted.querySelector('[aria-label="Outcomes"]')?.textContent).not.toContain("Compare parsers");
  expect(readExperiment(root, "EXP-0").metadata.status).toBe("Inconclusive");
  const reviewedPage = parseDOM((await readWebPage(web, "/records/demo:EXP-0")).html).window.document;
  expect([...reviewedPage.querySelectorAll("a")].some((link) => link.textContent === "Review outcome")).toBe(false);
  writeFileSync(path, readFileSync(path, "utf8") + "\nAdditional measurement evidence.\n");
  expect(changes()).toHaveLength(1);
});

test("reopening a committed conclusion preserves its evidence and cannot remove the review requirement", () => {
  changeExperimentStatus(root, "EXP-0", "Running");
  writeFileSync(path, readFileSync(path, "utf8") + evidence);
  changeExperimentStatus(root, "EXP-0", "Rejected");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Record a completed comparison");
  changeExperimentStatus(root, "EXP-0", "Running");
  expect(readFileSync(path, "utf8")).toContain("No conclusive difference.");
  git(root, "add", ".");
  expect(changes(ReviewSource.Staged)).toHaveLength(1);
  expect(() => {
    checkReview(root);
  }).toThrow(/human review/);
});
