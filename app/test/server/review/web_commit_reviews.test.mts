import { displayedSource } from "../../fixtures/file-diff.mjs";
import { filePreviewByteLimit } from "../../../src/server/review/file-comparison.ts";
import { expect, test } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { webServers, readWebPage, postWebForm } from "../../fixtures/web.mjs";
import { parseDOM } from "../../fixtures/dom.mjs";
import { git } from "../../fixtures/adoption.mjs";
import { committedReview } from "../../../src/core/review/review-units.ts";
import { updatedReviewTree, writeReviewBlobs } from "../../../src/core/git/git-snapshot.ts";
import { ReviewInventory } from "../../../src/server/projects/review-inventory.ts";
import { taskCommits } from "../../../src/core/git/history.ts";

const fixtures = webServers();

test("task acceptance links only its deliveries, preserving scope, literal diffs and immutable inspection", async () => {
  const root = fixtures.project(),
    taskPath = "app/workbench/tasks/TSK-00.md",
    sourcePath = "app/main.ts";
  mkdirSync(join(root, "app/workbench/tasks"), { recursive: true });
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="demo"\npath="."\n[[project]]\nid="api"\npath="app"\n',
  );
  writeFileSync(join(root, "app/workbench/CHARTER.md"), "# Charter\n\nApplication intent.\n");
  mkdirSync(join(root, "app/workbench/decisions"));
  writeFileSync(
    join(root, "app/workbench/decisions/ADR-00.md"),
    "---\nsummary: Scope-specific authority.\n---\n\n# ADR-0: Application policy\n\nApplication policy.\n",
  );
  const deliver = (summary: string, source: string) => {
    writeFileSync(
      join(root, taskPath),
      `---\nstatus: Approved\n---\n\n# TSK-0: Deliver application\n\n${summary}\n\nFollow ADR-0.\n`,
    );
    writeFileSync(join(root, sourcePath), source);
    git(root, "add", ".");
    git(root, "commit", "-qm", `${summary}\n\nExplain ${summary.toLowerCase()}.\n\nWorkbench-Provisional: true`);
    return git(root, "rev-parse", "HEAD");
  };
  const first = deliver("First delivery", 'export const text = "<script>old()</script>";\n');
  writeFileSync(join(root, "other.txt"), "Unrelated work.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Unrelated delivery");
  const unrelated = git(root, "rev-parse", "HEAD"),
    second = deliver("Second delivery", 'export const text = "<script>new()</script>";\n'),
    index = git(root, "write-tree"),
    web = await fixtures.start(root),
    record = parseDOM((await readWebPage(web, "/records/api:TSK-0")).html).window.document,
    links = [...record.querySelectorAll<HTMLAnchorElement>('[aria-label="Task commits"] a')];
  expect(links.map((link) => link.textContent)).toEqual([
    `Second delivery${second.slice(0, 12)}`,
    `First delivery${first.slice(0, 12)}`,
  ]);
  expect(record.querySelector('.sidebar a[href*="/history"]')).toBeNull();
  const commitURL = links[0]?.getAttribute("href");
  if (!commitURL) throw new Error("Task commit link unavailable");
  expect(commitURL).toContain("/records/api:TSK-0/history");
  expect(commitURL).toContain("scope=api");
  const commit = parseDOM((await readWebPage(web, commitURL)).html).window.document,
    file = [...commit.querySelectorAll<HTMLAnchorElement>(".commit-navigation a")].find(
      (link) => link.title === sourcePath,
    );
  expect(commit.querySelector('[data-commit-file="app/workbench/tasks/TSK-00.md"] [data-record-reference]')).toBeNull();
  expect(
    commit.querySelector('nav.commit-navigation[aria-label="Changed files"] .commit-navigation-list'),
  ).not.toBeNull();
  expect(file?.closest("[data-commit-file-path]")?.getAttribute("data-commit-file-path")).toBe(sourcePath);
  const anchor = file?.getAttribute("href");
  if (!anchor?.startsWith("#")) throw new Error("Missing comparison anchor");
  expect(commit.getElementById(anchor.slice(1))?.getAttribute("data-commit-file")).toBe(sourcePath);
  const message = commit.querySelector('[aria-label="Commit message"]');
  expect(message?.textContent).toBe("Explain second delivery.");
  expect(message?.closest("details")).toBeNull();
  expect(message?.textContent).not.toContain("Workbench-Provisional");
  const fileURL = new URL(commitURL, web.url);
  fileURL.searchParams.set("path", sourcePath);
  const diff = parseDOM((await readWebPage(web, fileURL.pathname + fileURL.search)).html).window.document;
  expect(diff.querySelector('.commit-navigation a[aria-current="page"]')?.getAttribute("title")).toBe(sourcePath);
  expect(diff.querySelector(".file-diff .diff-removed")?.textContent).toContain("old()");
  expect(diff.querySelector(".file-diff .diff-added")?.textContent).toContain("new()");
  expect(diff.querySelector(".file-diff script")).toBeNull();
  expect(diff.querySelector(".file-diff")?.textContent).not.toContain("diff --git");
  expect(diff.querySelector("form[data-review]")).toBeNull();
  const splitURL = [...diff.querySelectorAll<HTMLAnchorElement>("a")]
    .find((link) => link.textContent === "Side-by-side")
    ?.getAttribute("href");
  if (!splitURL) throw new Error("Side-by-side control unavailable");
  const split = parseDOM((await readWebPage(web, splitURL)).html).window.document;
  expect(displayedSource(split, "before")).toContain("old()");
  expect(displayedSource(split, "after")).toContain("new()");
  expect(split.querySelector(".breadcrumbs")?.textContent).toContain("Deliver application");
  expect((await readWebPage(web, commitURL.replace(second, unrelated))).response.status).toBe(404);
  expect((await readWebPage(web, "/history")).response.status).toBe(400);
  expect(git(root, "rev-parse", "HEAD")).toBe(second);
  expect(git(root, "write-tree")).toBe(index);
});

test("task history pages follow renames without crossing reused task identities or moving page boundaries", () => {
  const root = fixtures.project(),
    path = "workbench/tasks/TSK-00.md";
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(join(root, path), "An earlier unrelated task.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Earlier task");
  git(root, "rm", path);
  git(root, "commit", "-qm", "Remove earlier task");
  expect(taskCommits(root, path).commits).toEqual([]);
  mkdirSync(join(root, "workbench/tasks"), { recursive: true });
  for (let number = 0; number < 52; number++) {
    writeFileSync(join(root, path), `New task delivery ${String(number)}.\n`);
    git(root, "add", path);
    git(root, "commit", "-qm", `Delivery ${String(number)}`);
  }
  const renamed = "workbench/tasks/TSK-01.md";
  git(root, "mv", path, renamed);
  git(root, "commit", "-qm", "Renumber task");
  const first = taskCommits(root, renamed);
  expect(first.commits).toHaveLength(50);
  expect(first.commits[0]?.subject).toBe("Renumber task");
  expect(first.next).toBe(50);
  writeFileSync(join(root, renamed), "Later edit.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Later delivery");
  const second = taskCommits(root, renamed, first.tip, first.next);
  expect(second.commits.map((commit) => commit.subject)).toEqual(["Delivery 2", "Delivery 1", "Delivery 0"]);
  expect(second.next).toBeUndefined();
  expect(taskCommits(root, renamed).commits[0]?.subject).toBe("Later delivery");
  expect(() => taskCommits(root, renamed, first.tip, -1)).toThrow("Invalid task history page");
});
test("review queue lists every pending record version under its commit and counts supporting files once", async () => {
  const root = fixtures.project(),
    firstPath = "workbench/decisions/ADR-00.md",
    secondPath = "workbench/decisions/ADR-01.md";
  writeFileSync(
    join(root, firstPath),
    "---\nsummary: First choice.\n---\n\n# ADR-0: First decision\n\nFirst version.\n",
  );
  writeFileSync(
    join(root, secondPath),
    "---\nsummary: Second choice.\n---\n\n# ADR-1: Second decision\n\nA separate choice.\n",
  );
  mkdirSync(join(root, "workbench/decisions/ADR-00"));
  writeFileSync(join(root, "workbench/decisions/ADR-00/evidence.txt"), "Supporting evidence.\n");
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(join(root, "workbench/tasks/TSK-00.md"), "---\nstatus: Approved\n---\n\n# TSK-0: Policy adoption\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "First retained choices\n\nWorkbench-Provisional: true");
  const first = git(root, "rev-parse", "HEAD");
  writeFileSync(
    join(root, firstPath),
    "---\nsummary: Revised choice.\n---\n\n# ADR-0: First decision\n\nRevised version.\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "Second retained choice\n\nWorkbench-Provisional: true");
  writeFileSync(join(root, "workbench/tasks/TSK-00.md"), "---\nstatus: Approved\n---\n\n# TSK-0: Later task title\n");
  const second = git(root, "rev-parse", "HEAD"),
    web = await fixtures.start(root),
    inventory = new ReviewInventory(root),
    page = parseDOM((await readWebPage(web, "/review")).html).window.document,
    firstUnit = page.querySelector(`[data-review-commit="${first}"]`),
    secondUnit = page.querySelector(`[data-review-commit="${second}"]`);
  expect(web.monitor.index?.select({}).pendingReviews).toBe(3);
  expect((await inventory.collect()).count).toBe(3);
  expect(page.querySelectorAll("[data-review-record]")).toHaveLength(3);
  expect(firstUnit?.querySelectorAll("[data-review-record]")).toHaveLength(2);
  expect(secondUnit?.querySelectorAll("[data-review-record]")).toHaveLength(1);
  expect(firstUnit?.querySelector(".panel-heading")?.textContent).toContain("demo:TSK-0: Policy adoption");
  expect(firstUnit?.querySelector(".panel-heading")?.textContent).not.toContain("Later task title");
  expect(firstUnit?.querySelector(".panel-heading a")).toBeNull();
  const links = [...page.querySelectorAll<HTMLAnchorElement>("[data-review-record] a[data-card-link]")];
  const destinations = links.map((link) => new URL(link.getAttribute("href") ?? "", web.url));
  expect(destinations.map((url) => [url.searchParams.get("commit"), url.searchParams.get("path")])).toEqual([
    [first, firstPath],
    [first, secondPath],
    [second, firstPath],
  ]);
  const firstURL = links[0]?.getAttribute("href");
  if (!firstURL) throw new Error("Missing first document review");
  const displayed = parseDOM((await readWebPage(web, firstURL)).html).window.document,
    confirm = displayed.querySelector<HTMLFormElement>("form[data-review]");
  if (!confirm) throw new Error("Missing document confirmation");
  expect(displayed.querySelector("main")?.textContent).toContain("First version.");
  expect(displayed.querySelector("main")?.textContent).not.toContain("Revised version.");
  expect(displayed.querySelector(".commit-review-context")?.textContent).toContain("demo:TSK-0: Policy adoption");
  expect(displayed.querySelector(".commit-review-context")?.textContent).toContain(first.slice(0, 12));
  expect(
    [...displayed.querySelectorAll("summary")].some((element) => element.textContent.includes("changed files")),
  ).toBe(false);
  const values = Object.fromEntries(
    [...confirm.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [input.name, input.value]),
  );
  const confirmation = await postWebForm(web, confirm.getAttribute("action") ?? "", values);
  expect(confirmation.status).toBe(200);
  expect(confirmation.headers.get("server-timing")).toMatch(/action;dur=\d+\.\d+/);
  expect(confirmation.headers.get("server-timing")).toMatch(/workspace;dur=\d+\.\d+/);
  const updated = parseDOM((await readWebPage(web, "/review")).html).window.document;
  expect(updated.querySelectorAll("[data-review-record]")).toHaveLength(3);
  expect(committedReview(root, first).changes.find((change) => change.path === firstPath)?.approved).toBe(true);
  expect(committedReview(root, second).changes.find((change) => change.path === firstPath)?.approved).toBe(false);
  const support = updated.querySelector<HTMLAnchorElement>(
    `[data-review-commit="${first}"] [data-review-record="${firstPath}"] a[data-card-link]`,
  );
  expect(new URL(support?.getAttribute("href") ?? "", web.url).searchParams.get("path")).toBe(
    "workbench/decisions/ADR-00/evidence.txt",
  );
  expect((await inventory.collect()).count).toBe(3);
  const supportURL = support?.getAttribute("href");
  if (!supportURL) throw new Error("Missing supporting-file review");
  const supporting = parseDOM((await readWebPage(web, supportURL)).html).window.document,
    supportForm = supporting.querySelector<HTMLFormElement>("form[data-review]");
  if (!supportForm) throw new Error("Missing supporting-file confirmation");
  const supportValues = Object.fromEntries(
    [...supportForm.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [
      input.name,
      input.value,
    ]),
  );
  expect((await postWebForm(web, supportForm.getAttribute("action") ?? "", supportValues)).status).toBe(200);
  const remaining = parseDOM((await readWebPage(web, "/review")).html).window.document;
  expect(remaining.querySelectorAll("[data-review-record]")).toHaveLength(2);
  expect(remaining.querySelector(`[data-review-commit="${first}"] [data-review-record="${firstPath}"]`)).toBeNull();
  expect(web.monitor.index?.select({}).pendingReviews).toBe(2);
  expect((await inventory.collect()).count).toBe(2);
});

test("browser reviews immutable commit versions independently and advances through the selected unit", async () => {
  const root = fixtures.project(),
    path = "workbench/decisions/ADR-00.md";
  const commit = (body: string) => {
    writeFileSync(join(root, path), `---\nsummary: Scoped review.\n---\n\n# ADR-0: Files\n\n${body}\n`);
    git(root, "add", path);
    git(root, "commit", "-qm", `${body}\n\nWorkbench-Provisional: true`);
    return git(root, "rev-parse", "HEAD");
  };
  const first = commit("First retained choice."),
    second = commit("Second retained choice.");
  writeFileSync(join(root, path), "---\nsummary: Current work.\n---\n\n# ADR-0: Files\n\nUncommitted third choice.\n");
  const web = await fixtures.start(root);
  const queue = (await readWebPage(web, "/review")).html;
  expect(queue).toContain(first);
  expect(queue).toContain(second);
  const blob = writeReviewBlobs(root, [
    Buffer.from("---\nsummary: Branch policy.\n---\n\n# ADR-0: Files\n\nAnother branch's choice.\n"),
  ])[0];
  if (!blob) throw new Error("Missing branch document");
  const tree = updatedReviewTree(root, first, [{ path, entry: { mode: "100644", oid: blob } }]),
    other = git(root, "commit-tree", tree, "-p", first, "-m", "Other branch\n\nWorkbench-Provisional: true");
  git(root, "update-ref", "refs/heads/feature/another", other);
  await web.monitor.reconcile();
  expect(web.monitor.index?.snapshot.commitReviews.some((unit) => unit.revision === other)).toBe(true);
  const page = await readWebPage(web, `/history?commit=${first}&layout=split`),
    doc = parseDOM(page.html).window.document;
  expect(page.response.status).toBe(200);
  expect(doc.querySelector("main")?.textContent).toContain("First retained choice.");
  expect(doc.querySelector("main")?.textContent).not.toContain("Uncommitted third choice.");
  const form = doc.querySelector<HTMLFormElement>("form[data-review]");
  if (!form) throw new Error("Commit confirmation unavailable");
  const fields = Object.fromEntries(
    [...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [input.name, input.value]),
  );
  const approved = await postWebForm(web, form.getAttribute("action") ?? "", fields);
  expect(approved.status).toBe(200);
  expect(committedReview(root, first).pending).toBe(0);
  expect(committedReview(root, second).pending).toBe(1);
  const redirect = ((await approved.json()) as { redirect: string }).redirect;
  expect(redirect).toContain(second);
  expect(redirect).toContain("layout=split");
  const next = parseDOM((await readWebPage(web, redirect)).html).window.document;
  expect(next.querySelector("main")?.textContent).toContain("Second retained choice.");
  const bytes = Buffer.from([0xff, 0xfe, 0x61]),
    unsupported = writeReviewBlobs(root, [bytes])[0];
  if (!unsupported) throw new Error("Missing binary document");
  const binaryTree = updatedReviewTree(root, second, [{ path, entry: { mode: "100644", oid: unsupported } }]),
    binaryCommit = git(
      root,
      "commit-tree",
      binaryTree,
      "-p",
      second,
      "-m",
      "Encoded document\n\nWorkbench-Provisional: true",
    );
  git(root, "update-ref", "refs/heads/feature/encoded", binaryCommit);
  const encoded = parseDOM((await readWebPage(web, `/history?commit=${binaryCommit}`)).html).window.document;
  expect(encoded.querySelector("main")?.textContent).toContain("download and inspect");
  const download = [...encoded.querySelectorAll<HTMLAnchorElement>("a")].find(
      (link) => link.textContent === "Download current file",
    ),
    previous = [...encoded.querySelectorAll<HTMLAnchorElement>("a")].find(
      (link) => link.textContent === "Download previous file",
    );
  const currentURL = download?.getAttribute("href"),
    previousURL = previous?.getAttribute("href");
  if (!currentURL || !previousURL) throw new Error("Both immutable downloads must remain available");
  const currentFile = await fetch(web.url + currentURL, { headers: { connection: "close" } });
  expect(currentFile.status).toBe(200);
  expect(Buffer.from(await currentFile.arrayBuffer())).toEqual(bytes);
  const oldFile = await fetch(web.url + previousURL, { headers: { connection: "close" } });
  expect(oldFile.status).toBe(200);
  expect(await oldFile.text()).toContain("Second retained choice.");
});

test("feature source inspection preserves literal Markdown and immutable supporting and unchanged files", async () => {
  const root = fixtures.project(),
    head = git(root, "rev-parse", "HEAD"),
    index = git(root, "write-tree"),
    path = "workbench/tasks/TSK-00.md",
    support = "workbench/tasks/TSK-00/notes.md",
    blobs = writeReviewBlobs(root, [
      Buffer.from(
        "---\nstatus: Planned\n---\n\n# TSK-0: Branch planning\n\nUse ADR-0 and [the notes](TSK-00/notes.md).\n",
      ),
      Buffer.from("# Branch notes\n\nPreserved supporting context.\n"),
    ]);
  const document = blobs[0],
    note = blobs[1];
  if (!document || !note) throw new Error("Missing branch fixture objects");
  const tree = updatedReviewTree(root, head, [
      { path, entry: { mode: "100644", oid: document } },
      { path: support, entry: { mode: "100644", oid: note } },
    ]),
    branch = git(root, "commit-tree", tree, "-p", head, "-m", "Feature history"),
    web = await fixtures.start(root);
  git(root, "update-ref", "refs/heads/feature/history", branch);
  const rendered = parseDOM((await readWebPage(web, `/history?commit=${branch}&path=${encodeURIComponent(path)}`)).html)
      .window.document,
    links = [...rendered.querySelectorAll<HTMLAnchorElement>(".commit-navigation a")];
  expect(rendered.querySelector("form[data-review]")).toBeNull();
  expect(rendered.querySelector(".document a")).toBeNull();
  expect(displayedSource(rendered, "after")).toContain("Use ADR-0 and [the notes](TSK-00/notes.md).");
  const policyURL = `/history?commit=${branch}&path=workbench%2Fdecisions%2FADR-00.md`,
    notesURL = links.find((link) => link.title === support)?.getAttribute("href");
  if (!notesURL) throw new Error("Missing supporting-file navigation");
  expect(notesURL).toContain(`commit=${branch}`);
  const policy = await readWebPage(web, policyURL + "&context=all"),
    linked = await readWebPage(web, notesURL),
    comparisons = parseDOM(linked.html).window.document,
    noteComparison = comparisons.getElementById(new URL(notesURL, web.url).hash.slice(1));
  expect(policy.response.status).toBe(200);
  expect(displayedSource(parseDOM(policy.html).window.document, "after")).toContain("Keep files authoritative");
  expect(linked.response.status).toBe(200);
  expect(comparisons.querySelectorAll("[data-commit-file]")).toHaveLength(2);
  expect(noteComparison?.getAttribute("data-commit-file")).toBe(support);
  if (!noteComparison) throw new Error("Missing supporting-file comparison");
  expect(displayedSource(noteComparison, "after")).toContain("Preserved supporting context.");
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(git(root, "write-tree")).toBe(index);
});

test("scoped commit reviews keep traversal, progress and confirmation within the selected subproject", async () => {
  const root = fixtures.project();
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="demo"\npath="."\n\n[[project]]\nid="api"\npath="api"\n',
  );
  mkdirSync(join(root, "api/workbench/decisions"), { recursive: true });
  mkdirSync(join(root, "api/src"));
  writeFileSync(join(root, "api/workbench/CHARTER.md"), "API project.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Add subproject");
  writeFileSync(join(root, "api/src/main.ts"), 'export const greeting = "Hello from the API";\n');
  const paths = [
    "api/workbench/decisions/ADR-00.md",
    "api/workbench/decisions/ADR-01.md",
    "workbench/decisions/ADR-00.md",
  ];
  for (const [index, path] of paths.entries())
    writeFileSync(
      join(root, path),
      `---\nsummary: Scoped choice.\n---\n\n# ADR-${String(index === 1 ? 1 : 0)}: Choice\n\nScoped policy.\n`,
    );
  git(root, "add", ".");
  git(root, "commit", "-qm", "Mixed-scope policies\n\nWorkbench-Provisional: true");
  const commit = git(root, "rev-parse", "HEAD"),
    web = await fixtures.start(root);
  const queue = parseDOM((await readWebPage(web, "/review?scope=api")).html).window.document;
  expect(queue.querySelectorAll("[data-review-record]")).toHaveLength(2);
  const sourcePage = await readWebPage(web, `/history?scope=api&commit=${commit}&path=api%2Fsrc%2Fmain.ts`);
  expect(sourcePage.response.status).toBe(200);
  expect(parseDOM(sourcePage.html).window.document.querySelector("h1")?.textContent).toBe("Mixed-scope policies");
  expect(parseDOM(sourcePage.html).window.document.querySelector("main")?.textContent).toContain("Hello from the API");
  const unscopedSource = await readWebPage(web, `/history?commit=${commit}&path=api%2Fsrc%2Fmain.ts`);
  expect(unscopedSource.response.status).toBe(200);
  const nextLink = (path: string) => `/history?scope=api&commit=${commit}&path=${encodeURIComponent(path)}`;
  const page = parseDOM((await readWebPage(web, nextLink(paths[1] ?? ""))).html).window.document;
  expect(page.querySelector("main")?.textContent).toContain("File 2 of 2");
  const navigation = [
    ...page.querySelectorAll<HTMLAnchorElement>('.record-navigation a, .record-nav a, [aria-label*="review file"]'),
  ];
  expect(
    navigation.map((link) => new URL(link.getAttribute("href") ?? "", web.url).searchParams.get("path")),
  ).not.toContain(paths[2]);
  const form = page.querySelector<HTMLFormElement>("form[data-review]");
  if (!form) throw new Error("Missing scoped review");
  const values = Object.fromEntries(
    [...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [input.name, input.value]),
  );
  const response = await postWebForm(web, form.getAttribute("action") ?? "", values);
  const redirect = ((await response.json()) as { redirect: string }).redirect;
  expect(redirect).toContain("scope=api");
  const following = parseDOM((await readWebPage(web, redirect)).html).window.document;
  expect(following.querySelector("main")?.textContent).toContain("File 1 of 1");
  expect(following.querySelector<HTMLInputElement>('input[name="path"]')?.value).not.toBe(paths[2]);
  expect(committedReview(root, commit).changes.find((change) => change.path === paths[2])?.approved).toBe(false);
});

test("task outcomes expose related protected reviews outside the selected subproject", async () => {
  const root = fixtures.project(),
    taskPath = "app/workbench/tasks/TSK-00.md",
    adrPath = "workbench/decisions/ADR-00.md";
  mkdirSync(join(root, "app/workbench/tasks"), { recursive: true });
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="demo"\npath="."\n[[project]]\nid="app"\npath="app"\n',
  );
  writeFileSync(join(root, "app/workbench/CHARTER.md"), "# Charter\n\nApplication intent.\n");
  writeFileSync(join(root, taskPath), "---\nstatus: Approved\n---\n\n# TSK-0: Shared policy change\n");
  writeFileSync(
    join(root, adrPath),
    "---\nsummary: Changed shared policy.\n---\n\n# ADR-0: Files\n\nA changed shared policy.\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "Deliver shared policy\n\nWorkbench-Provisional: true");
  const web = await fixtures.start(root),
    page = parseDOM((await readWebPage(web, "/records/app:TSK-0")).html).window.document;
  const reviews = page.querySelector('[aria-label="Pending document reviews"]');
  const link = [...(reviews?.querySelectorAll<HTMLAnchorElement>("a") ?? [])].find(
    (link) => link.textContent === adrPath,
  );
  expect(link).toBeDefined();
  const href = link?.getAttribute("href") ?? "";
  expect(new URL(href, web.url).searchParams.get("all")).toBe("1");
  const review = await readWebPage(web, href);
  expect(review.response.status).toBe(200);
  expect(parseDOM(review.html).window.document.querySelector("main")?.textContent).toContain(
    "A changed shared policy.",
  );
});

test("inline task commits list every file with budgeted initial previews and batched small diffs", async () => {
  const root = fixtures.project(),
    taskPath = "workbench/tasks/TSK-00.md";
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(join(root, taskPath), "---\nstatus: Approved\n---\n\n# TSK-0: Inspect delivery\n");
  writeFileSync(join(root, "a.ts"), 'const value = "before";\n');
  git(root, "add", ".");
  git(root, "commit", "-qm", "Start delivery");
  writeFileSync(join(root, "a.ts"), 'const value = "<script>after()</script>";\n');
  writeFileSync(join(root, "b.md"), "# Notes\n\nReadable **formatting**.\n");
  writeFileSync(join(root, "c.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(root, "d.txt"), "x".repeat(filePreviewByteLimit + 1));
  for (let index = 0; index < 51; index++)
    writeFileSync(join(root, `e-${String(index).padStart(3, "0")}.py`), `value = ${String(index)}\n`);
  writeFileSync(
    join(root, taskPath),
    readFileSync(join(root, taskPath), "utf8") + "\n## Implementation account\n\nDelivered the comparisons.\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "Inspect delivery\n\nExplain the changed files.\n\nWorkbench-Provisional: true");
  const revision = git(root, "rev-parse", "HEAD"),
    web = await fixtures.start(root);
  const base = `/records/demo:TSK-0/history?commit=${revision}`;
  const first = await readWebPage(web, base),
    document = parseDOM(first.html).window.document;
  expect(document.querySelectorAll("[data-commit-file]")).toHaveLength(56);
  expect(document.querySelector("[data-commit-more]")).toBeNull();
  expect(document.querySelector("[data-commit-file] script")).toBeNull();
  expect(document.querySelector("[data-commit-file] form[data-review]")).toBeNull();
  expect(document.querySelector('[data-commit-file="a.ts"] .hljs-keyword')).not.toBeNull();
  expect(document.querySelector('[data-commit-file="a.ts"] .diff-added')?.textContent).toContain("after()");
  expect(document.querySelector('[data-commit-file="b.md"] strong')).toBeNull();
  expect(document.querySelector('[data-commit-file="b.md"]')?.textContent).toContain("**formatting**");
  expect(document.querySelector('[data-commit-file="c.bin"]')?.textContent).toContain("Binary file");
  expect(document.querySelector('[data-commit-file="d.txt"] [data-file-diff-auto]')).toBeNull();
  const initiallyLoaded = document.querySelector('[data-commit-file="e-011.py"]');
  expect(initiallyLoaded && displayedSource(initiallyLoaded, "after")).toBe("value = 11\n");
  expect(document.querySelector('[data-commit-file="e-050.py"] [data-file-diff-auto]')).not.toBeNull();
  const continuation = document.getElementById("commit-file-list")?.dataset.fileDiffBatch;
  if (!continuation) throw new Error("The last small files need a continuation");
  const batchPage = await readWebPage(web, continuation);
  expect(batchPage.response.status).toBe(200);
  const batch = parseDOM(batchPage.html).window.document.querySelector(`[data-file-diff-result="${revision}"]`);
  if (!batch) throw new Error("Missing diff batch");
  const lastFile = batch.querySelector('[data-file-path="e-050.py"]');
  expect(lastFile && displayedSource(lastFile, "after")).toBe("value = 50\n");
  expect(batch.querySelectorAll("[data-file-path]").length).toBeGreaterThan(1);
  expect(batch.querySelector('[data-file-path="d.txt"]')).toBeNull();
  expect(batch.getAttribute("data-file-diff-batch")).toBeNull();
  const fullLink = document
    .querySelector<HTMLAnchorElement>('[data-commit-file="d.txt"] [data-file-diff-link]')
    ?.getAttribute("href");
  if (!fullLink) throw new Error("Large file must remain explicitly loadable");
  const large = parseDOM((await readWebPage(web, fullLink)).html).window.document;
  expect(displayedSource(large, "after")).toBe("x".repeat(filePreviewByteLimit + 1));
  const split = parseDOM((await readWebPage(web, base + "&layout=split")).html).window.document;
  expect(split.querySelectorAll("[data-commit-file]")).toHaveLength(56);
  expect(displayedSource(split.querySelector('[data-commit-file="a.ts"]') ?? split, "before")).toBe(
    'const value = "before";\n',
  );
  expect(displayedSource(split.querySelector('[data-commit-file="a.ts"]') ?? split, "after")).toBe(
    'const value = "<script>after()</script>";\n',
  );
});

test("Markdown commit inspection expands literal context while record acknowledgment retains the whole formatted document", async () => {
  const root = fixtures.project(),
    path = "workbench/decisions/ADR-00.md",
    task = "workbench/tasks/TSK-00.md";
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(join(root, task), "---\nstatus: Approved\n---\n\n# TSK-0: Inspect policy\n");
  const before =
    "---\nsummary: Review context.\n---\n\n# ADR-0: Context\n\n" +
    Array.from({ length: 80 }, (_, i) => `Paragraph ${String(i + 1)} **remains** available.\n\n`).join("");
  writeFileSync(join(root, path), before);
  git(root, "add", ".");
  git(root, "commit", "-qm", "Establish review context");
  const after = before.replace("Paragraph 40 **remains**", "Paragraph 40 **changes**");
  writeFileSync(join(root, path), after);
  writeFileSync(
    join(root, task),
    readFileSync(join(root, task), "utf8") + "\n## Implementation account\n\nUpdated the policy.\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "Update policy\n\nWorkbench-Provisional: true");
  const revision = git(root, "rev-parse", "HEAD"),
    web = await fixtures.start(root),
    base = `/records/demo:TSK-0/history?commit=${revision}&path=${encodeURIComponent(path)}`,
    inspection = parseDOM((await readWebPage(web, base)).html).window.document;
  expect(inspection.querySelector("form[data-review]")).toBeNull();
  expect(inspection.querySelector(".document-diff")).toBeNull();
  expect(displayedSource(inspection, "after")).toContain("Paragraph 40 **changes**");
  expect(displayedSource(inspection, "after")).not.toContain("Paragraph 1 ");
  const expand = inspection
    .querySelector<HTMLAnchorElement>('[aria-label="Show more lines above"]')
    ?.getAttribute("href");
  if (!expand) throw new Error("Missing context expansion");
  const expanded = parseDOM((await readWebPage(web, expand)).html).window.document;
  expect(displayedSource(expanded, "after").length).toBeGreaterThan(displayedSource(inspection, "after").length);
  const full = parseDOM((await readWebPage(web, base + "&context=all")).html).window.document;
  expect(displayedSource(full, "before")).toBe(before);
  expect(displayedSource(full, "after")).toBe(after);
  expect((await readWebPage(web, base + "&context=bad")).response.status).toBe(400);
  const review = parseDOM((await readWebPage(web, `/history?commit=${revision}&path=${encodeURIComponent(path)}`)).html)
    .window.document;
  expect(review.querySelector(".document-diff")?.textContent).toContain("Paragraph 1 ");
  expect(review.querySelector("form[data-review]")).not.toBeNull();
  expect(committedReview(root, revision).changes.find((change) => change.path === path)?.approved).toBe(false);
});
