import { beforeEach, expect, test } from "vitest";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { startWebServer } from "../../../src/server/http/server.ts";
import { webServers, readReconciledWebPage, postWebForm } from "../../fixtures/web.mjs";
import { provider, git } from "../../fixtures/adoption.mjs";
import { previewCollection, applyCollection } from "../../../src/server/projects/collection-service.ts";
import { parseDOM } from "../../fixtures/dom.mjs";

const servers = webServers();
let root: string;
let web: Awaited<ReturnType<typeof startWebServer>> | undefined;
beforeEach(() => {
  root = servers.project();
  web = undefined;
});
async function get(path: string) {
  web ??= await servers.start(root, { port: 0 });
  return readReconciledWebPage(web, path);
}
const recordIds = (html: string) =>
  [...parseDOM(html).window.document.querySelectorAll("[data-record-id]")].map((element) =>
    element.getAttribute("data-record-id"),
  );
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
  const queue = await get("/reviews");
  expect(reviewIds(queue.html)).toContain("company:ADR-0");
  const collectionQueue = await get("/reviews?collection=company");
  expect(collectionQueue.response.status).toBe(200);
  expect(reviewIds(collectionQueue.html)).toEqual(["company:CHARTER", "company:ADR-0"]);
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
  const queue = await get("/reviews");
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
