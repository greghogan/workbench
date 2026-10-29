import { expect, test, vi } from "vitest";
import * as differences from "../src/web/diff.ts";
import { mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { parseDOM } from "./fixtures/dom.mjs";
import {
  ReviewSource,
  reviewStatus,
  approveReviewFiles,
  reviewedBaselines,
  workingReviewContents,
} from "../src/review-service.ts";
import { checkReview } from "../src/review.ts";
import { WorkspaceCollector } from "../src/workspace-service.ts";
import { webServers, readWebPage, postWebForm, hiddenValue } from "./fixtures/web.mjs";
import { git } from "./fixtures/adoption.mjs";
const fixture = webServers();
const path = "workbench/decisions/ADR-00.md";
const text = (body: string) => `---\nsummary: Review files.\n---\n\n# ADR-0: Files\n\n${body}\n`;
const workingChange = (root: string, file = path) => {
  const change = reviewStatus(root, ReviewSource.Working).changes.find((change) => change.path === file);
  if (!change) throw new Error("missing working review fixture");
  return change;
};
test("working approval carries over only when the exact reviewed contents are staged", () => {
  const root = fixture.project();
  writeFileSync(join(root, path), text("Reviewed working contents."));
  const change = workingChange(root);
  approveReviewFiles(root, [change], false, ReviewSource.Working);
  expect(reviewStatus(root, ReviewSource.Staged).changes).toEqual([]);
  expect(workingChange(root).approved).toBe(true);
  git(root, "add", path);
  checkReview(root);
  writeFileSync(join(root, path), text("Later unreviewed edit."));
  expect(workingChange(root).approved).toBe(false);
  checkReview(root); // the unchanged staged version remains approved
  git(root, "add", path);
  expect(() => {
    checkReview(root);
  }).toThrow(/human review/);
  expect(() => {
    approveReviewFiles(root, [change], false, ReviewSource.Working);
  }).toThrow(/digest changed/);
});
test("differing staged and working versions retain independent approvals and the latest review baseline", () => {
  const root = fixture.project();
  writeFileSync(join(root, path), text("Staged version."));
  git(root, "add", path);
  const staged = reviewStatus(root, ReviewSource.Staged).changes[0];
  if (!staged) throw new Error("missing staged fixture");
  writeFileSync(join(root, path), text("Working version."));
  const working = workingChange(root);
  approveReviewFiles(root, [working], false, ReviewSource.Working);
  expect(reviewStatus(root, ReviewSource.Staged).changes[0]?.approved).toBe(false);
  approveReviewFiles(root, [staged], false);
  checkReview(root);
  expect(workingChange(root).approved).toBe(true);
  expect(reviewedBaselines(root).get(path)?.contents).toBe(text("Staged version."));
  approveReviewFiles(root, [working], false, ReviewSource.Working);
  expect(reviewedBaselines(root).get(path)?.contents).toBe(text("Working version."));
  checkReview(root);
});
test("last-review comparisons fall back to HEAD or empty, survive collector restart, and reset after commit", () => {
  const root = fixture.project();
  const original = readFileSync(join(root, path), "utf8");
  writeFileSync(join(root, path), text("First reviewed sentence."));
  let snapshot = new WorkspaceCollector(root).collect();
  expect(snapshot.documents.get("demo:ADR-0")?.baseline.kind).toBe("commit");
  expect(snapshot.documents.get("demo:ADR-0")?.reviewed.difference?.patch).toContain("Keep files authoritative.");
  approveReviewFiles(root, [workingChange(root)], false, ReviewSource.Working);
  writeFileSync(join(root, path), text("Second revised sentence."));
  snapshot = new WorkspaceCollector(root).collect();
  const document = snapshot.documents.get("demo:ADR-0");
  expect(document?.baseline.kind).toBe("review");
  expect(document?.reviewed.difference?.patch).toContain("-First reviewed sentence.");
  expect(document?.reviewed.difference?.patch).toContain("+Second revised sentence.");
  expect(document?.reviewed.difference?.patch).not.toContain("Keep files authoritative.");
  approveReviewFiles(root, [workingChange(root)], false, ReviewSource.Working);
  git(root, "add", path);
  checkReview(root);
  git(root, "commit", "-qm", "New commit baseline");
  expect(reviewedBaselines(root).has(path)).toBe(false);
  expect(new WorkspaceCollector(root).collect().documents.get("demo:ADR-0")?.reviewed.difference?.patch).toBe("");
  const added = "workbench/decisions/ADR-01.md";
  writeFileSync(join(root, added), text("New record."));
  snapshot = new WorkspaceCollector(root).collect();
  expect(snapshot.documents.get("demo:ADR-1")?.reviewed.difference?.patch).toContain("+New record.");
  expect(original).toContain("Keep files authoritative.");
});
test("a reviewed baseline does not require another committed comparison", () => {
  const root = fixture.project();
  writeFileSync(join(root, path), text("Reviewed sentence."));
  approveReviewFiles(root, [workingChange(root)], false, ReviewSource.Working);
  writeFileSync(join(root, path), text("Revised sentence."));
  const failedHead = vi.spyOn(differences, "workingDiff").mockImplementationOnce(() => {
    throw new Error("Fixture HEAD failure");
  });
  try {
    const document = new WorkspaceCollector(root).collect().documents.get("demo:ADR-0");
    expect(failedHead).not.toHaveBeenCalled();
    expect(document?.reviewed.state).toBe("available");
    expect(document?.reviewed.difference?.patch).toContain("-Reviewed sentence.");
    expect(document?.reviewed.difference?.patch).toContain("+Revised sentence.");
    expect(document?.contents).toContain("Revised sentence.");
  } finally {
    failedHead.mockRestore();
  }
});
test("working additions, deletions, and supporting files have individual acknowledgments and charter attestation", () => {
  const root = fixture.project();
  const charter = "workbench/CHARTER.md",
    support = "workbench/experiments/EXP-00/evidence.bin";
  writeFileSync(join(root, charter), "# Human intent\n\nChanged purpose.\n");
  mkdirSync(join(root, "workbench/experiments/EXP-00"), { recursive: true });
  writeFileSync(join(root, support), Buffer.from([1, 0, 2, 3]));
  rmSync(join(root, path));
  const changes = reviewStatus(root, ReviewSource.Working).changes;
  expect(changes.map((change) => change.path)).toEqual([charter, path, support]);
  const human = workingChange(root, charter);
  expect(() => {
    approveReviewFiles(root, [human], false, ReviewSource.Working);
  }).toThrow(/human authorship/);
  for (const change of changes) approveReviewFiles(root, [change], change.charter, ReviewSource.Working);
  git(root, "add", "-A");
  checkReview(root);
  expect(workingReviewContents(root, workingChange(root, support))).toEqual(Buffer.from([1, 0, 2, 3]));
});
test("review shows current contents independently of the staged commit", async () => {
  const root = fixture.project();
  writeFileSync(join(root, path), text("Staged sentence."));
  git(root, "add", path);
  writeFileSync(join(root, path), text("Working sentence."));
  const web = await fixture.start(root);
  let { html } = await readWebPage(web, "/review");
  const dom = parseDOM(html, { url: web.url }).window.document;
  const rows = [...dom.querySelectorAll("article.record-row")];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.querySelectorAll("a[data-card-link]")).toHaveLength(1);
  expect(rows[0]?.textContent).not.toMatch(/Working file|Staged file/);
  ({ html } = await readWebPage(web, `/review?path=${path}`));
  expect(parseDOM(html).window.document.querySelector(".document-diff")?.textContent).toContain("Working sentence.");
  expect(html).not.toContain("Staged sentence.");
  expect((await readWebPage(web, `/review?path=${path}&review_source=staged`)).response.status).toBe(400);
  const values = {
    csrf: hiddenValue(html, "csrf"),
    path,
    digest: hiddenValue(html, "digest"),
    reviewed: "yes",
  };
  const response = await postWebForm(web, "/actions/approve", values);
  expect(response.status).toBe(200);
  expect(workingChange(root).approved).toBe(true);
  expect(reviewStatus(root, ReviewSource.Staged).changes[0]?.approved).toBe(false);
  expect(
    new URL(((await response.json()) as { redirect: string }).redirect, web.url).searchParams.get("path"),
  ).toBeNull();
  expect(() => {
    checkReview(root);
  }).toThrow(/human review/);
  writeFileSync(join(root, path), text("Changed after opening review."));
  const stale = await postWebForm(web, "/actions/approve", values);
  expect(stale.status).toBe(200);
  expect(workingChange(root).approved).toBe(false);
  const download = await fetch(`${web.url}/review-file?path=${path}&digest=${values.digest}&side=after`);
  expect(download.status).toBe(200);
  expect(await download.text()).toBe(text("Working sentence."));
});

test("working inspection preserves Git's index and never executes clean filters", () => {
  const root = fixture.project();
  writeFileSync(join(root, path), text("Raw working bytes."));
  writeFileSync(join(root, ".gitattributes"), "workbench/decisions/*.md filter=workbench-forbidden\n");
  git(root, "config", "filter.workbench-forbidden.clean", "exit 99");
  git(root, "config", "filter.workbench-forbidden.required", "true");
  const index = join(root, ".git/index"),
    bytes = readFileSync(index),
    stat = lstatSync(index);
  expect(workingChange(root).after).toMatch(/^100644:[a-f0-9]+$/);
  expect(readFileSync(index)).toEqual(bytes);
  expect(lstatSync(index).mtimeMs).toBe(stat.mtimeMs);
});
test("Git content conversions require review of the resulting staged bytes", () => {
  const root = fixture.project();
  writeFileSync(join(root, ".gitattributes"), "workbench/decisions/*.md text eol=lf\n");
  writeFileSync(join(root, path), text("CRLF working contents.").replaceAll("\n", "\r\n"));
  const change = workingChange(root);
  approveReviewFiles(root, [change], false, ReviewSource.Working);
  git(root, "add", path);
  expect(reviewStatus(root, ReviewSource.Staged).changes[0]?.digest).not.toBe(change.digest);
  expect(() => {
    checkReview(root);
  }).toThrow(/human review/);
});
test("working review supports a repository without a first commit", () => {
  const root = fixture.project();
  git(root, "update-ref", "-d", "HEAD");
  const change = workingChange(root);
  expect(change.before).toMatch(/^000000:0+$/);
  approveReviewFiles(root, [change], false, ReviewSource.Working);
  git(root, "add", path);
  expect(reviewStatus(root, ReviewSource.Staged).changes.find((change) => change.path === path)?.approved).toBe(true);
});

test("staging a permission change does not create a web review, while the commit still requires review", async () => {
  const root = fixture.project();
  git(root, "update-index", "--chmod=+x", path);
  const web = await fixture.start(root);
  expect((await readWebPage(web, "/review")).html).toContain("No protected changes.");
  expect((await readWebPage(web, `/review?path=${path}`)).response.status).toBe(404);
  expect(reviewStatus(root, ReviewSource.Staged).changes[0]?.approved).toBe(false);
  expect(() => {
    checkReview(root);
  }).toThrow(/human review/);
});

test("ADR review compares the last acknowledgment in two complete, navigable layouts", async () => {
  const root = fixture.project();
  writeFileSync(join(root, path), text("A reviewed version."));
  approveReviewFiles(root, [workingChange(root)], false, ReviewSource.Working);
  writeFileSync(join(root, path), text("A revised version."));
  const web = await fixture.start(root);
  const first = parseDOM((await readWebPage(web, `/review?path=${path}`)).html, { url: web.url }).window.document;
  const control = first.querySelector('nav[aria-label="Difference layout"]');
  expect([...(control?.querySelectorAll("a") ?? [])].map((tab) => tab.textContent)).toEqual([
    "Unified",
    "Side-by-side",
  ]);
  expect(control?.querySelector('[aria-current="page"]')?.textContent).toBe("Unified");
  expect(first.querySelector('nav[aria-label="Reviewed file views"]')).toBeNull();
  expect(first.querySelector("details.source-comparison")).toBeNull();
  expect(first.querySelector('main a[href*="/review-file"]')).toBeNull();
  expect(first.querySelector("h1")?.textContent).toBe("ADR-0: Files");
  expect(
    [...first.querySelectorAll("main a")].filter((link) => link.textContent.includes("Review queue")),
  ).toHaveLength(1);
  const paragraph = first.querySelector(".document-diff p")?.cloneNode(true) as Element;
  for (const added of paragraph.querySelectorAll("ins,.diff-separator")) added.remove();
  expect(paragraph.textContent.trim()).toBe("A reviewed version.");
  expect(first.querySelector(".document-diff")?.textContent).toContain("revised");
  const link = [...(control?.querySelectorAll("a") ?? [])].find((a) => a.textContent === "Side-by-side");
  expect(link).toHaveProperty("pathname", "/review");
  const second = parseDOM((await readWebPage(web, link?.getAttribute("href") ?? "")).html, { url: web.url }).window
    .document;
  expect(second.querySelector('nav[aria-label="Difference layout"] [aria-current="page"]')?.textContent).toBe(
    "Side-by-side",
  );
  expect(second.querySelector('[data-diff-side="before"] .document')?.textContent).toContain("A reviewed version.");
  expect(second.querySelector('[data-diff-side="after"] .document')?.textContent).toContain("A revised version.");
  expect(second.querySelector("form[data-review]")).not.toBeNull();
  expect(workingChange(root).approved).toBe(false);
  for (const view of ["previous", "current", "raw", "invalid"])
    expect((await readWebPage(web, `/review?path=${path}&view=${view}`)).response.status).toBe(400);
  expect((await readWebPage(web, `/review?path=${path}&baseline=head`)).response.status).toBe(400);
});

test("review headings identify the exact version once, with a linked queue parent", async () => {
  const root = fixture.project();
  writeFileSync(join(root, path), "# ADR-0: Staged title\n\nStaged contents.\n");
  git(root, "add", path);
  writeFileSync(join(root, path), "# ADR-0: Working title\n\nWorking contents.\n");
  const web = await fixture.start(root);
  const document = parseDOM((await readWebPage(web, `/review?path=${path}`)).html, { url: web.url }).window.document;
  expect([...document.querySelectorAll("main h1")].map((heading) => heading.textContent)).toEqual([
    "ADR-0: Working title",
  ]);
  expect(document.querySelector(".document-diff ins")?.textContent).toContain("Working");
  const links = [...document.querySelectorAll('nav[aria-label="Breadcrumb"] a')];
  expect(links.map((link) => link.textContent)).toEqual(["demo", "Review queue"]);
  expect(new URL(links.at(-1)?.getAttribute("href") ?? "", web.url).searchParams.has("path")).toBe(false);
});

test.each([false, true])(
  "review navigation advances through files, skips prior approvals (%s), and ends at the queue",
  async (skipMiddle) => {
    const root = fixture.project();
    const middle = "workbench/decisions/ADR-01.md",
      last = "workbench/experiments/EXP-00.md";
    writeFileSync(join(root, path), text("First revision."));
    writeFileSync(join(root, middle), "# ADR-1: Second\n\nSecond revision.\n");
    mkdirSync(join(root, "workbench/experiments"), { recursive: true });
    writeFileSync(join(root, last), "---\nstatus: Planned\n---\n\n# EXP-0: Evidence\n\nReview evidence.\n");
    if (skipMiddle) approveReviewFiles(root, [workingChange(root, middle)], false, ReviewSource.Working);
    const web = await fixture.start(root);
    let location = "/review?id=demo:ADR-0&layout=split";
    for (const [index, expected] of (skipMiddle ? [path, last] : [path, middle, last]).entries()) {
      expect(new URL(location, web.url).searchParams.get("id")).toBe(
        expected === path ? "demo:ADR-0" : expected === middle ? "demo:ADR-1" : "demo:EXP-0",
      );
      const document = parseDOM((await readWebPage(web, location)).html, { url: web.url }).window.document;
      const navigation = document.querySelector('nav[aria-label="Review queue navigation"]');
      expect(navigation?.textContent).toContain(`1 of ${String((skipMiddle ? 2 : 3) - index)}`);
      expect(navigation?.querySelector('a[rel="prev"]')).toBeNull();
      expect(navigation?.querySelector('a[rel="next"]') !== null).toBe(expected !== last);
      const form = document.querySelector("form[data-review]");
      const values = Object.fromEntries(
        [...(form?.querySelectorAll<HTMLInputElement>('input[type="hidden"]') ?? [])].map((input) => [
          input.name,
          input.value,
        ]),
      );
      const response = await postWebForm(web, "/actions/approve", { ...values, reviewed: "yes" });
      expect(response.status).toBe(200);
      const result = (await response.json()) as { redirect: string };
      location = result.redirect;
      expect(workingChange(root, expected).approved).toBe(true);
      if (expected !== last) expect(new URL(location, web.url).searchParams.get("layout")).toBe("split");
    }
    expect(new URL(location, web.url).pathname).toBe("/review");
    expect(new URL(location, web.url).searchParams.has("path")).toBe(false);
  },
);

test("supporting file reviews offer only applicable views and keep binary inspection explicit", async () => {
  const root = fixture.project();
  mkdirSync(join(root, "workbench/experiments/EXP-00"), { recursive: true });
  const files = [
    [
      "workbench/experiments/EXP-00.md",
      Buffer.from("---\nstatus: Planned\n---\n\n# Experiment\n\nInspect this evidence.\n"),
    ],
    ["workbench/experiments/EXP-00/evidence.txt", Buffer.from("Plain evidence.\n")],
    ["workbench/experiments/EXP-00/evidence.bin", Buffer.from([0, 1, 2, 3])],
  ] as const;
  for (const [file, bytes] of files) writeFileSync(join(root, file), bytes);
  const web = await fixture.start(root);
  const queue = parseDOM((await readWebPage(web, "/review")).html, { url: web.url }).window.document;
  const links = [...queue.querySelectorAll("article.record-row a[data-card-link]")];
  expect(links).toHaveLength(1);
  expect(new URL(links[0]?.getAttribute("href") ?? "", web.url).searchParams.get("id")).toBe("demo:EXP-0");
  const document = parseDOM((await readWebPage(web, links[0]?.getAttribute("href") ?? "")).html, { url: web.url })
    .window.document;
  expect(document.querySelector('nav[aria-label="Review queue navigation"]')?.textContent).toContain("1 of 1");
  for (const [file] of files) {
    const section = document.querySelector(`[data-review-file="${file}"]`);
    expect(section).not.toBeNull();
    if (file.endsWith(".md")) expect(section?.querySelector('[aria-current="page"]')?.textContent).toBe("Current");
    else expect(section?.querySelector('nav[aria-label="Reviewed file views"]')).toBeNull();
    if (file.endsWith(".bin")) expect(section?.textContent).toContain("Download and inspect it");
    if (file.endsWith(".txt")) expect(section?.querySelector("pre")?.textContent).toBe("Plain evidence.\n");
    const form = section?.querySelector("form[data-review]");
    const values = Object.fromEntries(
      [...(form?.querySelectorAll<HTMLInputElement>('input[type="hidden"]') ?? [])].map((input) => [
        input.name,
        input.value,
      ]),
    );
    const response = await postWebForm(web, "/actions/approve", { ...values, reviewed: "yes" });
    expect(response.status).toBe(200);
    expect(workingChange(root, file).approved).toBe(true);
    const redirect = ((await response.json()) as { redirect: string }).redirect;
    expect(new URL(redirect, web.url).searchParams.get("id")).toBe(file === files.at(-1)?.[0] ? null : "demo:EXP-0");
  }
});

test("a supporting-only change opens its unchanged record and retains exact per-file review", async () => {
  const root = fixture.project(),
    owner = "workbench/experiments/EXP-00.md",
    supporting = "workbench/experiments/EXP-00/notes.txt";
  mkdirSync(join(root, "workbench/experiments/EXP-00"), { recursive: true });
  writeFileSync(join(root, owner), "# EXP-0: Search protocol\n\nThe unchanged protocol.\n");
  writeFileSync(join(root, supporting), "Original notes.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Protocol baseline");
  writeFileSync(join(root, supporting), "Revised notes.\n");
  const web = await fixture.start(root);
  const queue = parseDOM((await readWebPage(web, "/review")).html, { url: web.url }).window.document;
  const href = queue.querySelector("article.record-row a[data-card-link]")?.getAttribute("href") ?? "";
  expect(new URL(href, web.url).searchParams.get("id")).toBe("demo:EXP-0");
  const document = parseDOM((await readWebPage(web, href)).html, { url: web.url }).window.document;
  expect(document.querySelector(".document")?.textContent).toContain("The unchanged protocol.");
  expect(document.querySelectorAll("form[data-review]")).toHaveLength(1);
  expect(document.querySelector(`[data-review-file="${supporting}"] pre`)?.textContent).toBe("Revised notes.\n");
  expect(document.querySelector('input[name="path"]')?.getAttribute("value")).toBe(supporting);
});
