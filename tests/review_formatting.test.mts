import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { webServers, readWebPage, postWebForm } from "./fixtures/web.mjs";
import { parseDOM } from "./fixtures/dom.mjs";
import { proposeReviewFormatting, applyReviewFormatting } from "../src/review-formatting.ts";
import { reviewStatus, ReviewSource } from "../src/review-service.ts";

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

test("formatting is proposed without mutation and applying it preserves human words without recording review", async () => {
  const proposal = await proposeReviewFormatting(root);
  expect(proposal.files.map((file) => file.path)).toEqual(["workbench/CHARTER.md"]);
  expect(readFileSync(charter, "utf8")).toBe(original);
  applyReviewFormatting(root, proposal, proposal.digest);
  const formatted = readFileSync(charter, "utf8");
  expect(formatted.split(/\s+/)).toEqual(original.split(/\s+/));
  expect(Math.max(...formatted.split("\n").map((line) => line.length))).toBeLessThanOrEqual(60);
  expect((await proposeReviewFormatting(root)).files).toEqual([]);
  expect(reviewStatus(root, ReviewSource.Working).changes.find((change) => change.charter)?.approved).toBe(false);
});

test("a proposal cannot overwrite edits made while it was being reviewed", async () => {
  const proposal = await proposeReviewFormatting(root);
  const revised = original + "\nAdditional human intent.\n";
  writeFileSync(charter, revised);
  expect(() => {
    applyReviewFormatting(root, proposal, proposal.digest);
  }).toThrow(/changed/);
  expect(readFileSync(charter, "utf8")).toBe(revised);
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
  const proposal = await proposeReviewFormatting(root);
  applyReviewFormatting(root, proposal, proposal.digest);
  expect(readFileSync(path, "utf8")).toBe(original);
});

test("the web review requests formatting approval first, rejects stale proposals, then presents formatted contents", async () => {
  const web = await servers.start(root);
  const initial = parseDOM((await readWebPage(web, "/review")).html).window.document;
  expect(initial.querySelector("h1")?.textContent).toBe("Review formatting");
  expect(initial.querySelector("form[data-review]")).toBeNull();
  const proposal = initial.querySelector<HTMLFormElement>('form[action$="/actions/review-format"]');
  if (!proposal) throw new Error("Missing formatting approval");
  const fields = Object.fromEntries(
    [...proposal.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [input.name, input.value]),
  );
  const path = proposal.getAttribute("action") ?? "";
  expect(readFileSync(charter, "utf8")).toBe(original);
  expect((await postWebForm(web, path, { ...fields, expected: "0".repeat(64) })).status).toBe(409);
  expect(readFileSync(charter, "utf8")).toBe(original);
  expect((await postWebForm(web, path, fields)).status).toBe(200);
  expect(readFileSync(charter, "utf8")).not.toBe(original);
  const review = parseDOM((await readWebPage(web, "/review?path=workbench%2FCHARTER.md")).html).window.document;
  expect(review.querySelector("form[data-review]")).not.toBeNull();
  expect(reviewStatus(root, ReviewSource.Working).changes.find((change) => change.charter)?.approved).toBe(false);
});

test("nested canonical records are formatted without touching their supporting evidence", async () => {
  const folder = join(root, "workbench/decisions/01");
  mkdirSync(join(folder, "ADR-0100"), { recursive: true });
  const record = join(folder, "ADR-0100.md");
  writeFileSync(record, "---\nsummary: Nested record.\n---\n\n# ADR-100: Nested record\n\n" + original);
  const evidence = join(folder, "ADR-0100/evidence.md");
  writeFileSync(evidence, original);
  const proposal = await proposeReviewFormatting(root);
  expect(proposal.files.some((file) => file.path === "workbench/decisions/01/ADR-0100.md")).toBe(true);
  applyReviewFormatting(root, proposal, proposal.digest);
  expect(readFileSync(evidence, "utf8")).toBe(original);
  expect((await proposeReviewFormatting(root)).files).toEqual([]);
});

test("worker formatting proposals use captured bytes and invalidate when formatting settings or contents change", async () => {
  const { WorkspaceCollector } = await import("../src/workspace-service.ts");
  const { prepareWorkspaceFormatting } = await import("../src/web/workspace-formatting.ts");
  const { workspaceFormattingProposal } = await import("../src/web/workspace-formatting.ts");
  const { ReviewFormatter } = await import("../src/review-formatting.ts");
  const collector = new WorkspaceCollector(root),
    formatter = new ReviewFormatter();
  const snapshot = collector.collect();
  const later = "# Charter\n\nLater human intent.\n";
  writeFileSync(charter, later);
  const publication = await prepareWorkspaceFormatting(snapshot, formatter);
  expect(snapshot.formatting.results.size).toBe(0);
  expect(publication).not.toBe(snapshot);
  const proposal = workspaceFormattingProposal(publication);
  expect(proposal.files[0]?.original).toBe(original);
  expect(readFileSync(charter, "utf8")).toBe(later);
  expect(() => {
    applyReviewFormatting(root, proposal, proposal.digest);
  }).toThrow(/changed/);
  const changed = collector.collect();
  const updated = await prepareWorkspaceFormatting(changed, formatter);
  expect(workspaceFormattingProposal(updated).files).toEqual([]);
  const raw = Buffer.from(original);
  const narrow = await formatter.prepare("workbench/CHARTER.md", raw, "100644", 60);
  expect(await formatter.prepare("workbench/CHARTER.md", raw, "100644", 60)).toBe(narrow);
  const wide = await formatter.prepare("workbench/CHARTER.md", raw, "100644", 120);
  expect(wide).not.toEqual(narrow);
});

test("CLI and web formatting agree on captured proposals and failed preparation can recover without source changes", async () => {
  const { WorkspaceCollector } = await import("../src/workspace-service.ts");
  const { prepareWorkspaceFormatting, workspaceFormattingProposal } =
    await import("../src/web/workspace-formatting.ts");
  const { ReviewFormatter } = await import("../src/review-formatting.ts");
  const capture = new WorkspaceCollector(root).collect(),
    formatter = new ReviewFormatter();
  vi.spyOn(formatter, "prepare").mockResolvedValueOnce({
    state: "unavailable",
    problem: "Formatter temporarily unavailable",
  });
  const failed = await prepareWorkspaceFormatting(capture, formatter);
  expect(() => workspaceFormattingProposal(failed)).toThrow(/temporarily unavailable.*refresh/);
  const recovered = await prepareWorkspaceFormatting(capture, formatter);
  expect(recovered.revision).not.toBe(failed.revision);
  expect(workspaceFormattingProposal(recovered)).toEqual(await proposeReviewFormatting(root));
  expect(capture.formatting.results.size).toBe(0);
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
