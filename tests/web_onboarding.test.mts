import { expect, test } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { webServers, readWebPage, postWebForm, hiddenValue } from "./fixtures/web.mjs";
import { git, provider } from "./fixtures/adoption.mjs";
import { applyCollection, previewCollection } from "../src/web/collection-service.ts";

const servers = webServers();
test("an empty project guides a human through charter creation without staging or approval", async () => {
  const root = servers.project(),
    path = join(root, "workbench/CHARTER.md");
  const staged = git(root, "show", ":workbench/CHARTER.md");
  rmSync(path);
  const web = await servers.start(root);
  const home = await readWebPage(web, "/");
  expect(home.html).toContain("Get started");
  expect(home.html).toContain("Create charter for demo");
  expect(home.html).toContain("workbench init --records-only");
  const page = await readWebPage(web, "/charter/new?project=demo");
  const csrf = hiddenValue(page.html, "csrf");
  const text = "# Human fixture charter\n\n<!-- Keep this comment. -->\n\nPreserve local documents.\n";
  const missing = await postWebForm(
    web,
    "/actions/charter-create",
    { csrf, project: "demo", contents: text },
    { Accept: "text/html" },
  );
  expect(missing.status).toBe(400);
  expect(await missing.text()).toContain("Your draft is preserved below");
  expect(existsSync(path)).toBe(false);
  const saved = await postWebForm(
    web,
    "/actions/charter-create",
    {
      csrf,
      project: "demo",
      contents: text,
      human_written: "yes",
    },
    { Accept: "text/html" },
  );
  expect(saved.status).toBe(303);
  expect(readFileSync(path, "utf8")).toBe(text);
  expect(git(root, "show", ":workbench/CHARTER.md")).toBe(staged);
  expect(existsSync(join(root, ".git/workbench/review.json"))).toBe(false);
  expect((await readWebPage(web, "/charter/new?project=demo")).response.status).toBe(409);
  expect((await readWebPage(web, "/record?id=demo:CHARTER")).html).toContain("Human fixture charter");
});
test("concurrent charter creation preserves the external file and the submitted draft", async () => {
  const root = servers.project(),
    path = join(root, "workbench/CHARTER.md");
  rmSync(path);
  const web = await servers.start(root);
  const page = await readWebPage(web, "/charter/new?project=demo");
  writeFileSync(path, "# External human charter\n");
  const failed = await postWebForm(
    web,
    "/actions/charter-create",
    {
      csrf: hiddenValue(page.html, "csrf"),
      project: "demo",
      contents: "# Browser draft retained\n",
      human_written: "yes",
    },
    { Accept: "text/html" },
  );
  expect(failed.status).toBe(409);
  expect(await failed.text()).toContain("# Browser draft retained");
  expect(readFileSync(path, "utf8")).toBe("# External human charter\n");
});
test("project queues point to remaining collection reviews without mixing their entries", async () => {
  const root = servers.project(),
    source = provider(root);
  const request = { source: source.directory, commit: source.commit, collection: ".", visibility: "public" as const };
  applyCollection(root, request, previewCollection(root, request).digest);
  git(root, "add", "workbench");
  const web = await servers.start(root);
  const page = await readWebPage(web, "/review");
  expect(page.html).toContain('aria-label="Reviews in other sources"');
  expect(page.html).toContain('href="/review?collection=company"');
  expect(page.html).toContain('aria-label="Record sources"');
  expect(page.html).not.toContain("need review)");
  expect(page.html).not.toContain('<h2 class="file-path">workbench/collections/company/decisions/ADR-00.md');
});
test("read views have one primary heading and quiet routine reconciliation", async () => {
  const root = servers.project(),
    web = await servers.start(root);
  const page = await readWebPage(web, "/record?id=demo:ADR-0");
  expect(page.html.match(/<h1(?:\s|>)/g)).toHaveLength(1);
  expect(page.html).toContain('id="adr-0-files"');
  expect(page.html).not.toContain("Workspace current.");
  expect(page.html).not.toContain("Files checked at");
  expect(page.html).not.toContain("Project files remain the source of truth");
});
