import { installSelectedCollections } from "../../../src/core/collections/collection-install.ts";
import { approveLocalPolicy, reviewLocalPolicy } from "../../../src/core/collections/local-policy.ts";
import { expect, test, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDOM } from "../../fixtures/dom.mjs";
import { projectsFromData, readProjects } from "../../../src/core/projects/project-configuration.ts";
import { ProjectHierarchy, projectName } from "../../../src/core/projects/project-hierarchy.ts";
import { webServers, readWebPage, postWebForm } from "../../fixtures/web.mjs";
import { provider, distribution } from "../../fixtures/adoption.mjs";
import { previewCollection, applyCollection } from "../../../src/server/projects/collection-service.ts";
import { changeTaskQueue } from "../../../src/core/tasks/task-queue.ts";
const fixtures = webServers();
function formValues(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries(
    [...form.querySelectorAll<HTMLInputElement>("input[name]")].map((input) => [input.name, input.value]),
  );
}
function nestedProject() {
  const root = fixtures.project();
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="demo"\nname="GraphAI"\npath="."\n[[project]]\nid="graphmp"\nname="GraphMP"\npath="packages/compute"\n[[project]]\nid="solver"\npath="packages/compute/src/solver"\n[[language_root]]\nlanguage="typescript"\npath="examples/languages/typescript"\n',
  );
  for (const path of ["packages/compute", "packages/compute/src/solver"]) {
    mkdirSync(join(root, path, "workbench/decisions"), { recursive: true });
    writeFileSync(
      join(root, path, "workbench/decisions/ADR-00.md"),
      `---\nsummary: Needle across every source.\n---\n\n# ADR-0: ${path.endsWith("solver") ? "Solver" : "GraphMP"} decision\n\nNeedle across every source.\n`,
    );
  }
  return root;
}
test("display names are optional, validated, and qualified only with registered ancestors", () => {
  const root = nestedProject();
  const projects = readProjects(root);
  const child = projects[2];
  if (!child) throw new Error("missing nested fixture");
  expect(new ProjectHierarchy(projects).lineage(child).map(projectName)).toEqual(["GraphAI", "GraphMP", "solver"]);
  expect(new ProjectHierarchy(projects).breadcrumb(child)).toBe("GraphAI/GraphMP/solver");
  for (const name of ["", " bad ", "bad\u001b[0m", "x".repeat(129)])
    expect(() => projectsFromData({ project: [{ id: "demo", path: ".", name }] }, "fixture")).toThrow(
      /display name|nonempty/,
    );
});
test("the sidebar lists a real project hierarchy and collections without a selector or duplicated management entry", async () => {
  const root = nestedProject(),
    web = await fixtures.start(root);
  const { html } = await readWebPage(web, "/records?scope=graphmp&type=ADR");
  const document = parseDOM(html, { url: web.url }).window.document;
  const sources = document.querySelector("[data-source-navigation]");
  expect(sources?.textContent).not.toMatch(/examples|languages|typescript|packages|compute|need review/);
  const parent = sources?.querySelector('a[href*="scope=graphmp"]')?.closest("li");
  expect(parent?.querySelector('ul a[href*="scope=solver"]')?.textContent).toBe("solver");
  expect(sources?.querySelector('a[aria-current="page"]')?.textContent).toBe("GraphMP");
  expect(document.querySelector("select#record-source")).toBeNull();
  expect(document.querySelector("a.brand")).toBeNull();
  expect(sources?.querySelector('a[href*="all=1"]')).toBeNull();
  expect(
    [...document.querySelectorAll(".source-collection-group > .source-row a")].map((link) => link.textContent),
  ).toEqual(["Collections"]);
  expect(document.querySelector('[aria-label="Main navigation"]')?.textContent).not.toContain("Collections");
  const breadcrumb = document.querySelector('nav[aria-label="Breadcrumb"]');
  expect([...(breadcrumb?.querySelectorAll("a") ?? [])].map((link) => link.textContent)).toEqual([
    "GraphAI",
    "GraphMP",
  ]);
  expect(breadcrumb?.textContent).not.toMatch(/packages|compute/);
  expect(breadcrumb?.textContent).not.toContain("ADR records");
  expect(document.querySelector("#record-list")?.textContent).toContain("graphmp:ADR-0");
  expect(document.querySelector("#record-list")?.textContent).not.toContain("solver:ADR-0");
  expect((await readWebPage(web, "/records?scope=missing")).response.status).toBe(404);
});
test("an empty collection list keeps a named management link without an empty disclosure", async () => {
  const web = await fixtures.start(fixtures.project());
  const document = parseDOM((await readWebPage(web, "/")).html, { url: web.url }).window.document;
  const group = document.querySelector(".source-collection-group");
  expect(group?.querySelector("button, ul")).toBeNull();
  expect(group?.querySelector("a")?.textContent).toBe("Collections");
  expect(group?.querySelector("a")?.getAttribute("href")).toBe("/collections");
  expect(group?.textContent).not.toContain("None installed");
});
test("workflow source changes retain the view and include only the selected scope and its descendants", async () => {
  const root = nestedProject();
  for (const path of ["", "packages/compute/", "packages/compute/src/solver/"]) {
    mkdirSync(join(root, path, "workbench/tasks"), { recursive: true });
    writeFileSync(join(root, path, "workbench/tasks/TSK-00.md"), "---\nstatus: Planned\n---\n\n# TSK-0: Scope work\n");
  }
  const web = await fixtures.start(root);
  const read = async (path: string) => parseDOM((await readWebPage(web, path)).html, { url: web.url }).window.document;
  const plans = await read("/plans?scope=graphmp");
  expect([...plans.querySelectorAll("[data-task-node]")].map((node) => node.getAttribute("data-task-node"))).toEqual([
    "graphmp:TSK-0",
    "solver:TSK-0",
  ]);
  expect(plans.querySelector('a.nav-item[aria-current="page"] .nav-count')?.textContent).toBe("2");
  expect(plans.querySelector('[data-source-navigation] a[aria-current="page"]')?.textContent).toBe("GraphMP");
  const leafLink = plans.querySelector<HTMLAnchorElement>('[data-source-navigation] a[href*="scope=solver"]');
  expect(new URL(leafLink?.href ?? "", web.url).pathname).toBe("/plans");
  const leaf = await read(leafLink?.getAttribute("href") ?? "");
  expect([...leaf.querySelectorAll("[data-task-node]")].map((node) => node.getAttribute("data-task-node"))).toEqual([
    "solver:TSK-0",
  ]);
  const rootLink = plans.querySelector('[data-source-navigation] a[href*="scope=demo"]')?.getAttribute("href");
  expect((await read(rootLink ?? "")).querySelectorAll("[data-task-node]")).toHaveLength(3);

  const directory = join(root, "packages/compute/src/solver/workbench/tasks");
  writeFileSync(
    join(directory, "TSK-01.md"),
    "---\nstatus: Planned\n---\n\n# TSK-1: Next scoped proposal\n\nSee ADR-0. [Notes](TSK-01/notes.md).\n",
  );
  mkdirSync(join(directory, "TSK-01"));
  writeFileSync(join(directory, "TSK-01/notes.md"), "# Notes\n\nSee ADR-0.\n");
  await web.monitor.reconcile(true);

  const childLink = plans
    .querySelector<HTMLAnchorElement>('[data-record-id="solver:TSK-0"] a[data-card-link]')
    ?.getAttribute("href");
  if (!childLink) throw new Error("Missing scoped child plan");
  expect(new URL(childLink, web.url).searchParams.get("scope")).toBe("graphmp");
  const record = await read(childLink);
  expect(record.querySelector('[data-source-navigation] a[aria-current="page"]')?.textContent).toBe("GraphMP");
  expect(record.querySelector('a.nav-item[aria-current="page"] > span')?.textContent).toBe("Plans");
  const next = record.querySelector<HTMLAnchorElement>('a[rel="next"]')?.getAttribute("href");
  if (!next) throw new Error("Missing next workflow plan");
  expect(new URL(next, web.url).searchParams.get("scope")).toBe("graphmp");
  const nextRecord = await read(next);
  expect(nextRecord.querySelector('[data-record-reference="solver:ADR-0"]')).not.toBeNull();
  const notes = nextRecord.querySelector<HTMLAnchorElement>('.document a[href*="notes.md"]')?.getAttribute("href");
  if (!notes) throw new Error("Missing scoped supporting document");
  expect(new URL(notes, web.url).searchParams.get("scope")).toBe("graphmp");
  const supporting = await read(notes);
  expect(supporting.querySelector('nav[aria-label="Breadcrumb"] a[href*="/plans"]')?.getAttribute("href")).toBe(
    "/plans?scope=graphmp",
  );
  const approval = record.querySelector<HTMLInputElement>('form input[name="state"][value="Approved"]')?.form;
  if (!approval) throw new Error("Missing plan approval");
  const response = await postWebForm(web, approval.getAttribute("action") ?? "", formValues(approval));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ redirect: "/work?scope=graphmp" });
  const work = await read("/work?scope=graphmp");
  expect(work.querySelectorAll(".task-queue > li")).toHaveLength(1);
  expect(work.querySelector('.task-queue > li[data-task-node="solver:TSK-0"]')).not.toBeNull();
  changeTaskQueue(root, { action: "remove", reference: "solver:TSK-0" });
  await web.monitor.reconcile(true);
  expect((await read("/work?scope=solver")).querySelectorAll(".task-queue > li")).toHaveLength(0);
  expect((await read("/work?scope=graphmp")).querySelectorAll(".task-queue > li")).toHaveLength(0);
});

test("review navigation, confirmation, and counts stay within the selected source", async () => {
  const root = nestedProject();
  writeFileSync(
    join(root, "workbench/decisions/ADR-00.md"),
    "---\nsummary: Root change.\n---\n\n# ADR-0: Root change\n",
  );
  const web = await fixtures.start(root);
  const read = async (path: string) => parseDOM((await readWebPage(web, path)).html, { url: web.url }).window.document;
  let page = await read("/reviews?scope=graphmp");
  expect(
    [...page.querySelectorAll("[data-review-source]")].map((node) => node.getAttribute("data-review-source")),
  ).toEqual(["project:graphmp", "project:solver"]);
  expect(page.querySelector('a.nav-item[aria-current="page"] .nav-count')?.textContent).toBe("2");
  const source = page.querySelector<HTMLAnchorElement>('[data-source-navigation] a[href*="scope=solver"]');
  expect(new URL(source?.href ?? "", web.url).pathname).toBe("/reviews");
  for (const remaining of [1, 0]) {
    const href = page.querySelector("main a[data-card-link]")?.getAttribute("href");
    if (!href) throw new Error("Missing scoped review");
    expect(new URL(href, web.url).searchParams.get("scope")).toBe("graphmp");
    const document = await read(href);
    expect(document.querySelector('nav[aria-label="Breadcrumb"] a[href*="/reviews"]')?.getAttribute("href")).toBe(
      "/reviews?scope=graphmp",
    );
    const form = document.querySelector<HTMLFormElement>("form[data-review]");
    if (!form) throw new Error("Missing review confirmation");
    const result = await postWebForm(web, form.getAttribute("action") ?? "", formValues(form));
    expect(result.status).toBe(200);
    const { redirect } = (await result.json()) as { redirect: string };
    expect(new URL(redirect, web.url).searchParams.get("scope")).toBe("graphmp");
    page = await read("/reviews?scope=graphmp");
    expect(page.querySelectorAll("main a[data-card-link]")).toHaveLength(remaining);
    expect(page.querySelector('a.nav-item[aria-current="page"] .nav-count')?.textContent).toBe(String(remaining));
  }
  const rootPage = await read("/reviews?scope=demo");
  expect(
    [...rootPage.querySelectorAll("[data-review-source]")].map((node) => node.getAttribute("data-review-source")),
  ).toEqual(["project:demo"]);
  expect((await readWebPage(web, "/review?scope=solver&path=workbench/decisions/ADR-00.md")).response.status).toBe(404);
});
test("header search spans project scopes and searches collections separately", async () => {
  const root = nestedProject();
  const source = provider(root);
  const request = { source: source.directory, commit: source.commit, collection: ".", visibility: "public" as const };
  applyCollection(root, request, previewCollection(root, request).digest);
  const web = await fixtures.start(root);
  const charters = parseDOM((await readWebPage(web, "/")).html, { url: web.url }).window.document;
  expect(charters.querySelector('form[role="search"] input[name="all"]')?.getAttribute("value")).toBe("1");
  expect(charters.querySelector<HTMLSelectElement>('form[role="search"] select[name="type"]')?.value).toBe("");
  expect(charters.querySelector('form[role="search"] option:checked')?.textContent).toBe("All types");
  const collectionLanding = charters.querySelector('[data-source-navigation] a[href="/?collection=company"]');
  expect(collectionLanding?.textContent).toBe("company");
  const companyCharters = parseDOM((await readWebPage(web, "/?collection=company")).html).window.document;
  expect(
    [...companyCharters.querySelectorAll("main [data-record-id]")].map((record) =>
      record.getAttribute("data-record-id"),
    ),
  ).toEqual(["company:CHARTER"]);
  const results = parseDOM((await readWebPage(web, "/records?all=1&q=decision")).html, { url: web.url }).window
    .document;
  expect(results.querySelector("h1")?.textContent).toBe("Search results");
  const ids = [...results.querySelectorAll("[data-record-id]")].map((record) => record.getAttribute("data-record-id"));
  expect(ids).toContain("graphmp:ADR-0");
  expect(ids).toContain("solver:ADR-0");
  const typed = parseDOM((await readWebPage(web, "/records?all=1&q=Human%20intent&type=CHARTER")).html, {
    url: web.url,
  }).window.document;
  expect(typed.querySelector<HTMLInputElement>('form[role="search"] input[name="q"]')?.value).toBe("Human intent");
  expect(typed.querySelector<HTMLSelectElement>('form[role="search"] select[name="type"]')?.value).toBe("CHARTER");
  expect(typed.querySelectorAll('input[name="q"]')).toHaveLength(1);
  expect(typed.querySelectorAll('select[name="type"]')).toHaveLength(1);
  expect(typed.querySelector("main form")).toBeNull();
  expect(
    [...typed.querySelectorAll("[data-record-id]")].map((record) => record.getAttribute("data-record-id")),
  ).toEqual(["demo:CHARTER"]);
  const all = parseDOM((await readWebPage(web, "/records?all=1")).html, { url: web.url }).window.document;
  expect(all.querySelector("h1")?.textContent).toBe("Records");
  expect([...all.querySelectorAll("[data-record-id]")].map((record) => record.getAttribute("data-record-id"))).toEqual(
    expect.arrayContaining(["demo:ADR-0", "graphmp:ADR-0", "solver:ADR-0"]),
  );
  expect(all.querySelector('[data-record-id="company:ADR-0"]')).toBeNull();
  const collection = parseDOM((await readWebPage(web, "/records?collection=company")).html).window.document;
  expect(collection.querySelector('form[role="search"] input[name="collection"]')?.getAttribute("value")).toBe(
    "company",
  );
  expect(collection.querySelector('form[role="search"] input[name="all"]')).toBeNull();
  const collectionResults = parseDOM((await readWebPage(web, "/records?collection=company&q=Policy")).html).window
    .document;
  expect(
    [...collectionResults.querySelectorAll("[data-record-id]")].every((record) =>
      record.getAttribute("data-record-id")?.startsWith("company:"),
    ),
  ).toBe(true);
  expect(collectionResults.querySelector('[data-record-id="company:ADR-0"]')).not.toBeNull();
  const review = parseDOM((await readWebPage(web, "/reviews")).html, { url: web.url }).window.document;
  expect(review.querySelector("main")?.textContent).toContain("packages/compute/workbench/decisions/ADR-00.md");
  expect(review.querySelector("main")?.textContent).toContain(
    "packages/compute/src/solver/workbench/decisions/ADR-00.md",
  );
});

test("referenced records open the unified review queue at their owning record", async () => {
  const root = nestedProject(),
    source = provider(root);
  const request = { source: source.directory, commit: source.commit, collection: ".", visibility: "public" as const };
  applyCollection(root, request, previewCollection(root, request).digest);
  const path = join(root, "workbench/decisions/ADR-00.md");
  writeFileSync(path, readFileSync(path, "utf8") + "\nSee graphmp:ADR-0 and company:ADR-0.\n");
  const web = await fixtures.start(root);
  const document = parseDOM((await readWebPage(web, "/records/demo:ADR-0")).html).window.document;
  for (const id of ["graphmp:ADR-0", "company:ADR-0"]) {
    const href = document.querySelector(`[data-record-id="${id}"] a.badge.pending`)?.getAttribute("href");
    expect(href).toBeTruthy();
    const url = new URL(href ?? "", web.url);
    expect(url.searchParams.get("scope")).toBe("demo");
    expect(url.searchParams.has("collection")).toBe(false);
    const result = await readWebPage(web, url.pathname + url.search);
    expect(result.response.status).toBe(200);
    expect(parseDOM(result.html).window.document.querySelector("form[data-review]")).not.toBeNull();
  }
  const leafPath = join(root, "packages/compute/src/solver/workbench/decisions/ADR-00.md");
  writeFileSync(leafPath, readFileSync(leafPath, "utf8") + "\nSee company:ADR-0.\n");
  await web.monitor.reconcile(true);
  const leaf = parseDOM((await readWebPage(web, "/records/solver:ADR-0")).html).window.document;
  const externalReview = leaf.querySelector('[data-record-id="company:ADR-0"] a.badge.pending')?.getAttribute("href");
  if (!externalReview) throw new Error("Missing collection review reference");
  expect(new URL(externalReview, web.url).searchParams.get("collection")).toBe("company");
  expect((await readWebPage(web, externalReview)).response.status).toBe(200);
});

test("explicit review refresh exposes invalid declarations as caller errors instead of an internal diagnostic", async () => {
  const root = fixtures.project(),
    web = await fixtures.start(root);
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\nunknown_field="invalid"\n');
  const response = await fetch(web.url + "/reviews");
  expect(response.status).toBe(400);
  const body = await response.text();
  expect(body).toContain("unknown field");
  expect(body).toContain("unknown_field");
  expect(body).not.toContain("Internal operation failed");
});
test("invalid record types and difference layouts identify caller errors", async () => {
  const web = await fixtures.start(fixtures.project());
  for (const path of [
    "/records?type=UNKNOWN",
    "/records/demo:ADR-0?view=changes&layout=UNKNOWN",
    "/records/demo:ADR-0?layout=UNKNOWN",
  ])
    expect((await readWebPage(web, path)).response.status).toBe(400);
});
test("review view changes preserve an all-sources queue", async () => {
  const root = nestedProject();
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# ADR-0: Revised root\n");
  const web = await fixtures.start(root);
  const page = parseDOM((await readWebPage(web, "/review?path=workbench/decisions/ADR-00.md&layout=split")).html, {
    url: web.url,
  }).window.document;
  for (const link of page.querySelectorAll<HTMLAnchorElement>(
    '[aria-label="Reviewed file views"] a,[aria-label="Difference layout"] a',
  )) {
    expect(new URL(link.href).searchParams.has("all")).toBe(false);
    expect(new URL(link.href).searchParams.has("review_source")).toBe(false);
  }
});

test("a direct link to a newly declared subproject refreshes the source list before resolving its scope", async () => {
  const root = fixtures.project(),
    web = await fixtures.start(root);
  const registry = join(root, "workbench/projects.toml");
  writeFileSync(
    registry,
    readFileSync(registry, "utf8") + '\n[[project]]\nid="newscope"\nname="New Scope"\npath="components/new"\n',
  );
  mkdirSync(join(root, "components/new/workbench/tasks"), { recursive: true });
  writeFileSync(join(root, "components/new/workbench/tasks/TSK-00.md"), "---\nstatus: Planned\n---\n\n# New task\n");
  const response = await fetch(web.url + "/records?scope=newscope");
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("New Scope");
  expect(body).toContain("newscope:TSK-0");
});

test("local collections share the collection list, remain read only, and are absent from project search and document review", async () => {
  const root = fixtures.project();
  for (const kind of ["CONFIG", "DATA", "CACHE", "STATE"])
    vi.stubEnv(`WORKBENCH_${kind}_HOME`, join(root, ".git", kind.toLowerCase()));
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const source = provider(root, "hostrules", "1", ["Localonlyneedle policy for this checkout."]);
  installSelectedCollections(root, [{ source: source.directory, sha256: source.pin.sha256 }], { scope: "local" });
  const base = join(root, "workbench/.local-collections");
  approveLocalPolicy(base, "hostrules", reviewLocalPolicy(base, "hostrules").digest, true);
  writeFileSync(
    join(root, "workbench/decisions/ADR-00.md"),
    "# ADR-0: Project change\n\nReview this project change.\n",
  );
  const web = await fixtures.start(root);
  const page = parseDOM((await readWebPage(web, "/")).html).window.document;
  expect(page.querySelector(".source-collection-group")?.textContent).toContain("hostrules");
  const localLink = page.querySelector('.source-collection-group a[title="Local collection · read only"]');
  expect(localLink?.textContent).toBe("hostrules");
  expect(localLink?.parentElement?.querySelector("svg rect")).not.toBeNull();
  expect(page.body.textContent).not.toContain("Local policies");
  const management = parseDOM((await readWebPage(web, "/collections")).html).window.document;
  expect(management.querySelector("main")?.textContent).toContain("Checkout-local");
  expect(management.querySelector("main")?.textContent).toContain("Local · read only");
  expect(management.querySelector('main option[value="hostrules"]')).toBeNull();
  expect(management.querySelector('[aria-label="Main navigation"]')?.textContent).toContain("Reviews");
  expect(management.querySelector("main")?.textContent).toContain("hostrules");
  expect(management.querySelector("main")?.textContent).not.toContain("workbench sync");
  const search = parseDOM((await readWebPage(web, "/records?all=1&q=Localonlyneedle")).html).window.document;
  expect(search.querySelector("[data-record-id]")).toBeNull();
  const local = parseDOM((await readWebPage(web, "/records/hostrules:ADR-0")).html).window.document;
  expect(local.querySelector("main")?.textContent).toContain("Localonlyneedle");
  expect(local.querySelector("main")?.textContent).toContain("Local collection · read only");
  expect(local.querySelector("main")?.textContent).not.toContain("Upstream comparison unavailable");
  expect(local.querySelector('[aria-label="Main navigation"]')?.textContent).toContain("Reviews");
  expect(local.querySelector('a[href*="view=edit"], a[href*="view=changes"]')).toBeNull();
  const review = parseDOM((await readWebPage(web, "/reviews")).html).window.document;
  const reviews = [...review.querySelectorAll("main a[data-card-link]")].map((link) => link.getAttribute("href"));
  expect(reviews).toEqual([expect.stringContaining("/records/demo:ADR-0")]);
});
