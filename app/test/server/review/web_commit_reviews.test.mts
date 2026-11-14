import { expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { webServers, readWebPage, postWebForm } from "../../fixtures/web.mjs";
import { parseDOM } from "../../fixtures/dom.mjs";
import { git } from "../../fixtures/adoption.mjs";
import { committedReview } from "../../../src/core/review/review-units.ts";
import { updatedReviewTree, writeReviewBlobs } from "../../../src/core/git/git-snapshot.ts";
import { ReviewInventory } from "../../../src/server/projects/review-inventory.ts";

const fixtures = webServers();
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
  git(root, "add", ".");
  git(root, "commit", "-qm", "First retained choices\n\nWorkbench-Provisional: true");
  const first = git(root, "rev-parse", "HEAD");
  writeFileSync(
    join(root, firstPath),
    "---\nsummary: Revised choice.\n---\n\n# ADR-0: First decision\n\nRevised version.\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "Second retained choice\n\nWorkbench-Provisional: true");
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
