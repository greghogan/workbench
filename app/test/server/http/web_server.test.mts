import { RecordLookup } from "../../../src/core/records/record-lookup.js";
import { renderToString } from "preact-render-to-string";
import { parseDOM } from "../../fixtures/dom.mjs";
import { beforeEach, expect, test } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { startWebServer } from "../../../src/server/http/server.ts";
import { ReviewSource, reviewStatus } from "../../../src/core/review/review-service.ts";
import { webServers, readReconciledWebPage } from "../../fixtures/web.mjs";
import { git } from "../../fixtures/adoption.mjs";
import { markdown as markdownView } from "../../../src/server/views/markdown-view.js";
import { sourceDiffView as difference } from "../../../src/server/views/diff-view.js";

const markdown = (...args: Parameters<typeof markdownView>) => renderToString(markdownView(...args));
const diffView = (...args: Parameters<typeof difference>) => renderToString(difference(...args));
const servers = webServers();
let root: string;
let web: Awaited<ReturnType<typeof startWebServer>>;
beforeEach(async () => {
  root = servers.project();
  web = await servers.start(root, { port: 0, pollInterval: 50 });
});
async function get(path: string) {
  return readReconciledWebPage(web, path);
}

test("record browsing, full text search, typed filters, offline assets, and source differences", async () => {
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(
    join(root, "workbench/tasks/TSK-00.md"),
    "---\nstatus: Planned\n---\n\n# Task zero\n\nUnique body needle.\n",
  );
  const home = await get("/");
  expect(home.response.status).toBe(200);
  expect(home.html).toContain('aria-label="Main navigation"');
  const search = await get("/records?q=needle&type=TSK&scope=demo");
  expect(search.html).toContain("Task zero");
  expect((await get("/records?q=needle&type=ADR")).html).toContain("No matching records");
  expect((await get("/assets/client.js")).response.headers.get("content-type")).toContain("javascript");
  expect((await get("/assets/style.css")).html).toContain("prefers-reduced-motion");
  const task = await get("/records/demo:TSK-0");
  expect(task.html).not.toContain("view=edit");
  expect(task.html).not.toContain("view=changes");
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# Working update\n");
  const diff = await get("/records/demo:ADR-0?view=changes&layout=split");
  expect(diff.html).not.toContain("Compare with committed HEAD");
  expect(parseDOM(diff.html).window.document.querySelector(".document-diff.split")).not.toBeNull();
  expect(diff.html).toContain("Working update");
  expect((await get("/records/demo:ADR-0?view=source")).response.status).toBe(400);
  expect((await get("/missing")).response.status).toBe(404);
  expect((await get("/records/missing")).response.status).toBe(404);
});

test("supporting file views are bounded to registered ownership and download inert bytes", async () => {
  mkdirSync(join(root, "workbench/decisions/ADR-00"));
  writeFileSync(join(root, "workbench/decisions/ADR-00/evidence.txt"), "Retained evidence\n");
  writeFileSync(join(root, "workbench/decisions/ADR-00/active.html"), "<script>window.bad=true</script>");
  const path = "/records/demo:ADR-0/files?path=workbench/decisions/ADR-00/evidence.txt";
  expect((await get(path)).html).toContain("Retained evidence");
  const download = await get(path + "&download=1");
  expect(download.html).toBe("Retained evidence\n");
  expect(download.response.headers.get("content-disposition")).toContain("attachment");
  expect((await get("/records/demo:ADR-0/files?path=../../etc/passwd")).response.status).toBe(404);
  const preview = parseDOM((await get("/records/demo:ADR-0/files?path=workbench/decisions/ADR-00/active.html")).html);
  try {
    expect(preview.window.document.querySelector("pre.source")?.textContent).toBe("<script>window.bad=true</script>");
    expect(preview.window.document.querySelector("main script")).toBeNull();
  } finally {
    preview.window.close();
  }
});

test.each(["md", "markdown"])(
  "supporting .%s files render formatted content and resolve links from their own directory",
  async (extension) => {
    const directory = join(root, "workbench/decisions/ADR-00");
    mkdirSync(directory);
    const contents =
      '# Source review\n\n## Findings\n\nSee ADR-0 and [the decision](../ADR-00.md), [a sibling](related.md), and [this section](#findings).\n\n- **Verified** behavior.\n\n```sh\nprintf "sample"\n```\n\n<script>window.bad=true</script>\n';
    writeFileSync(join(directory, `source-review.${extension}`), contents);
    writeFileSync(join(directory, "related.md"), "# Related evidence\n");
    mkdirSync(join(directory, "notes"));
    writeFileSync(join(directory, "notes/ordering.json"), '{"order": [1, 2]}\n');
    const path = `/records/demo:ADR-0/files?path=workbench/decisions/ADR-00/source-review.${extension}`;
    const document = parseDOM((await get(path)).html).window.document;
    const body = document.querySelector(".document");
    expect(body?.querySelector("h2")?.textContent).toBe("Source review");
    expect(body?.querySelector("li strong")?.textContent).toBe("Verified");
    expect(body?.querySelector("pre code")?.textContent).toContain('printf "sample"');
    expect(body?.querySelector("script")).toBeNull();
    expect(body?.textContent).toContain("<script>window.bad=true</script>");
    expect(body?.querySelector('a[data-record-reference="demo:ADR-0"]')?.getAttribute("data-record-summary")).toBe(
      "Keep files authoritative.",
    );
    const sibling = body?.querySelector<HTMLAnchorElement>('a[href*="related.md"]');
    const destination = new URL(sibling?.getAttribute("href") ?? "", "http://localhost");
    expect(destination.pathname).toBe("/records/demo:ADR-0/files");
    expect(Object.fromEntries(destination.searchParams)).toEqual({
      scope: "demo",
      path: "workbench/decisions/ADR-00/related.md",
    });
    const anchor = body?.querySelector<HTMLAnchorElement>('a[href^="#"]')?.getAttribute("href")?.slice(1);
    expect(anchor).toBeTruthy();
    expect(document.getElementById(anchor ?? "")?.textContent).toBe("Findings");
    const downloaded = await get(path + "&download=1");
    expect(downloaded.html).toBe(contents);
    expect(downloaded.response.headers.get("content-disposition")).toContain("attachment");
    const folder = "/records/demo:ADR-0/files?path=workbench/decisions/ADR-00";
    const rootFiles = parseDOM((await get(folder)).html).window.document;
    expect(rootFiles.querySelector("main a.record-row")?.textContent).toBe("notes/");
    const nested = parseDOM((await get(folder + "/notes")).html).window.document;
    expect(nested.querySelector("main a.record-row")?.textContent).toContain("ordering.json");
    const jsonFile = parseDOM((await get(folder + "/notes/ordering.json")).html).window.document;
    const breadcrumbs = [...jsonFile.querySelectorAll('nav[aria-label="Breadcrumb"] a')];
    expect(breadcrumbs.at(-1)?.textContent).toBe("notes");
    expect(breadcrumbs.at(-1)?.getAttribute("href")).toContain("path=workbench%2Fdecisions%2FADR-00%2Fnotes");
    expect(jsonFile.querySelector("pre.source")?.textContent).toBe('{"order": [1, 2]}\n');
    expect((await get("/records/demo:ADR-0/files?path=workbench/decisions")).response.status).toBe(404);
    expect((await get(folder + "&download=1")).response.status).toBe(400);
  },
);

test("Markdown and diff presentation escape active content and keep changes understandable without color", () => {
  const html = markdown(
    "# Heading\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![remote](https://example.invalid/tracker.png)",
    undefined,
    new RecordLookup([]),
  );
  const rendered = parseDOM(html);
  try {
    const document = rendered.window.document;
    expect(document.body.textContent).toContain("<script>alert(1)</script>");
    expect(document.querySelector("script, img, a[href^='javascript:']")).toBeNull();
  } finally {
    rendered.window.close();
  }
  const diff = "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n-old <text>\n+new <text>\n same\n";
  for (const split of [false, true]) {
    const renderedDiff = parseDOM(
      diffView(
        { patch: diff, before: "old <text>\nsame\n", after: "new <text>\nsame\n" },
        { records: new RecordLookup([]) },
        split,
      ),
    );
    try {
      const document = renderedDiff.window.document;
      expect(document.querySelector("del")?.textContent).toContain("old");
      expect(document.querySelector("ins")?.textContent).toContain("new");
      expect(document.body.textContent).toContain("<text>");
      expect(document.querySelector("text")).toBeNull();
    } finally {
      renderedDiff.window.close();
    }
  }
  expect(diffView(null, { records: new RecordLookup([]) }, true)).toContain("No changes.");
});

test("suppressed titles and repeated Unicode headings keep consistent fragment identifiers", () => {
  const title = "Café 日本語";
  const contents = ["# " + title, "", "## " + title, "", "## " + title, "", "## Other `heading`!"].join("\n");
  const document = parseDOM(markdown(contents, undefined, new RecordLookup([]), title)).window.document;
  expect(document.querySelector("article > span")?.id).toBe("document-café-日本語");
  expect([...document.querySelectorAll("article h2")].map((heading) => heading.id)).toEqual([
    "document-café-日本語-1",
    "document-café-日本語-2",
    "document-other-heading",
  ]);
});

test("new repositories without a first commit remain browsable", async () => {
  git(root, "update-ref", "-d", "HEAD");
  expect((await get("/")).response.status).toBe(200);
  expect((await get("/records/demo:ADR-0")).html).toContain("Keep files authoritative");
  expect((await get("/reviews")).response.status).toBe(200);
});

test("unchanged ADRs omit Changes navigation while explicit comparisons remain available", async () => {
  const document = parseDOM((await get("/records/demo:ADR-0")).html).window.document;
  expect([...document.querySelectorAll('[aria-label="Record views"] a')].map((link) => link.textContent)).not.toContain(
    "Changes",
  );
  const unchanged = await get("/records/demo:ADR-0?view=changes");
  expect(unchanged.response.status).toBe(200);
  expect(unchanged.html).toContain("No changes.");
  writeFileSync(
    join(root, "workbench/decisions/ADR-00.md"),
    readFileSync(join(root, "workbench/decisions/ADR-00.md"), "utf8") + "\n<!-- Preserved source comment. -->\n",
  );
  const changed = parseDOM((await get("/records/demo:ADR-0")).html).window.document;
  expect([...changed.querySelectorAll('[aria-label="Record views"] a')].map((link) => link.textContent)).toContain(
    "Changes",
  );
});

test.skipIf(process.platform === "win32")(
  "permission-only differences survive tab filtering and reviewed permissions become the next baseline",
  async () => {
    const { chmodSync } = await import("node:fs");
    const { approveReviewFiles } = await import("../../../src/core/review/review-service.ts");
    const path = "workbench/decisions/ADR-00.md";
    git(root, "config", "core.filemode", "true");
    chmodSync(join(root, path), 0o755);
    const changed = await get("/records/demo:ADR-0?view=changes");
    expect(changed.html).toContain("Executable permission added");
    const change = reviewStatus(root, ReviewSource.Working).changes.find((change) => change.path === path);
    if (!change) throw new Error("Missing permission change");
    approveReviewFiles(root, [{ path, digest: change.digest }], false, ReviewSource.Working);
    const reviewed = parseDOM((await get("/records/demo:ADR-0")).html).window.document;
    expect(
      [...reviewed.querySelectorAll('[aria-label="Record views"] a')].map((link) => link.textContent),
    ).not.toContain("Changes");
    chmodSync(join(root, path), 0o644);
    expect((await get("/records/demo:ADR-0?view=changes")).html).toContain("Executable permission removed");
  },
);
