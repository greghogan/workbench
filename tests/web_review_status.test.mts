import { expect, test } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseDOM } from "./fixtures/dom.mjs";
import { webServers, readWebPage, postWebForm, hiddenValue } from "./fixtures/web.mjs";
import { git } from "./fixtures/adoption.mjs";
import { approveReviewFiles, ReviewSource, reviewStatus } from "../src/review-service.ts";
import { checkReview } from "../src/review.ts";

const fixture = webServers();
const adr = "workbench/decisions/ADR-00.md";
const experiment = "workbench/experiments/EXP-00.md";
const note = "workbench/experiments/EXP-00/notes.txt";
const text = (body: string) => `---\nsummary: File review.\n---\n\n# ADR-0: Files\n\n${body}\n`;
test("a new record opens as a complete file and gains a comparison only after its first review", async () => {
  const root = fixture.project(),
    path = "workbench/decisions/ADR-01.md";
  writeFileSync(join(root, path), "# ADR-1: New decision\n\nInitial complete text.\n");
  const web = await fixture.start(root);
  const initial = parseDOM((await readWebPage(web, `/review?path=${path}`)).html).window.document;
  const views = initial.querySelector('nav[aria-label="Reviewed file views"]');
  expect([...(views?.querySelectorAll("a") ?? [])].map((link) => link.textContent)).toEqual(["Current"]);
  expect(initial.querySelector(".document")?.textContent).toContain("Initial complete text.");
  expect(initial.querySelector(".document-diff")).toBeNull();
  const read = parseDOM((await readWebPage(web, "/record?id=demo:ADR-1")).html).window.document;
  expect([...read.querySelectorAll('nav[aria-label="Record views"] a')].map((link) => link.textContent)).not.toContain(
    "Changes",
  );
  approve(root, path);
  writeFileSync(join(root, path), "# ADR-1: New decision\n\nRevised complete text.\n");
  const revised = parseDOM((await readWebPage(web, `/review?path=${path}`)).html).window.document;
  expect(
    [...revised.querySelectorAll('nav[aria-label="Difference layout"] a')].map((link) => link.textContent),
  ).toEqual(["Unified", "Side-by-side"]);
  expect(revised.querySelector('nav[aria-label="Reviewed file views"]')).toBeNull();
  expect(revised.querySelector(".document-diff del")?.textContent).toContain("Initial");
  const previous = parseDOM((await readWebPage(web, "/review?id=demo:ADR-1&layout=split")).html).window.document;
  expect(previous.querySelector('[data-diff-side="before"] .document')?.textContent).toContain(
    "Initial complete text.",
  );
  expect(previous.querySelector('[data-diff-side="after"] .document')?.textContent).toContain("Revised complete text.");
  expect(previous.querySelector("form[data-review]")).not.toBeNull();
});
function approve(root: string, path: string, source = ReviewSource.Working) {
  const change = reviewStatus(root, source).changes.find((change) => change.path === path);
  if (!change) throw new Error("Missing review fixture");
  approveReviewFiles(root, [change], false, source);
}

test("record listing review links include supporting changes and disappear only after their exact review", async () => {
  const root = fixture.project();
  mkdirSync(join(root, "workbench/experiments/EXP-00"), { recursive: true });
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(join(root, experiment), "# EXP-0: Protocol\n\nInspect the supporting notes.\n");
  writeFileSync(join(root, note), "Original notes.\n");
  writeFileSync(join(root, "workbench/tasks/TSK-00.md"), "---\nstatus: Planned\n---\n\n# TSK-0: Work\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Evidence baseline");
  writeFileSync(join(root, note), "Revised notes.\n");
  writeFileSync(join(root, adr), text("Revised decision."));
  const web = await fixture.start(root);
  const listing = async () => parseDOM((await readWebPage(web, "/records")).html).window.document;
  const reviewLink = (document: Document, id: string) =>
    document.querySelector<HTMLAnchorElement>(`[data-record-id="demo:${id}"] a.badge.pending`);
  let document = await listing();
  expect(reviewLink(document, "ADR-0")?.textContent).toBe("Needs review");
  const link = reviewLink(document, "EXP-0");
  expect(link?.textContent).toBe("Needs review");
  expect(new URL(link?.getAttribute("href") ?? "", web.url).searchParams.get("id")).toBe("demo:EXP-0");
  expect(reviewLink(document, "TSK-0")).toBeNull();
  expect(reviewLink(document, "CHARTER")).toBeNull();
  const review = parseDOM((await readWebPage(web, link?.getAttribute("href") ?? "")).html).window.document;
  expect(review.querySelector('input[name="path"]')?.getAttribute("value")).toBe(note);
  expect([...review.querySelectorAll("[data-review-file] .badge")].map((node) => node.textContent)).not.toContain(
    "Needs review",
  );
  approve(root, note);
  const acknowledged = parseDOM((await readWebPage(web, `/review?id=demo:EXP-0`)).html).window.document;
  expect(acknowledged.querySelectorAll("[data-review-file]")).toHaveLength(0);
  expect(acknowledged.querySelectorAll('a[data-card-link][href*="EXP-0"]')).toHaveLength(0);
  document = await listing();
  expect(reviewLink(document, "EXP-0")).toBeNull();
  expect(reviewLink(document, "ADR-0")).not.toBeNull();
  approve(root, adr);
  git(root, "add", ".");
  checkReview(root);
  expect((await listing()).querySelectorAll("[data-record-id] a.badge.pending")).toHaveLength(0);
  writeFileSync(join(root, note), "Changed after review.\n");
  expect(reviewLink(await listing(), "EXP-0")).not.toBeNull();
});

test("staged-only changes are absent from the UI and cannot bypass commit review", async () => {
  const root = fixture.project(),
    original = readFileSync(join(root, adr), "utf8");
  writeFileSync(join(root, adr), text("Staged-only proposal."));
  git(root, "add", adr);
  const candidate = reviewStatus(root, ReviewSource.Staged).changes[0];
  if (!candidate) throw new Error("Missing staged fixture");
  writeFileSync(join(root, adr), original);
  const web = await fixture.start(root);
  const queue = await readWebPage(web, "/review");
  expect(queue.html).toContain("No protected changes.");
  expect((await readWebPage(web, `/review?path=${adr}`)).response.status).toBe(404);
  expect((await readWebPage(web, `/review?path=${adr}&review_source=staged`)).response.status).toBe(400);
  const listing = await readWebPage(web, "/records?type=ADR");
  const document = parseDOM(listing.html).window.document;
  expect(document.querySelector("a.badge.pending")).toBeNull();
  const response = await postWebForm(web, "/actions/approve", {
    csrf: hiddenValue(listing.html, "csrf"),
    path: adr,
    digest: candidate.digest,
    review_source: "staged",
    reviewed: "yes",
  });
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("no longer retained");
  expect(reviewStatus(root, ReviewSource.Staged).changes[0]?.approved).toBe(false);
  expect(() => {
    checkReview(root);
  }).toThrow(/human review/);
  approveReviewFiles(root, [candidate], false);
  checkReview(root);
});

test("the default ADR comparison uses the last review since HEAD and never the staged intermediate contents", async () => {
  const root = fixture.project();
  writeFileSync(join(root, adr), text("Intermediate staged sentence."));
  git(root, "add", adr);
  writeFileSync(join(root, adr), text("Reviewed current sentence."));
  const web = await fixture.start(root);
  const difference = async () => {
    const document = parseDOM((await readWebPage(web, `/review?path=${adr}`)).html).window.document;
    const difference = {
      removed: [...document.querySelectorAll(".document-diff p del")].map((node) => node.textContent).join(" "),
      added: [...document.querySelectorAll(".document-diff p ins")].map((node) => node.textContent).join(" "),
    };
    const record = parseDOM((await readWebPage(web, "/record?id=demo:ADR-0&view=changes")).html).window.document;
    expect([...record.querySelectorAll(".document-diff p del")].map((node) => node.textContent).join(" ")).toBe(
      difference.removed,
    );
    expect([...record.querySelectorAll(".document-diff p ins")].map((node) => node.textContent).join(" ")).toBe(
      difference.added,
    );
    expect(record.querySelector('a[href*="baseline=head"]')).toBeNull();
    return difference;
  };
  let diff = await difference();
  expect(diff.removed).toContain("Keep files authoritative");
  expect(diff.added).toContain("Reviewed current sentence");
  expect(diff.added).not.toContain("Intermediate staged sentence.");
  approve(root, adr);
  writeFileSync(join(root, adr), text("New current sentence."));
  diff = await difference();
  expect(diff.removed).toContain("Reviewed");
  expect(diff.removed).not.toContain("Intermediate staged");
  expect(diff.added).toContain("New");
  approve(root, adr);
  git(root, "add", adr);
  checkReview(root);
  git(root, "commit", "-qm", "New baseline");
  writeFileSync(join(root, adr), text("Latest current sentence."));
  diff = await difference();
  expect(diff.removed).toContain("New");
  expect(diff.removed).not.toContain("Reviewed");
  expect(diff.added).toContain("Latest");
});

test("record and supporting-file review always show current contents regardless of the index", async () => {
  const root = fixture.project();
  mkdirSync(join(root, "workbench/experiments/EXP-00"), { recursive: true });
  writeFileSync(join(root, experiment), "# EXP-0: Protocol\n\nCommitted protocol.\n");
  writeFileSync(join(root, note), "Original evidence.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Protocol baseline");
  writeFileSync(join(root, note), "Staged evidence.\n");
  git(root, "add", note);
  writeFileSync(join(root, experiment), "# EXP-0: Current protocol title\n\nCurrent protocol.\n");
  writeFileSync(join(root, note), "Current evidence.\n");
  const web = await fixture.start(root);
  const current = parseDOM((await readWebPage(web, `/review?path=${experiment}`)).html).window.document;
  expect(current.querySelector(".document")?.textContent).toContain("Current protocol.");
  expect(current.querySelectorAll("h1")).toHaveLength(1);
  expect(current.querySelector("h1")?.textContent).toBe("EXP-0: Current protocol title");
  expect(current.querySelector("main")?.textContent).not.toContain("Staged evidence.");
  expect(current.querySelector("pre.source")?.textContent).toBe("Current evidence.\n");
  expect(current.querySelectorAll("form[data-review]")).toHaveLength(2);
});

test("current-file approval ignores invalid staged declarations while the commit gate still rejects them", async () => {
  const root = fixture.project(),
    config = join(root, "workbench/config.toml");
  const valid = readFileSync(config, "utf8");
  writeFileSync(config, "invalid = [\n");
  git(root, "add", "workbench/config.toml");
  writeFileSync(config, valid);
  writeFileSync(join(root, adr), text("Review the valid current record."));
  const web = await fixture.start(root);
  const page = await readWebPage(web, `/review?path=${adr}`);
  const response = await postWebForm(web, "/actions/approve", {
    csrf: hiddenValue(page.html, "csrf"),
    path: adr,
    digest: hiddenValue(page.html, "digest"),
    reviewed: "yes",
  });
  expect(response.status).toBe(200);
  expect(reviewStatus(root, ReviewSource.Working).changes.find((change) => change.path === adr)?.approved).toBe(true);
  expect(() => {
    checkReview(root);
  }).toThrow(/array|syntax|parse|unexpected|invalid|expected/i);
  git(root, "add", "workbench/config.toml", adr);
  checkReview(root);
});

test("both formatted deletion layouts use the latest review rather than different committed text", async () => {
  const root = fixture.project();
  const reviewed = text("Latest acknowledged text to remove.");
  writeFileSync(join(root, adr), reviewed);
  approve(root, adr);
  rmSync(join(root, adr));
  const web = await fixture.start(root);
  const changes = parseDOM((await readWebPage(web, `/review?id=demo:ADR-0`)).html).window.document;
  expect([...changes.querySelectorAll(".document-diff p del")].map((node) => node.textContent).join(" ")).toContain(
    "Latest acknowledged",
  );
  const split = parseDOM((await readWebPage(web, `/review?id=demo:ADR-0&layout=split`)).html).window.document;
  const contents = [...split.querySelectorAll('[data-diff-side="before"] .document')]
    .map((node) => node.textContent)
    .join(" ");
  expect(contents).toContain("Latest acknowledged text to remove.");
  expect(contents).not.toContain("Keep files authoritative");
  expect(split.querySelector(".source-comparison")).toBeNull();

  approve(root, adr);
  git(root, "add", adr);
  checkReview(root);
});

test("completed files leave the queue and later edits return them without losing per-file review", async () => {
  const root = fixture.project();
  mkdirSync(join(root, "workbench/experiments/EXP-00"), { recursive: true });
  writeFileSync(join(root, experiment), "# EXP-0: Protocol\n\nReview the protocol.\n");
  writeFileSync(join(root, note), "Review the evidence.\n");
  writeFileSync(join(root, adr), text("Review this decision."));
  const web = await fixture.start(root);
  const queue = async () => parseDOM((await readWebPage(web, "/review")).html).window.document;
  const entries = (document: Document) =>
    [...document.querySelectorAll<HTMLAnchorElement>("a[data-card-link]")].map((link) =>
      new URL(link.getAttribute("href") ?? "", web.url).searchParams.get("id"),
    );
  expect(entries(await queue())).toEqual(["demo:ADR-0", "demo:EXP-0"]);
  const page = parseDOM((await readWebPage(web, "/review?id=demo:ADR-0")).html).window.document;
  const form = page.querySelector<HTMLFormElement>("form[data-review]");
  if (!form) throw new Error("Missing review action");
  expect(form.querySelectorAll('input:not([type="hidden"])')).toHaveLength(0);
  expect(form.querySelectorAll("button")).toHaveLength(1);
  expect(form.querySelector("button")?.textContent).toBe("Confirm review");
  const values = Object.fromEntries(
    [...form.querySelectorAll<HTMLInputElement>("input")].map((input) => [input.name, input.value]),
  );
  const response = await postWebForm(web, form.getAttribute("action") ?? "", values);
  expect(response.status).toBe(200);
  expect(entries(await queue())).toEqual(["demo:EXP-0"]);
  approve(root, experiment);
  const remaining = parseDOM((await readWebPage(web, "/review?id=demo:EXP-0")).html).window.document;
  expect(
    [...remaining.querySelectorAll<HTMLInputElement>('form[data-review] input[name="path"]')].map(
      (input) => input.value,
    ),
  ).toEqual([note]);
  approve(root, note);
  expect(entries(await queue())).toEqual([]);
  expect((await queue()).querySelector(".empty")?.textContent).toBe("No protected changes.");
  writeFileSync(join(root, adr), text("A new decision edit."));
  expect(entries(await queue())).toEqual(["demo:ADR-0"]);
  writeFileSync(join(root, "workbench/CHARTER.md"), "# Charter\n\nChanged human intent.\n");
  const charter = parseDOM((await readWebPage(web, "/review?id=demo:CHARTER")).html).window.document;
  const action = charter.querySelector<HTMLFormElement>("form[data-review]");
  expect(action?.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  expect(action?.querySelector("button")?.textContent).toBe("Confirm review of human-written charter");
  expect(action?.querySelector<HTMLInputElement>('input[name="human_written"]')?.value).toBe("yes");
});
