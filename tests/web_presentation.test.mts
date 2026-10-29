import { WorkspaceCollector, WorkspaceIndex } from "../src/workspace-service.ts";
import { reviewPage } from "../src/web/review-page.tsx";
import { beforeEach, expect, test } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { startWebServer } from "../src/web/server.ts";
import { webServers, readWebPage, postWebForm } from "./fixtures/web.mjs";
import { provider, git } from "./fixtures/adoption.mjs";
import { previewCollection, applyCollection } from "../src/web/collection-service.ts";
import { citationMetadata } from "../src/record-metadata.ts";
import { parseDOM } from "./fixtures/dom.mjs";
const servers = webServers();
let root: string;
let web: Awaited<ReturnType<typeof startWebServer>> | undefined;
beforeEach(() => {
  root = servers.project();
  web = undefined;
});
async function get(path: string) {
  web ??= await servers.start(root, { port: 0 });
  return readWebPage(web, path);
}
const recordIds = (html: string) =>
  [...parseDOM(html).window.document.querySelectorAll("[data-record-id]")].map((element) =>
    element.getAttribute("data-record-id"),
  );
const headings = (html: string) =>
  [...parseDOM(html).window.document.querySelectorAll("h2")].map((element) => element.textContent);
const reviewIds = (html: string) =>
  [...parseDOM(html).window.document.querySelectorAll("article.record-row a[data-card-link]")].map((element) =>
    element.closest("[data-record-id]")?.getAttribute("data-record-id"),
  );
function adopt() {
  const source = provider(root);
  const request = { source: source.directory, commit: source.commit, collection: ".", visibility: "public" as const };
  const plan = previewCollection(root, request);
  applyCollection(root, request, plan.digest);
  return source;
}

test("prose record references receive scoped links and preview metadata without nesting links or changing code", async () => {
  adopt();
  writeFileSync(
    join(root, "workbench/decisions/ADR-01.md"),
    "---\nsummary: Reference navigation.\n---\n\n# ADR-1: References\n\nSee ADR-0 and demo:ADR-0 and company:ADR-0. Unknown ADR-Z stays text.\n\n[Existing ADR-0](ADR-00.md) and [External ADR-0](https://example.invalid/ADR-0).\n\n`ADR-0`\n\n```text\nADR-0\n```\n",
  );
  const document = parseDOM((await get("/records/demo:ADR-1")).html).window.document;
  const references = [...document.querySelectorAll(".document p a[data-record-reference]")];
  expect(references.map((link) => link.getAttribute("data-record-reference"))).toEqual([
    "demo:ADR-0",
    "demo:ADR-0",
    "company:ADR-0",
    "demo:ADR-0",
  ]);
  expect(references[0]?.getAttribute("data-record-summary")).toBe("Keep files authoritative.");
  expect(document.querySelector("a a")).toBeNull();
  expect(document.querySelector("code a")).toBeNull();
  expect(document.querySelector('a[data-record-reference="demo:ADR-Z"]')).toBeNull();
  expect(document.querySelector('a[href="https://example.invalid/ADR-0"]')?.hasAttribute("data-record-reference")).toBe(
    false,
  );
});

test("record navigation stays beside the pane, follows record identity, and keeps collections separate", async () => {
  adopt();
  for (const number of [1, 2])
    writeFileSync(
      join(root, `workbench/decisions/ADR-0${String(number)}.md`),
      `---\nsummary: Decision ${String(number)}.\n---\n\n# ADR-${String(number)}: Decision ${String(number)}\n\nDecision contents.\n`,
    );
  const page = parseDOM((await get("/records/demo:ADR-1")).html).window.document;
  expect(page.querySelector('.record-pane a[rel="prev"]')?.getAttribute("href")).toContain("/records/demo:ADR-0");
  expect(page.querySelector('.record-pane a[rel="next"]')?.getAttribute("href")).toContain("/records/demo:ADR-2");
  expect(page.querySelector(".record-pane-content > .panel")).not.toBeNull();
  expect(page.querySelector('[aria-label="Previous record"]')).not.toBeNull();
  const first = parseDOM((await get("/records/demo:ADR-0")).html).window.document;
  expect(first.querySelector('.record-step:disabled[aria-label="Previous record"]')).not.toBeNull();
  const collection = parseDOM((await get("/records/company:ADR-0")).html).window.document;
  expect(collection.querySelector('.record-pane a[rel="next"]')).toBeNull();
  const charter = parseDOM((await get("/records/demo:CHARTER")).html).window.document;
  expect(charter.querySelector(".record-pane-content > .panel")).not.toBeNull();
});
test("project records and each collection have separate browsing and a unified review queue", async () => {
  adopt();
  const project = await get("/records?type=ADR");
  expect(parseDOM(project.html).window.document.querySelector('[aria-label="Record sources"]')).not.toBeNull();
  expect(recordIds(project.html)).toContain("demo:ADR-0");
  expect(recordIds(project.html)).not.toContain("company:ADR-0");
  const collection = await get("/records?type=ADR&collection=company");
  expect(recordIds(collection.html)).toContain("company:ADR-0");
  expect(recordIds(collection.html)).not.toContain("demo:ADR-0");
  const collectionSearch = parseDOM(collection.html).window.document.querySelector('form[role="search"]');
  expect(collectionSearch?.querySelector('input[name="all"]')).toBeNull();
  expect(collectionSearch?.querySelector('input[name="collection"]')?.getAttribute("value")).toBe("company");
  expect((await get("/records?q=Policy")).html).toContain("No matching records");
  expect(recordIds((await get("/records?q=Policy&collection=company")).html)).toContain("company:ADR-0");
  const collectionDocument = parseDOM((await get("/records/company:ADR-0")).html).window.document;
  expect(collectionDocument.querySelector('[data-source-navigation] a[aria-current="page"]')?.textContent).toBe(
    "company",
  );
  git(root, "add", "workbench");
  const queue = await get("/review");
  expect(reviewIds(queue.html)).toContain("company:ADR-0");
  expect((await get("/review?collection=company")).response.status).toBe(400);
  expect((await get("/records?collection=missing")).response.status).toBe(404);
});
test("the web collection preview accepts all imported records in one submission", async () => {
  const source = provider(root);
  const page = parseDOM((await get("/collections")).html).window.document;
  const csrf = page.querySelector<HTMLInputElement>('input[name="csrf"]')?.value ?? "";
  if (!web) throw new Error("Missing web server");
  const preview = await postWebForm(web, "/actions/collection-preview", {
    csrf,
    source: source.directory,
    commit: source.commit,
    collection: ".",
    visibility: "public",
  });
  expect(preview.status).toBe(200);
  const target = (await preview.json()) as { redirect: string };
  const proposal = parseDOM((await get(target.redirect)).html).window.document;
  const accept = [...proposal.querySelectorAll<HTMLFormElement>("form")].find(
    (form) => form.querySelector("button")?.textContent === "Accept all",
  );
  expect(proposal.body.textContent).toContain("Adopt for review");
  if (!accept) throw new Error("Missing collection acceptance choice");
  const fields = Object.fromEntries(
    [...accept.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [input.name, input.value]),
  );
  expect((await postWebForm(web, accept.getAttribute("action") ?? "", fields)).status).toBe(200);
  const queue = await get("/review");
  expect(reviewIds(queue.html)).not.toContain("company:ADR-0");
  expect((await get("/records/company:ADR-0")).html).toContain("Use a bounded retry budget.");
  expect(git(root, "diff", "--cached", "--name-only")).toBe("");
});
test("upstream adaptations remain visible after commit, with separate HEAD and upstream comparisons", async () => {
  adopt();
  const path = join(root, "workbench/collections/company/decisions/ADR-00.md");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("Use a bounded retry budget.", "Use project-specific bounded retries."),
  );
  git(root, "add", "workbench", ".gitmodules");
  git(root, "commit", "-qm", "Adapt collection");
  const list = await get("/records?collection=company&type=ADR");
  expect(list.html).toContain("Adapted");
  const upstream = await get("/records/company:ADR-0?view=changes");
  expect(upstream.html).toContain("Pinned upstream → project copy");
  for (const [side, text] of [
    ["before", "Use a bounded retry budget."],
    ["after", "Use project-specific bounded retries."],
  ]) {
    const dom = parseDOM(upstream.html),
      region = dom.window.document.querySelector(".document-diff");
    for (const mark of region?.querySelectorAll(`${side === "before" ? "ins" : "del"}, .diff-separator`) ?? [])
      mark.remove();
    expect(region?.textContent).toContain(text);
    dom.window.close();
  }
  const unchanged = parseDOM((await get("/records/company:ADR-0?view=changes&baseline=reviewed")).html).window.document;
  expect(unchanged.body.textContent).toContain("No changes.");
  expect(unchanged.querySelectorAll(".document-diff ins,.document-diff del")).toHaveLength(0);
  rmSync(path);
  const removed = await get("/records/company:ADR-0?collection=company&view=changes");
  expect(removed.response.status).toBe(200);
  expect(removed.html).toContain("Removed from collection");
  expect(removed.html).toContain("Side-by-side");
  const removedHead = await get(
    "/records/company:ADR-0?collection=company&view=changes&baseline=reviewed&layout=split",
  );
  expect(removedHead.html).toContain("Reviewed record → current file");
  expect(parseDOM(removedHead.html).window.document.querySelector(".document-diff.split")).not.toBeNull();
  expect((await get("/records/company:ADR-0?collection=company&view=source")).response.status).toBe(400);
});
test("adopted ADRs can be edited in the browser while preserving upstream and rejecting stale saves", async () => {
  const source = adopt();
  const editor = parseDOM((await get("/records/company:ADR-0?view=edit")).html).window.document;
  const form = editor.querySelector<HTMLFormElement>("form[data-editor]");
  if (!form || !web) throw new Error("Missing collection ADR editor");
  const original = form.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "";
  const contents = original.replace("Use a bounded retry budget.", "Use project-specific retry limits.");
  const fields = Object.fromEntries(
    [...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [input.name, input.value]),
  );
  const target = form.getAttribute("action") ?? "";
  expect((await postWebForm(web, target, { ...fields, contents })).status).toBe(200);
  const path = join(root, "workbench/collections/company/decisions/ADR-00.md");
  expect(readFileSync(path, "utf8")).toBe(contents);
  expect(readFileSync(join(source.directory, "workbench/decisions/ADR-00.md"), "utf8")).toBe(original);
  expect((await postWebForm(web, target, { ...fields, contents: original })).status).toBe(409);
  expect(readFileSync(path, "utf8")).toBe(contents);
  const diff = parseDOM((await get("/records/company:ADR-0?view=changes&layout=split")).html).window.document;
  expect(diff.querySelector(".document-diff.split")).not.toBeNull();
  expect(diff.querySelectorAll(".document-diff ins,.document-diff del").length).toBeGreaterThan(0);
  expect(diff.body.textContent).toContain("Adapted");
});
test("missing originals do not prevent reading or cause automatic acquisition", async () => {
  adopt();
  rmSync(join(root, ".git/modules/workbench-collection-company"), { recursive: true, force: true });
  const read = await get("/records/company:ADR-0");
  expect(read.response.status).toBe(200);
  expect(read.html).toContain("Use a bounded retry budget");
  const diff = await get("/records/company:ADR-0?view=changes");
  expect(diff.html).toContain("never fetched automatically");
  expect(diff.html).toContain("workbench collection fetch company");
});
test("record views reject unavailable capabilities and comparisons before rendering", async () => {
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(join(root, "workbench/tasks/TSK-00.md"), "---\nstatus: Planned\n---\n\n# Task\n");
  for (const id of ["demo:ADR-0", "demo:TSK-0"]) {
    expect((await get(`/records/${id}?view=read`)).response.status).toBe(200);
    for (const view of ["source", "raw"]) expect((await get(`/records/${id}?view=${view}`)).response.status).toBe(400);
  }
  for (const query of [
    "id=demo:TSK-0&view=edit",
    "id=demo:TSK-0&view=changes",
    "id=demo:ADR-0&view=changes&baseline=upstream",
    "id=demo:ADR-0&view=unknown",
  ])
    expect((await get("/records/" + query.replace(/^id=([^&]+)&/, "$1?"))).response.status).toBe(400);
  expect((await get("/records/demo:ADR-0?view=edit")).response.status).toBe(200);
  for (const baseline of ["reviewed"])
    expect((await get("/records/demo:ADR-0?view=changes&baseline=" + baseline)).response.status).toBe(200);
});
test("citation titles, authors, dates, and publication details are visible and searchable", async () => {
  mkdirSync(join(root, "workbench/citations"));
  const citation = [
    {
      id: "demo-CIT-0",
      type: "article-journal",
      title: "Reliable agent workflows",
      author: [{ given: "Ada", family: "Lovelace" }, { literal: "Research group" }],
      issued: { "date-parts": [[2026, 10, 1]] },
      accessed: { "date-parts": [[2026, 11, 8]] },
      "container-title": "Engineering Journal",
      volume: "12",
      issue: "3",
      page: "20–35",
      DOI: "10.1234/example",
      URL: "https://example.invalid/paper",
      abstract: "A retained <abstract>.",
    },
  ];
  writeFileSync(join(root, "workbench/citations/CIT-00.json"), JSON.stringify(citation));
  const list = await get("/records?type=CIT");
  for (const value of ["Reliable agent workflows", "Ada Lovelace", "Research group", "2026", "Engineering Journal"])
    expect(list.html).toContain(value);
  const detail = await get("/records/demo:CIT-0");
  const detailDOM = parseDOM(detail.html);
  expect((await get("/records/demo:CIT-0?view=source")).response.status).toBe(400);
  try {
    const document = detailDOM.window.document;
    const headings = [...document.querySelectorAll("h2")].map((node) => node.textContent);
    expect(headings).toEqual(expect.arrayContaining(["Authors", "Year", "Accessed"]));
    expect(document.querySelector("main")?.textContent).toContain("2026-11-08");
    expect(document.querySelector("main")?.textContent).not.toContain("Date parts");
    for (const value of ["10.1234/example", "20–35", "A retained <abstract>."])
      expect(document.querySelector("main")?.textContent).toContain(value);
    expect(document.querySelector("abstract")).toBeNull();
    expect(document.querySelector('nav[aria-label="Record views"]')).toBeNull();
  } finally {
    detailDOM.window.close();
  }
  expect(citationMetadata(JSON.stringify([{ title: "Draft" }])).title).toBe("Draft");
});
test("prose metadata is visible for ADRs, tasks and experiments, with readable release fields", async () => {
  writeFileSync(
    join(root, "workbench/decisions/ADR-00.md"),
    "---\nsummary: Visible summary.\nagent_instruction: Visible human instruction.\n---\n\n# ADR-0: Files\n\nBody.\n",
  );
  const adr = await get("/records/demo:ADR-0");
  expect(headings(adr.html)).toEqual(expect.arrayContaining(["Summary", "Agent instructions"]));
  const document = parseDOM(adr.html).window.document;
  for (const title of ["Summary", "Agent instructions"])
    expect(
      [...document.querySelectorAll("h2")].find((heading) => heading.textContent === title)?.closest("details"),
    ).toBeNull();
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(
    join(root, "workbench/tasks/TSK-00.md"),
    "---\nstatus: Planned\nparent: null\ndepends_on: []\n---\n\n# Task\n",
  );
  expect(headings((await get("/records/demo:TSK-0")).html)).toContain("Dependencies");
  mkdirSync(join(root, "workbench/experiments"));
  writeFileSync(
    join(root, "workbench/experiments/EXP-00.md"),
    "---\nstatus: Running\nenvironment: null\n---\n\n# Experiment\n",
  );
  expect(headings((await get("/records/demo:EXP-0")).html)).toContain("Environment");
  mkdirSync(join(root, "workbench/releases"));
  writeFileSync(
    join(root, "workbench/releases/REL-00.yaml"),
    "version: 0.2.0\nreleased: '2026-10-25'\nyanked: false\n",
  );
  const release = await get("/records/demo:REL-0");
  expect(release.html).toContain("Release 0.2.0");
  expect(headings(release.html)).toContain("Released");
});
test("record batches use stable base-36 cursors and detect a changed list", async () => {
  mkdirSync(join(root, "workbench/tasks"));
  for (let number = 0; number < 120; number++)
    writeFileSync(
      join(root, `workbench/tasks/TSK-${number.toString(36).toUpperCase().padStart(2, "0")}.md`),
      `---\nstatus: Planned\n---\n\n# TSK-${number.toString(36).toUpperCase()}: Task ${String(number)}\n`,
    );
  const first = await get("/records?type=TSK&status=Planned");
  expect(parseDOM(first.html).window.document.querySelectorAll("[data-record-id]")).toHaveLength(100);
  const next = parseDOM(first.html).window.document.querySelector("[data-load-more]")?.getAttribute("href");
  if (!next) throw new Error("missing load more link");
  const second = await get(next);
  expect(parseDOM(second.html).window.document.querySelectorAll("[data-record-id]")).toHaveLength(20);
  expect(recordIds(first.html)[0]).toBe("demo:TSK-3B");
  expect(recordIds(second.html).at(-1)).toBe("demo:TSK-0");
  const expanded = await get("/records?type=TSK&status=Planned&through=demo:TSK-0");
  expect(parseDOM(expanded.html).window.document.querySelectorAll("[data-record-id]")).toHaveLength(120);
  writeFileSync(join(root, "workbench/tasks/TSK-00.md"), "# Changed\n");
  expect((await get(next)).response.status).toBe(409);
});

test("all tasks group every state in ascending ID order and state pages show descending history", async () => {
  mkdirSync(join(root, "workbench/tasks"));
  const states = ["Approved", "Planned", "Accepted", "Canceled"];
  for (const [index, state] of states.entries()) {
    for (const number of [2 * index + 2, 2 * index + 1])
      writeFileSync(
        join(root, `workbench/tasks/TSK-${number.toString(36).toUpperCase().padStart(2, "0")}.md`),
        `---\nstatus: ${state}\n---\n\n# TSK-${number.toString(36).toUpperCase()}: Task ${String(number)}\n`,
      );
  }
  const main = await get("/records?type=TSK");
  const document = parseDOM(main.html).window.document;
  expect(document.querySelector('nav[aria-label="Main navigation"] a[aria-current="page"]')?.textContent).toBe(
    "Tasks8",
  );
  expect(
    [...document.querySelectorAll("section[data-task-group]")].map((section) => section.getAttribute("aria-label")),
    document.querySelector("main > section p")?.textContent ?? "",
  ).toEqual(states);
  expect(recordIds(main.html)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((id) => `demo:TSK-${String(id)}`));
  for (const [index, state] of states.entries()) {
    const page = await get(`/records?type=TSK&status=${state}`);
    expect(recordIds(page.html)).toEqual(
      [2 * index + 2, 2 * index + 1].map((id) => `demo:TSK-${id.toString(36).toUpperCase()}`),
    );
    const nav = parseDOM(page.html).window.document.querySelector('nav[aria-label="Task views"]');
    expect(nav?.querySelector('[aria-current="page"]')?.textContent).toBe(state);
    expect(nav?.querySelectorAll("a")).toHaveLength(5);
  }
  expect(recordIds((await get("/records?type=TSK&q=Task")).html)).toHaveLength(8);
  expect((await get("/records?type=ADR&status=Active")).response.status).toBe(400);
  expect((await get("/records?type=TSK&status=Unknown")).response.status).toBe(400);
  writeFileSync(join(root, "workbench/tasks/TSK-0Z.md"), "# Invalid task\n\nMissing metadata.\n");
  const invalid = parseDOM((await get("/records?type=TSK")).html).window.document;
  expect(
    invalid
      .querySelector('section[aria-label="Tasks needing attention"] [data-record-id]')
      ?.getAttribute("data-record-id"),
  ).toBe("demo:TSK-Z");
  expect(invalid.querySelector('section[aria-label="Tasks needing attention"] [data-preview-error]')).not.toBeNull();
});

test("plain Markdown charters have readable previews and record diagnostics are selectable outside navigation", async () => {
  const home = parseDOM((await get("/")).html, { url: "http://localhost" });
  expect(home.window.document.querySelector('[data-record-id="demo:CHARTER"]')?.textContent).toContain("Human intent.");
  expect(home.window.document.querySelector('[data-record-id="demo:CHARTER"] [data-preview-error]')).toBeNull();
  home.window.close();
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# Incomplete draft\n\nBody without frontmatter.\n");
  for (let attempt = 0; attempt < 2; attempt++) {
    const dom = parseDOM((await get("/records?type=ADR")).html, { url: "http://localhost" });
    const row = dom.window.document.querySelector('[data-record-id="demo:ADR-0"]');
    expect(row?.tagName).toBe("ARTICLE");
    const problem = row?.querySelector("[data-preview-error]");
    expect(problem?.textContent).toContain("expected YAML frontmatter");
    expect(problem?.closest("a")).toBeNull();
    expect(row?.querySelector("h2 a")?.getAttribute("href")).toContain("/records/demo:ADR-0");
    dom.window.close();
  }
});

test("an unavailable comparison still renders the exact plain-text review baseline", () => {
  const path = "workbench/decisions/ADR-00.md";
  writeFileSync(join(root, path), "---\nsummary: Baseline.\n---\n\n# ADR-0: Files\n\nPrevious café 日本語.\n");
  git(root, "add", path);
  git(root, "commit", "-qm", "Review baseline");
  writeFileSync(join(root, path), "---\nsummary: Current.\n---\n\n# ADR-0: Files\n\nCurrent readable text.\n");
  const snapshot = new WorkspaceCollector(root).collect();
  const change = snapshot.review.changes.find((change) => change.path === path);
  const document = change && snapshot.reviewDocuments.get(change.digest);
  if (!document) throw new Error("Missing reviewed document");
  document.reviewed = { state: "unavailable", difference: null, problem: "Comparison acquisition failed" };
  const context = Object.assign(new WorkspaceIndex(snapshot).select({}), {
    csrf: "fixture",
    refreshing: false,
    problem: "",
  });
  const page = parseDOM(reviewPage(context, { path, layout: "split" }));
  expect(page.window.document.querySelector('[data-diff-side="before"]')?.closest("tbody")?.textContent).toContain(
    "Previous café 日本語.",
  );
  expect(page.window.document.querySelector(".document-diff")?.textContent).toContain("Current readable text.");
});

test("supporting Markdown keeps its own anchors and ADR-like filenames remain supporting documents", () => {
  const directory = join(root, "workbench/decisions/ADR-00");
  mkdirSync(directory);
  const names = ["first.md", "second.md", "ADR-01.md"];
  for (const name of names) writeFileSync(join(directory, name), "# Shared section\n\nBaseline.\n");
  git(root, "add", "workbench");
  git(root, "commit", "-qm", "Supporting baseline");
  for (const name of names)
    writeFileSync(
      join(directory, name),
      "# Shared section\n\n[Local section](#shared-section) and [parent decision](../ADR-00.md). Revised evidence.\n",
    );
  const context = Object.assign(new WorkspaceIndex(new WorkspaceCollector(root).collect()).select({}), {
    csrf: "fixture",
    refreshing: false,
    problem: "",
  });
  const document = parseDOM(reviewPage(context, { id: "demo:ADR-0" })).window.document;
  const sections = [...document.querySelectorAll("[data-review-file]")];
  expect(sections).toHaveLength(3);
  for (const section of sections) {
    const target = section.querySelector("article a")?.getAttribute("href")?.slice(1);
    expect(target).toBeTruthy();
    expect(document.getElementById(target ?? "")?.closest("[data-review-file]")).toBe(section);
    expect(section.querySelector(".document-comparison")).toBeNull();
    expect(section.querySelector('a[data-record-reference="demo:ADR-0"]')?.getAttribute("href")).toBe(
      "/records/demo:ADR-0",
    );
  }
  const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
  expect(new Set(ids).size).toBe(ids.length);
});
