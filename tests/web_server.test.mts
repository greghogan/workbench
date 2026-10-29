import { RecordLookup } from "../src/record-lookup.js";
import { renderToString } from "preact-render-to-string";
import { parseDOM } from "./fixtures/dom.mjs";
import { beforeEach, expect, test, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { startWebServer } from "../src/web/server.ts";
import { ReviewSource, reviewStatus, presentedReviewDigest } from "../src/review-service.ts";
import { checkReview } from "../src/review.ts";
import { webServers, readWebPage, postWebForm, hiddenValue } from "./fixtures/web.mjs";
import { git } from "./fixtures/adoption.mjs";
import { markdown as markdownView } from "../src/web/markdown-view.js";
import { sourceDiffView as difference } from "../src/web/diff-view.js";
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
  return readWebPage(web, path);
}
function post(path: string, values: Record<string, string>, headers: Record<string, string> = {}) {
  return postWebForm(web, path, values, headers);
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
  const task = await get("/record?id=demo:TSK-0");
  expect(task.html).not.toContain("view=edit");
  expect(task.html).not.toContain("view=changes");
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# Working update\n");
  const diff = await get("/record?id=demo:ADR-0&view=changes&layout=split");
  expect(diff.html).not.toContain("Compare with committed HEAD");
  expect(parseDOM(diff.html).window.document.querySelector(".document-diff.split")).not.toBeNull();
  expect(diff.html).toContain("Working update");
  expect((await get("/record?id=demo:ADR-0&view=source")).response.status).toBe(400);
  expect((await get("/missing")).response.status).toBe(404);
  expect((await get("/record?id=missing")).response.status).toBe(404);
});
test("browser saves retain comments and reject concurrent edits while preserving the submitted draft", async () => {
  const editor = await get("/record?id=demo:ADR-0&view=edit");
  const csrf = hiddenValue(editor.html, "csrf"),
    expected = hiddenValue(editor.html, "expected");
  const contents = "---\n# Keep comment\nsummary: Human edit.\n---\n\n# ADR-0: Human edit\n";
  const saved = await post("/actions/save", { csrf, expected, id: "demo:ADR-0", contents });
  expect(saved.status).toBe(200);
  expect(readFileSync(join(root, "workbench/decisions/ADR-00.md"), "utf8")).toBe(contents);
  const stale = await post("/actions/save", { csrf, expected, id: "demo:ADR-0", contents: "Unsaved human draft" });
  expect(stale.status).toBe(409);
  expect(await stale.text()).toContain("changed since");
  const fallback = await post(
    "/actions/save",
    { csrf, expected, id: "demo:ADR-0", contents: "Unsaved <draft>" },
    { Accept: "text/html" },
  );
  expect(fallback.status).toBe(409);
  const fallbackDocument = parseDOM(await fallback.text()).window.document;
  expect(fallbackDocument.querySelector<HTMLTextAreaElement>("#record-editor")?.value).toBe("Unsaved <draft>");
  expect(readFileSync(join(root, "workbench/decisions/ADR-00.md"), "utf8")).toBe(contents);
  expect(reviewStatus(root, ReviewSource.Staged).changes).toEqual([]);
});
test("review confirms current bytes, rejects unseen commit contents, and enforces charter authorship", async () => {
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# Staged proposal\n");
  writeFileSync(join(root, "workbench/CHARTER.md"), "# Human charter\n");
  git(root, "add", ".");
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# Different working file\n");
  const path = "workbench/decisions/ADR-00.md";
  const review = await get(`/review?path=${path}`);
  expect(review.html).toContain("Different working file");
  expect(review.html).not.toContain("Staged proposal");
  const csrf = hiddenValue(review.html, "csrf"),
    digest = hiddenValue(review.html, "digest");
  expect((await post("/actions/approve", { csrf, path, digest })).status).toBe(400);
  expect((await post("/actions/approve", { csrf, path, digest, reviewed: "yes" })).status).toBe(200);
  expect(reviewStatus(root, ReviewSource.Staged).changes.find((change) => change.path === path)?.approved).toBe(false);
  expect(reviewStatus(root, ReviewSource.Working).changes.find((change) => change.path === path)?.approved).toBe(true);
  const charter = await get("/review?path=workbench/CHARTER.md");
  const values = { csrf, path: "workbench/CHARTER.md", digest: hiddenValue(charter.html, "digest"), reviewed: "yes" };
  expect((await post("/actions/approve", values)).status).toBe(400);
  expect((await post("/actions/approve", { ...values, human_written: "yes" })).status).toBe(200);
  expect(() => {
    checkReview(root);
  }).toThrow(/human review/);
  const exact = await get(`/review-file?path=${path}&digest=${digest}&side=after`);
  expect(exact.html).toBe("# Different working file\n");
  const diff = await get(`/review?path=${path}&view=diff`);
  expect(parseDOM(diff.html).window.document.querySelector("form[data-review]")).toBeNull();
  git(root, "add", path);
  checkReview(root);
  writeFileSync(join(root, path), "# Another current revision\n");
  expect((await post("/actions/approve", { csrf, path, digest, reviewed: "yes" })).status).toBe(200);
  expect(reviewStatus(root, ReviewSource.Working).changes.find((change) => change.path === path)?.approved).toBe(false);
  const retained = await get(`/review-file?path=${path}&digest=${digest}&side=after`);
  expect(retained.response.status).toBe(200);
  expect(retained.html).toBe("# Different working file\n");
  const pending = parseDOM((await get("/review")).html).window.document;
  expect(pending.querySelector("a[data-card-link]")?.getAttribute("href")).toContain("id=demo%3AADR-0");
  expect(pending.querySelector("main")?.textContent).not.toContain("Needs review");
});
test("supporting file views are bounded to registered ownership and download inert bytes", async () => {
  mkdirSync(join(root, "workbench/decisions/ADR-00"));
  writeFileSync(join(root, "workbench/decisions/ADR-00/evidence.txt"), "Retained evidence\n");
  writeFileSync(join(root, "workbench/decisions/ADR-00/active.html"), "<script>window.bad=true</script>");
  const path = "/file?id=demo:ADR-0&path=workbench/decisions/ADR-00/evidence.txt";
  expect((await get(path)).html).toContain("Retained evidence");
  const download = await get(path + "&download=1");
  expect(download.html).toBe("Retained evidence\n");
  expect(download.response.headers.get("content-disposition")).toContain("attachment");
  expect((await get("/file?id=demo:ADR-0&path=../../etc/passwd")).response.status).toBe(404);
  const preview = parseDOM((await get("/file?id=demo:ADR-0&path=workbench/decisions/ADR-00/active.html")).html);
  try {
    expect(preview.window.document.querySelector("pre.source")?.textContent).toBe("<script>window.bad=true</script>");
    expect(preview.window.document.querySelector("main script")).toBeNull();
  } finally {
    preview.window.close();
  }
});
test("local origin and explicit browser acknowledgment protect review mutations", async () => {
  const hostileHost = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(web.url, { headers: { Host: "attacker.invalid:8080" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  expect(hostileHost).toBe(403);
  expect((await fetch(web.url, { headers: { Origin: "https://attacker.invalid" } })).status).toBe(403);
  expect((await fetch(web.url, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" } })).status).toBe(
    403,
  );
  const home = await get("/");
  expect(home.response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect((await post("/actions/save", { csrf: "wrong" })).status).toBe(403);
  expect((await fetch(web.url, { method: "PUT" })).status).toBe(405);
  expect(
    (
      await fetch(web.url + "/actions/save", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      })
    ).status,
  ).toBe(400);
});
test("live events detect external saves and new records, and close cleanly with the service", async () => {
  const controller = new AbortController();
  const response = await fetch(web.url + "/events", { signal: controller.signal });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing events");
  const initial = await reader.read();
  expect(Buffer.from(initial.value ?? []).toString()).toContain("event: revision");
  const changed = once(web.monitor, "change", { signal: AbortSignal.timeout(5000) });
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# External save\n");
  await changed;
  let received = "";
  while (!received.includes(web.monitor.revision)) {
    const next = await reader.read();
    if (next.done) throw new Error("live stream ended before the revision event");
    received += Buffer.from(next.value).toString();
  }
  expect(received).toContain(`event: revision\ndata: ${web.monitor.revision}`);
  const discovered = once(web.monitor, "change", { signal: AbortSignal.timeout(5000) });
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(join(root, "workbench/tasks/TSK-00.md"), "# New task\n");
  await discovered;
  expect((await get("/records?type=TSK")).html).toContain("New task");
  controller.abort();
  await reader.cancel().catch(() => undefined);
  await web.close();
  await web.close();
});
test("collection requests remain responsive and require the exact prepared proposal", async () => {
  await web.close();
  const request = {
    source: "/local/provider",
    commit: "a".repeat(40),
    collection: ".",
    visibility: "private" as const,
  };
  const plan = {
    differences: {},
    digest: "b".repeat(64),
    pin: { id: "company", revision: "1", sha256: "c".repeat(64), scopes: ["."], visibility: "private" as const },
    files: [
      {
        path: "workbench/collections/company/decisions/ADR-00.md",
        before: null,
        after: "# Provider",
        before_sha256: null,
        after_sha256: "d".repeat(64),
      },
    ],
  };
  const runner = vi.fn().mockResolvedValueOnce(plan).mockResolvedValueOnce({ id: "company", issues: [], omitted: 0 });
  web = await servers.start(root, { port: 0, collectionRunner: runner });
  const page = await get("/collections"),
    csrf = hiddenValue(page.html, "csrf");
  const preview = await post("/actions/collection-preview", { csrf, ...request });
  const result = (await preview.json()) as { redirect: string };
  expect(preview.status).toBe(200);
  const proposal = await get(result.redirect);
  expect(proposal.html).toContain("# Provider");
  const token = hiddenValue(proposal.html, "token");
  expect((await post("/actions/collection-apply", { csrf, token })).status).toBe(400);
  const applied = await post("/actions/collection-apply", { csrf, token, reviewed: "yes" });
  expect(applied.status).toBe(200);
  const landing = (await applied.json()) as { redirect: string };
  expect(landing.redirect).toBe("/review?collection_applied=company");
  expect((await get(landing.redirect)).html).toContain("Project context synchronized and validation passed.");
  expect(runner.mock.calls[1]?.[3]).toBe(plan.digest);
  expect((await get(result.redirect)).response.status).toBe(409);
});
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
  expect(diffView(null, { records: new RecordLookup([]) }, true)).toContain("No source differences");
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

test("collection work keeps browsing responsive, rejects competing mutations, and drains on shutdown", async () => {
  await web.close();
  const entered = Promise.withResolvers<undefined>(),
    finish = Promise.withResolvers<undefined>();
  const runner = vi.fn(() => {
    entered.resolve(undefined);
    return finish.promise;
  });
  web = await servers.start(root, { port: 0, collectionRunner: runner });
  const page = await get("/collections"),
    csrf = hiddenValue(page.html, "csrf");
  const values = { csrf, source: "/fixture", commit: "a".repeat(40), visibility: "public", collection: "." };
  const editor = await get("/record?id=demo:ADR-0&view=edit");
  const original = readFileSync(join(root, "workbench/decisions/ADR-00.md"), "utf8");
  const pending = post("/actions/collection-preview", values);
  try {
    await entered.promise;
    expect((await get("/")).response.status).toBe(200);
    expect(
      (
        await post("/actions/save", {
          csrf,
          id: "demo:ADR-0",
          expected: hiddenValue(editor.html, "expected"),
          contents: "# ADR-0: Concurrent edit\n",
        })
      ).status,
    ).toBe(409);
    expect(readFileSync(join(root, "workbench/decisions/ADR-00.md"), "utf8")).toBe(original);
    expect((await post("/actions/collection-preview", values)).status).toBe(409);
    let closed = false;
    const closing = web.close().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    finish.resolve(undefined);
    expect((await pending).status).toBe(500);
    await closing;
    expect(closed).toBe(true);
  } finally {
    finish.resolve(undefined);
    await pending;
    await web.close();
  }
});

test("new repositories without a first commit remain browsable", async () => {
  git(root, "update-ref", "-d", "HEAD");
  expect((await get("/")).response.status).toBe(200);
  expect((await get("/record?id=demo:ADR-0")).html).toContain("Keep files authoritative");
  expect((await get("/review")).response.status).toBe(200);
});

test("a request whose body finishes during shutdown cannot admit a new mutation", async () => {
  const editor = await get("/record?id=demo:ADR-0&view=edit");
  const body = new URLSearchParams({
    csrf: hiddenValue(editor.html, "csrf"),
    expected: hiddenValue(editor.html, "expected"),
    id: "demo:ADR-0",
    contents: "Late draft",
  }).toString();
  const incoming = once(web.server, "request");
  const response = new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      web.url + "/actions/save",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.flushHeaders();
    void incoming
      .then(() => {
        const closing = web.close();
        request.end(body);
        return closing;
      })
      .catch(reject);
  });
  expect(await response).toBe(503);
  expect(readFileSync(join(root, "workbench/decisions/ADR-00.md"), "utf8")).toContain("Keep files authoritative");
});

test("browsing uses the last complete snapshot while acquisition is pending", async () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The captured method is called with its original receiver below.
  const post = Worker.prototype.postMessage;
  let release: () => void = () => {
    throw new Error("missing worker request");
  };
  const paused = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(function (
    this: Worker,
    value: unknown,
  ) {
    release = () => {
      post.call(this, value);
    };
  });
  const pending = web.monitor.reconcile(true);
  try {
    const path = join(root, "workbench/decisions/ADR-00.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\nChanged while background refresh is waiting.\n");
    const response = await fetch(web.url + "/record?id=demo:ADR-0", { signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Keep files authoritative");
    expect(html).not.toContain("Changed while background refresh is waiting");
    expect(html).not.toContain("Files checked at");
    expect(web.monitor.refreshing).toBe(true);
  } finally {
    paused.mockRestore();
    release();
    await pending;
  }
  expect((await readWebPage(web, "/record?id=demo:ADR-0", false)).html).toContain(
    "Changed while background refresh is waiting",
  );
});
test("a failed refresh retains readable data and reports its cause until recovery", async () => {
  const path = join(root, "workbench/config.toml"),
    config = readFileSync(path, "utf8");
  writeFileSync(path, "invalid TOML [");
  await expect(web.monitor.reconcile(true)).rejects.toThrow();
  const retained = await readWebPage(web, "/record?id=demo:ADR-0", false);
  expect(retained.response.status).toBe(200);
  expect(retained.html).toContain("Refresh failed:");
  expect(retained.html).toContain("Keep files authoritative");
  writeFileSync(path, config);
  await web.monitor.reconcile(true);
  expect(web.monitor.problem).toBe("");
  expect((await readWebPage(web, "/", false)).response.status).toBe(200);
});

test("oversized form submissions return a bounded diagnostic and leave project files untouched", async () => {
  const editor = await get("/record?id=demo:ADR-0&view=edit"),
    path = join(root, "workbench/decisions/ADR-00.md"),
    before = readFileSync(path, "utf8");
  const response = await post("/actions/save", {
    csrf: hiddenValue(editor.html, "csrf"),
    expected: hiddenValue(editor.html, "expected"),
    id: "demo:ADR-0",
    contents: "x".repeat(8 * 1024 * 1024),
  });
  expect(response.status).toBe(413);
  expect(await response.text()).toContain("8 MiB form limit");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("shutdown discards an in-flight refresh without publishing changes or reopening watchers", async () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The captured method is called with its original receiver below.
  const post = Worker.prototype.postMessage;
  let release: () => void = () => {
    throw new Error("missing held refresh");
  };
  const paused = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(function (
    this: Worker,
    value: unknown,
  ) {
    release = () => {
      post.call(this, value);
    };
  });
  const pending = web.monitor.reconcile(true),
    changed = vi.fn();
  web.monitor.on("change", changed);
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# Changed during shutdown\n");
  const closing = web.close();
  paused.mockRestore();
  release();
  await Promise.all([pending, closing]);
  expect(changed).not.toHaveBeenCalled();
});

test("a concurrent writer returns a conflict without replacing the file", async () => {
  const editor = await get("/record?id=demo:ADR-0&view=edit"),
    path = join(root, "workbench/decisions/ADR-00.md"),
    before = readFileSync(path, "utf8");
  mkdirSync(join(root, ".git/workbench/web-edit.lock"), { recursive: true });
  const response = await post("/actions/save", {
    csrf: hiddenValue(editor.html, "csrf"),
    expected: hiddenValue(editor.html, "expected"),
    id: "demo:ADR-0",
    contents: "Blocked draft",
  });
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("busy or needs recovery");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("opening an editor or review explicitly acquires the latest version", async () => {
  const path = "workbench/decisions/ADR-00.md",
    current = "# ADR-0: Newly opened source\n";
  writeFileSync(join(root, path), current);
  const editorResponse = await fetch(web.url + "/record?id=demo:ADR-0&view=edit"),
    editor = await editorResponse.text();
  expect(editorResponse.status).toBe(200);
  expect(editor).toContain("Newly opened source");
  const saved = await post("/actions/save", {
    csrf: hiddenValue(editor, "csrf"),
    expected: hiddenValue(editor, "expected"),
    id: "demo:ADR-0",
    contents: current + "Saved from current editor.\n",
  });
  expect(saved.status).toBe(200);
  git(root, "add", path);
  const reviewResponse = await fetch(web.url + "/review?path=" + encodeURIComponent(path)),
    review = await reviewResponse.text();
  expect(reviewResponse.status).toBe(200);
  expect(parseDOM(review).window.document.querySelector(".document-diff")?.textContent).toContain(
    "Saved from current editor.",
  );
  const status = reviewStatus(root, ReviewSource.Working),
    change = status.changes.find((change) => change.path === path);
  if (!change) throw new Error("Missing current review");
  expect(hiddenValue(review, "digest")).toBe(presentedReviewDigest(change, status.head));
});

test("explicit workspace retry follows the browser form response contract and requires the session token", async () => {
  const home = await get("/");
  const denied = await post("/actions/workspace-retry", { csrf: "another-session" });
  expect(denied.status).toBe(403);
  const response = await post("/actions/workspace-retry", { csrf: hiddenValue(home.html, "csrf") });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ redirect: "/" });
  expect((await fetch(web.url + "/actions/workspace-retry")).status).toBe(405);
});
