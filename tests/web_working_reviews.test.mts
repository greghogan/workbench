import { expect, test, vi } from "vitest";
import * as differences from "../src/web/diff.ts";
import { mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import {
  ReviewSource,
  stagedReview,
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
  const change = stagedReview(root, ReviewSource.Working).changes.find((change) => change.path === file);
  if (!change) throw new Error("missing working review fixture");
  return change;
};
test("working approval carries over only when the exact reviewed contents are staged", () => {
  const root = fixture.project();
  writeFileSync(join(root, path), text("Reviewed working contents."));
  const change = workingChange(root);
  approveReviewFiles(root, [change], false, ReviewSource.Working);
  expect(stagedReview(root).changes).toEqual([]);
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
  const staged = stagedReview(root).changes[0];
  if (!staged) throw new Error("missing staged fixture");
  writeFileSync(join(root, path), text("Working version."));
  const working = workingChange(root);
  approveReviewFiles(root, [working], false, ReviewSource.Working);
  expect(stagedReview(root).changes[0]?.approved).toBe(false);
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
  expect(snapshot.documents.get("demo:ADR-0")?.reviewedAt).toBe("");
  expect(snapshot.documents.get("demo:ADR-0")?.reviewed.difference?.patch).toContain("Keep files authoritative.");
  approveReviewFiles(root, [workingChange(root)], false, ReviewSource.Working);
  writeFileSync(join(root, path), text("Second revised sentence."));
  snapshot = new WorkspaceCollector(root).collect();
  const document = snapshot.documents.get("demo:ADR-0");
  expect(document?.reviewedAt).not.toBe("");
  expect(document?.reviewed.difference?.patch).toContain("-First reviewed sentence.");
  expect(document?.reviewed.difference?.patch).toContain("+Second revised sentence.");
  expect(document?.reviewed.difference?.patch).not.toContain("Keep files authoritative.");
  expect(document?.head.difference?.patch).toContain("Keep files authoritative.");
  git(root, "add", path);
  git(root, "commit", "-qm", "New commit baseline");
  expect(reviewedBaselines(root).has(path)).toBe(false);
  expect(new WorkspaceCollector(root).collect().documents.get("demo:ADR-0")?.reviewed.difference?.patch).toBe("");
  const added = "workbench/decisions/ADR-01.md";
  writeFileSync(join(root, added), text("New record."));
  snapshot = new WorkspaceCollector(root).collect();
  expect(snapshot.documents.get("demo:ADR-1")?.reviewed.difference?.patch).toContain("+New record.");
  expect(original).toContain("Keep files authoritative.");
});
test("a failed HEAD comparison preserves an independently available reviewed comparison", () => {
  const root = fixture.project();
  writeFileSync(join(root, path), text("Reviewed sentence."));
  approveReviewFiles(root, [workingChange(root)], false, ReviewSource.Working);
  writeFileSync(join(root, path), text("Revised sentence."));
  const failedHead = vi.spyOn(differences, "workingDiff").mockImplementationOnce(() => {
    throw new Error("Fixture HEAD failure");
  });
  try {
    const document = new WorkspaceCollector(root).collect().documents.get("demo:ADR-0");
    expect(document?.head).toMatchObject({ state: "unavailable", problem: "Fixture HEAD failure" });
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
  const changes = stagedReview(root, ReviewSource.Working).changes;
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
test("the queue includes working files, offers differing versions, and confirms the exact selected version", async () => {
  const root = fixture.project();
  writeFileSync(join(root, path), text("Staged sentence."));
  git(root, "add", path);
  writeFileSync(join(root, path), text("Working sentence."));
  const web = await fixture.start(root);
  let { html } = await readWebPage(web, "/review");
  const dom = new JSDOM(html, { url: web.url }).window.document;
  const rows = [...dom.querySelectorAll("a.record-row")];
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.textContent).join(" ")).toMatch(/Working file/);
  expect(rows.map((row) => row.textContent).join(" ")).toMatch(/Staged file/);
  ({ html } = await readWebPage(web, `/review?path=${path}&review_source=working&view=raw`));
  expect(html).toContain("Working sentence.");
  expect(html).toContain("View the differing staged version");
  const values = {
    csrf: hiddenValue(html, "csrf"),
    path,
    digest: hiddenValue(html, "digest"),
    review_source: hiddenValue(html, "review_source"),
    reviewed: "yes",
  };
  const response = await postWebForm(web, "/actions/approve", values);
  expect(response.status).toBe(200);
  expect(workingChange(root).approved).toBe(true);
  expect(stagedReview(root).changes[0]?.approved).toBe(false);
  writeFileSync(join(root, path), text("Changed after opening review."));
  const stale = await postWebForm(web, "/actions/approve", values);
  expect(stale.status).toBe(409);
  const download = await fetch(
    `${web.url}/review-file?path=${path}&review_source=working&digest=${values.digest}&side=after`,
  );
  expect(download.status).toBe(409);
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
  expect(stagedReview(root).changes[0]?.digest).not.toBe(change.digest);
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
  expect(stagedReview(root).changes.find((change) => change.path === path)?.approved).toBe(true);
});

test("permission-only staged changes remain visible before approval", async () => {
  const root = fixture.project();
  git(root, "update-index", "--chmod=+x", path);
  const web = await fixture.start(root);
  const { html } = await readWebPage(web, `/review?path=${path}&view=changes`);
  const document = new JSDOM(html, { url: web.url }).window.document;
  expect(document.querySelector("[data-file-mode]")?.textContent).toBe("File mode: 100644 → 100755");
  expect(stagedReview(root).changes[0]?.approved).toBe(false);
});

test("ADR review defaults to Changes, with independent Read and Raw views of the exact version", async () => {
  const root = fixture.project();
  const contents = text("A proposed decision.");
  writeFileSync(join(root, path), contents);
  const web = await fixture.start(root);
  const read = async (view = "") =>
    new JSDOM(
      (await readWebPage(web, `/review?path=${path}&review_source=working${view ? `&view=${view}` : ""}`)).html,
      { url: web.url },
    ).window.document;
  const changes = await read();
  const tabs = changes.querySelector('nav[aria-label="Reviewed file views"]');
  expect([...(tabs?.querySelectorAll("a") ?? [])].map((tab) => tab.textContent)).toEqual(["Changes", "Read", "Raw"]);
  expect(tabs?.querySelector('[aria-current="page"]')?.textContent).toBe("Changes");
  expect(changes.querySelector(".paragraph-diff")).not.toBeNull();
  expect((await read("read")).querySelector(".document")?.textContent).toContain("A proposed decision.");
  expect((await read("raw")).querySelector("pre.source")?.textContent).toBe(contents);
  expect(workingChange(root).approved).toBe(false);
  expect((await readWebPage(web, `/review?path=${path}&view=invalid`)).response.status).toBe(400);
});

test("review headings identify the exact version once, with a linked queue parent", async () => {
  const root = fixture.project();
  writeFileSync(join(root, path), "# ADR-0: Staged title\n\nStaged contents.\n");
  git(root, "add", path);
  writeFileSync(join(root, path), "# ADR-0: Working title\n\nWorking contents.\n");
  const web = await fixture.start(root);
  const queue = new JSDOM((await readWebPage(web, "/review")).html).window.document;
  expect(queue.querySelector("main")?.textContent).not.toContain("Approve files independently");
  expect(queue.querySelector("main")?.textContent).not.toContain("The UI does not stage or commit");
  for (const source of ["staged", "working"]) {
    const document = new JSDOM(
      (await readWebPage(web, `/review?path=${path}&review_source=${source}&view=read`)).html,
      { url: web.url },
    ).window.document;
    expect([...document.querySelectorAll("main h1")].map((heading) => heading.textContent)).toEqual([
      `ADR-0: ${source === "staged" ? "Staged" : "Working"} title`,
    ]);
    expect(document.querySelector(".document h2")).toBeNull();
    const links = [...document.querySelectorAll('nav[aria-label="Breadcrumb"] a')];
    expect(links.map((link) => link.textContent)).toEqual(["demo", "Review queue"]);
    expect(new URL(links.at(-1)?.getAttribute("href") ?? "", web.url).searchParams.has("path")).toBe(false);
  }
});

test("review comparisons always use the last acknowledgment and visibly preserve the selected layout", async () => {
  const root = fixture.project();
  writeFileSync(join(root, path), text("A reviewed version."));
  approveReviewFiles(root, [workingChange(root)], false, ReviewSource.Working);
  writeFileSync(join(root, path), text("A revised version."));
  const web = await fixture.start(root);
  const first = new JSDOM((await readWebPage(web, `/review?path=${path}&review_source=working&baseline=head`)).html, {
    url: web.url,
  }).window.document;
  const paragraph = first.querySelector(".diff-content")?.cloneNode(true) as Element;
  for (const added of paragraph.querySelectorAll("ins,.diff-separator")) added.remove();
  expect(paragraph.textContent).toBe("A reviewed version.");
  const control = first.querySelector('nav[aria-label="Difference layout"]');
  expect(control?.querySelector('[aria-current="page"]')?.textContent).toBe("Inline paragraphs");
  expect(first.querySelector("main")?.textContent).not.toContain("Compare since last review");
  expect(first.querySelector("main")?.textContent).not.toContain("Compare with committed HEAD");
  expect(first.querySelector("main")?.textContent).not.toContain("Committed HEAD");
  expect(first.querySelector("main")?.textContent).not.toContain("This review covers");
  expect(first.querySelector('main a[href*="/review-file"]')).toBeNull();
  expect(first.querySelector("h1")?.textContent).toBe("ADR-0: Files");
  expect(
    [...first.querySelectorAll("main a")].filter((link) => link.textContent.includes("Review queue")),
  ).toHaveLength(1);
  expect(first.querySelector('.panel-controls nav[aria-label="Reviewed file views"]')).not.toBeNull();
  expect(first.querySelector('.panel-controls nav[aria-label="Difference layout"]')).not.toBeNull();
  const link = [...(control?.querySelectorAll("a") ?? [])].find((a) => a.textContent === "Side-by-side");
  const second = new JSDOM((await readWebPage(web, link?.getAttribute("href") ?? "")).html, { url: web.url }).window
    .document;
  expect(second.querySelector('nav[aria-label="Difference layout"] [aria-current="page"]')?.textContent).toBe(
    "Side-by-side",
  );
  expect(second.querySelector(".diff.split")?.textContent).toContain("A reviewed version.");
  for (const tab of second.querySelectorAll('nav[aria-label="Reviewed file views"] a'))
    expect(new URL(tab.getAttribute("href") ?? "", web.url).searchParams.get("layout")).toBe("split");
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
    let location = `/review?path=${path}&review_source=working&layout=split`;
    for (const [index, expected] of (skipMiddle ? [path, last] : [path, middle, last]).entries()) {
      expect(new URL(location, web.url).searchParams.get("path")).toBe(expected);
      const document = new JSDOM((await readWebPage(web, location)).html, { url: web.url }).window.document;
      const navigation = document.querySelector('nav[aria-label="Review queue navigation"]');
      expect(navigation?.textContent).toContain(`${String(expected === last ? 3 : index + 1)} of 3`);
      expect(navigation?.querySelector('a[rel="prev"]') !== null).toBe(expected !== path);
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
  for (const [file] of files) {
    const document = new JSDOM((await readWebPage(web, `/review?path=${file}`)).html, { url: web.url }).window.document;
    const tabs = document.querySelector('nav[aria-label="Reviewed file views"]');
    expect([...(tabs?.querySelectorAll("a") ?? [])].map((tab) => tab.textContent)).toEqual(
      file.endsWith(".md") ? ["Read", "Raw"] : ["Raw"],
    );
    expect(tabs?.querySelector('[aria-current="page"]')?.textContent).toBe(file.endsWith(".md") ? "Read" : "Raw");
    if (file.endsWith(".bin")) expect(document.querySelector("main")?.textContent).toContain("Download and inspect it");
  }
});
