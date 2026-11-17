import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { webServers, readWebPage, postWebForm, hiddenValue } from "../../fixtures/web.mjs";
import { parseDOM } from "../../fixtures/dom.mjs";
import { formatPendingReviews, ReviewFormatter } from "../../../src/core/review/review-formatting.ts";
import { formatDocument } from "../../../src/core/records/formatting.ts";
import { PreparationState } from "../../../src/server/review/review-state.ts";
import { ProjectEdits } from "../../../src/core/projects/project-edits.ts";
import {
  reviewStatus,
  ReviewSource,
  reviewedBaselines,
  approveReviewFiles,
} from "../../../src/core/review/review-service.ts";
import { WorkspaceCollector, WorkspaceIndex } from "../../../src/server/workspace/workspace-service.ts";
import { checkReviewFormatting } from "../../../src/server/workspace/review-preparation.ts";
import { WebActions } from "../../../src/server/projects/actions.ts";
import * as fileReads from "../../../src/core/runtime/file-reads.ts";

const servers = webServers();
let root: string, charter: string, original: string;
beforeEach(() => {
  root = servers.project();
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/local-state"));
  charter = join(root, "workbench/CHARTER.md");
  original = "# Charter\n\n" + "Human words remain authoritative. ".repeat(12).trim() + "\n";
  writeFileSync(charter, original);
  const config = join(root, "workbench/config.toml");
  writeFileSync(config, readFileSync(config, "utf8").replace("wrap_width=120", "wrap_width=60"));
});

test("formatting preserves human words and leaves review pending", async () => {
  await formatPendingReviews(root, charter);
  const formatted = readFileSync(charter, "utf8");
  expect(formatted.split(/\s+/)).toEqual(original.split(/\s+/));
  expect(Math.max(...formatted.split("\n").map((line) => line.length))).toBeLessThanOrEqual(60);
  await formatPendingReviews(root, charter);
  expect(readFileSync(charter, "utf8")).toBe(formatted);
  expect(reviewStatus(root, ReviewSource.Working).changes.find((change) => change.charter)?.approved).toBe(false);
});

test("a concurrent edit cannot be overwritten by preparation", async () => {
  const later = original + "\nAdditional human intent.\n";
  const apply = vi.spyOn(ProjectEdits.prototype, "apply");
  apply.mockImplementationOnce(function (this: ProjectEdits) {
    writeFileSync(charter, later);
    apply.mockRestore();
    this.apply();
  });
  try {
    await expect(formatPendingReviews(root, charter)).rejects.toThrow(/changed/);
  } finally {
    vi.restoreAllMocks();
  }
  expect(readFileSync(charter, "utf8")).toBe(later);
});

test("replacement keeps its expected contents when the file changes immediately after verification", () => {
  const later = original + "\nAdditional human intent.\n";
  const read = fileReads.readBoundedFile;
  const reading = vi.spyOn(fileReads, "readBoundedFile").mockImplementationOnce((...args) => {
    const bytes = read(...args);
    writeFileSync(charter, later);
    return bytes;
  });
  try {
    const edits = new ProjectEdits(root);
    edits.replace("workbench/CHARTER.md", Buffer.from(original), "formatted output\n");
    expect(() => {
      edits.apply();
    }).toThrow(/changed/);
    expect(readFileSync(charter, "utf8")).toBe(later);
  } finally {
    reading.mockRestore();
  }
});

test("raw experiment sidecars are excluded from automatic record formatting", async () => {
  const directory = join(root, "workbench/experiments/EXP-00");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(root, "workbench/experiments/EXP-00.md"),
    "---\nstatus: Planned\nenvironment: null\n---\n\n# EXP-0: Evidence fixture\n",
  );
  const path = join(directory, "evidence.md");
  writeFileSync(path, original);
  await formatPendingReviews(root);
  expect(readFileSync(path, "utf8")).toBe(original);
});

test.each([false, true])(
  "web review formats before display and confirmation preserves later edits (%s)",
  async (changed) => {
    const web = await servers.start(root);
    const queue = parseDOM((await readWebPage(web, "/reviews")).html).window.document;
    expect(queue.querySelector("h1")?.textContent).toBe("Reviews");
    expect(readFileSync(charter, "utf8")).toBe(original);
    const pending = parseDOM((await readWebPage(web, "/review?path=workbench%2FCHARTER.md&layout=split")).html).window
      .document;
    const preparation = pending.querySelector<HTMLFormElement>("form[data-review-prepare]");
    if (!preparation) throw new Error("Missing review preparation");
    expect(pending.querySelector("form[data-review]")).toBeNull();
    expect(readFileSync(charter, "utf8")).toBe(original);
    const formatted = await formatDocument(original, charter, 60);
    expect(formatted).toBeDefined();
    const preparationFields = Object.fromEntries(
      [...preparation.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [
        input.name,
        input.value,
      ]),
    );
    const response = await postWebForm(web, preparation.getAttribute("action") ?? "", preparationFields);
    expect(response.status).toBe(200);
    const result = (await response.json()) as { redirect: string };
    expect(result.redirect).toContain("layout=split");
    expect(readFileSync(charter, "utf8")).toBe(formatted);
    const initial = parseDOM((await readWebPage(web, result.redirect)).html).window.document;
    const form = initial.querySelector<HTMLFormElement>("form[data-review]");
    if (!form) throw new Error("Missing record review");
    const fields = Object.fromEntries(
      [...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [input.name, input.value]),
    );
    expect(reviewStatus(root, ReviewSource.Working).changes.find((change) => change.charter)?.approved).toBe(false);
    const later = original + "\nAdditional human intent.\n";
    if (changed) writeFileSync(charter, later);
    expect((await postWebForm(web, form.getAttribute("action") ?? "", fields)).status).toBe(200);
    expect(readFileSync(charter, "utf8")).toBe(changed ? later : formatted);
    expect(reviewedBaselines(root).get("workbench/CHARTER.md")?.contents).toBe(formatted);
    expect(reviewStatus(root, ReviewSource.Working).changes.find((change) => change.charter)?.approved).toBe(!changed);
  },
);

test("nested canonical records are formatted without touching their supporting evidence", async () => {
  const folder = join(root, "workbench/decisions/01");
  mkdirSync(join(folder, "ADR-0100"), { recursive: true });
  const record = join(folder, "ADR-0100.md");
  writeFileSync(record, "---\nsummary: Nested record.\n---\n\n# ADR-100: Nested record\n\n" + original);
  const evidence = join(folder, "ADR-0100/evidence.md");
  writeFileSync(evidence, original);
  await formatPendingReviews(root, record);
  expect(readFileSync(record, "utf8")).toBe(
    await formatDocument("---\nsummary: Nested record.\n---\n\n# ADR-100: Nested record\n\n" + original, record, 60),
  );
  expect(readFileSync(evidence, "utf8")).toBe(original);
});

test("read-only preparation checks preserve captured bytes and preparation uses current file contents", async () => {
  const collector = new WorkspaceCollector(root),
    formatter = new ReviewFormatter();
  const snapshot = collector.collect();
  const later = "# Charter\n\nLater human intent.\n";
  writeFileSync(charter, later);
  const publication = await checkReviewFormatting(snapshot, formatter);
  expect(snapshot.reviewPreparation.files.size).toBe(0);
  expect(publication.reviewPreparation.files.get("workbench/CHARTER.md")).toEqual({ state: PreparationState.Required });
  expect(publication.reviewDocuments).toEqual(snapshot.reviewDocuments);
  expect(publication.review.changes.map(({ digest }) => digest)).toEqual(
    snapshot.review.changes.map(({ digest }) => digest),
  );
  expect(readFileSync(charter, "utf8")).toBe(later);
  await formatPendingReviews(root, charter);
  expect(readFileSync(charter, "utf8")).toBe(later);
  const changed = collector.collect();
  const updated = await checkReviewFormatting(changed, formatter);
  expect(updated.reviewPreparation.files.size).toBe(0);
});

test("failed read preparation can recover without source changes", async () => {
  const capture = new WorkspaceCollector(root).collect(),
    formatter = new ReviewFormatter();
  vi.spyOn(formatter, "prepare").mockResolvedValueOnce({
    state: "unavailable",
    problem: "Formatter temporarily unavailable",
  });
  const failed = await checkReviewFormatting(capture, formatter);
  expect(failed.reviewPreparation.files.get("workbench/CHARTER.md")).toEqual({
    state: PreparationState.Unavailable,
    problem: "Formatter temporarily unavailable",
  });
  const recovered = await checkReviewFormatting(capture, formatter);
  expect(recovered.revision).not.toBe(failed.revision);
  expect(recovered.reviewPreparation.files.get("workbench/CHARTER.md")).toEqual({ state: PreparationState.Required });
  expect(capture.reviewPreparation.files.size).toBe(0);
});

test("formatting settings do not carry approval onto reformatted contents", async () => {
  await formatPendingReviews(root, charter);
  const reviewed = reviewStatus(root, ReviewSource.Working).changes.find((change) => change.charter);
  if (!reviewed) throw new Error("Missing charter change");
  approveReviewFiles(root, [reviewed], true, ReviewSource.Working);
  const config = join(root, "workbench/config.toml");
  writeFileSync(config, readFileSync(config, "utf8").replace("wrap_width=60", "wrap_width=80"));
  const snapshot = new WorkspaceCollector(root).collect();
  expect(snapshot.review.changes.find((change) => change.charter)?.approved).toBe(true);
  const checked = await checkReviewFormatting(snapshot, new ReviewFormatter());
  expect(checked.review.changes.find((change) => change.charter)?.approved).toBe(true);
  expect(new WorkspaceIndex(checked).reviews.pending).toHaveLength(1);
  expect(checked.review.changes.find((change) => change.charter)?.digest).toBe(
    snapshot.review.changes.find((change) => change.charter)?.digest,
  );
  await formatPendingReviews(root, charter);
  const current = reviewStatus(root, ReviewSource.Working).changes.find((change) => change.charter);
  expect(current?.approved).toBe(false);
  expect(current?.digest).not.toBe(reviewed.digest);
});

test("retrying preparation completes context generation after a successful file save", async () => {
  const agents = join(root, "AGENTS.md");
  mkdirSync(agents);
  await expect(formatPendingReviews(root, charter)).rejects.toThrow(/Generated record outputs could not be updated/);
  const formatted = readFileSync(charter, "utf8");
  expect(formatted).not.toBe(original);
  rmSync(agents, { recursive: true });
  await formatPendingReviews(root, charter);
  expect(readFileSync(charter, "utf8")).toBe(formatted);
  expect(readFileSync(agents, "utf8")).toContain("Human words remain authoritative.");
  expect(reviewStatus(root, ReviewSource.Working).changes.find((change) => change.charter)?.approved).toBe(false);
});

test("preparing a scoped environment repairs its map without synchronizing unrelated outputs", async () => {
  const scope = join(root, "engine/workbench");
  mkdirSync(join(scope, "environments"), { recursive: true });
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="demo"\npath="."\n[[project]]\nid="engine"\npath="engine"\n',
  );
  const record = join(scope, "environments/ENV-00.md");
  writeFileSync(record, "---\n{}\n---\n\n# ENV-0: Compute environment\n\n" + original);
  const untouched = new Map([
    [join(root, "AGENTS.md"), "existing context\n"],
    [join(root, "workbench/environment-map.md"), "existing root map\n"],
    [join(scope, "decision-map.md"), "existing scoped decisions\n"],
  ]);
  for (const [path, contents] of untouched) writeFileSync(path, contents);
  // Unrelated malformed policy must not prevent preparing the environment record.
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "---\nsummary: [invalid\n---\n");
  await formatPendingReviews(root, record);
  const map = readFileSync(join(scope, "environment-map.md"), "utf8");
  expect(map).toContain("engine:ENV-0");
  expect(map.replace(/\s+/g, " ")).toContain("Compute environment");
  for (const [path, contents] of untouched) expect(readFileSync(path, "utf8")).toBe(contents);
  expect(readFileSync(charter, "utf8")).toBe(original);
});

test("invalid preparation targets are rejected before admitting a worker or writing files", async () => {
  const web = await servers.start(root);
  const page = await readWebPage(web, "/review?path=workbench%2FCHARTER.md");
  const csrf = hiddenValue(page.html, "csrf");
  const run = vi.spyOn(WebActions.prototype, "run");
  try {
    for (const [values, expected] of [
      [{ path: "workbench/decisions/ADR-99.md" }, 404],
      [{ path: "workbench/config.toml" }, 400],
      [{ path: "workbench/decisions/ADR-00/evidence.md" }, 400],
      [{ path: "../outside.md" }, 400],
      [{ path: "workbench/CHARTER.md", review_layout: "invalid" }, 400],
      [{ path: "workbench/CHARTER.md", review_view: "invalid" }, 400],
    ] as const) {
      const response = await postWebForm(web, "/actions/review-prepare", { csrf, ...values });
      expect(response.status).toBe(expected);
    }
    expect(run).not.toHaveBeenCalled();
    expect(readFileSync(charter, "utf8")).toBe(original);
  } finally {
    vi.restoreAllMocks();
  }
  for (const path of [root, join(root, "workbench/config.toml")])
    await expect(formatPendingReviews(root, path)).rejects.toThrow(/protected record/);
});

test("unformattable review records retain an actionable conflict and can be edited before retry", async () => {
  writeFileSync(charter, "---\nsummary: [broken\n---\n\n# Charter\n");
  const web = await servers.start(root);
  const response = await fetch(web.url + "/review?path=workbench%2FCHARTER.md");
  expect(response.status).toBe(409);
  const document = parseDOM(await response.text()).window.document;
  expect(document.body.textContent).toContain("Edit the file and refresh before reviewing");
  expect(
    [...document.querySelectorAll("a")].find((link) => link.textContent === "Edit record")?.getAttribute("href"),
  ).toContain("view=edit");
  expect(document.querySelector("form[data-review]")).toBeNull();
});

test("a new browser snapshot keeps output repair pending after formatting succeeded", async () => {
  const agents = join(root, "AGENTS.md");
  mkdirSync(agents);
  await expect(formatPendingReviews(root, charter)).rejects.toThrow(/Generated record outputs/);
  const formatted = readFileSync(charter, "utf8");
  expect(formatted).not.toBe(original);
  const snapshot = new WorkspaceCollector(root).collect();
  const checked = await checkReviewFormatting(snapshot, new ReviewFormatter());
  expect(checked.reviewPreparation.files.get("workbench/CHARTER.md")).toEqual({ state: PreparationState.Required });
  const web = await servers.start(root);
  const page = parseDOM((await readWebPage(web, "/review?path=workbench%2FCHARTER.md")).html).window.document;
  const form = page.querySelector<HTMLFormElement>("form[data-review-prepare]");
  if (!form) throw new Error("Missing repair action after refresh");
  expect(page.querySelector("form[data-review]")).toBeNull();
  rmSync(agents, { recursive: true });
  const fields = Object.fromEntries(
    [...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((field) => [field.name, field.value]),
  );
  const response = await postWebForm(web, form.getAttribute("action") ?? "", fields);
  expect(response.status).toBe(200);
  const next = parseDOM((await readWebPage(web, "/review?path=workbench%2FCHARTER.md")).html).window.document;
  expect(next.querySelector("form[data-review-prepare]")).toBeNull();
  expect(next.querySelector("form[data-review]")).not.toBeNull();
  expect(readFileSync(charter, "utf8")).toBe(formatted);
});

test("pending repair for a newer file does not revoke an already presented review", async () => {
  await formatPendingReviews(root, charter);
  const shown = readFileSync(charter, "utf8"),
    web = await servers.start(root);
  const document = parseDOM((await readWebPage(web, "/review?path=workbench%2FCHARTER.md")).html).window.document;
  const form = document.querySelector<HTMLFormElement>("form[data-review]");
  if (!form) throw new Error("Missing presented review");
  const fields = Object.fromEntries(
    [...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((field) => [field.name, field.value]),
  );
  const agents = join(root, "AGENTS.md");
  rmSync(agents);
  mkdirSync(agents);
  writeFileSync(charter, shown + "\n" + "New human direction. ".repeat(20).trim() + "\n");
  await expect(formatPendingReviews(root, charter)).rejects.toThrow(/Generated record outputs/);
  expect((await postWebForm(web, form.getAttribute("action") ?? "", fields)).status).toBe(200);
  expect(reviewedBaselines(root).get("workbench/CHARTER.md")?.contents).toBe(shown);
  expect(reviewStatus(root, ReviewSource.Working).changes.find((change) => change.charter)?.approved).toBe(false);
  const refreshed = parseDOM((await readWebPage(web, "/review?path=workbench%2FCHARTER.md")).html).window.document;
  expect(refreshed.querySelector("form[data-review-prepare]")).not.toBeNull();
});
