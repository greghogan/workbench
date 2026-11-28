import { parseDOM } from "../../fixtures/dom.mjs";
import { beforeEach, expect, test, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { startWebServer } from "../../../src/server/http/server.ts";
import { ReviewSource, reviewStatus, presentedReviewDigest } from "../../../src/core/review/review-service.ts";
import { checkReview } from "../../../src/core/review/review-check.js";
import { webServers, readReconciledWebPage, postWebForm, hiddenValue } from "../../fixtures/web.mjs";
import { git } from "../../fixtures/adoption.mjs";

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
function post(path: string, values: Record<string, string>, headers: Record<string, string> = {}) {
  return postWebForm(web, path, values, headers);
}

test("browser saves retain comments and reject concurrent edits while preserving the submitted draft", async () => {
  const editor = await get("/records/demo:ADR-0?view=edit");
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
  const pending = parseDOM((await get("/reviews")).html).window.document;
  expect(pending.querySelector("a[data-card-link]")?.getAttribute("href")).toContain("/records/demo:ADR-0/review");
  expect(pending.querySelector("main")?.textContent).not.toContain("Needs review");
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

test("oversized form submissions return a bounded diagnostic and leave project files untouched", async () => {
  const editor = await get("/records/demo:ADR-0?view=edit"),
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

test("a concurrent writer returns a conflict without replacing the file", async () => {
  const editor = await get("/records/demo:ADR-0?view=edit"),
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
    current = "---\nsummary: Fresh source.\n---\n\n# ADR-0: Newly opened source\n";
  writeFileSync(join(root, path), current);
  const editorResponse = await fetch(web.url + "/records/demo:ADR-0?view=edit"),
    editor = await editorResponse.text();
  expect(editorResponse.status).toBe(200);
  expect(editor).toContain("Newly opened source");
  const saved = await post("/actions/save", {
    csrf: hiddenValue(editor, "csrf"),
    expected: hiddenValue(editor, "expected"),
    id: "demo:ADR-0",
    contents: current + "\nSaved from current editor.\n",
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

test("cancelled review reads finish shared reconciliation without retaining an unseen presentation", async () => {
  const { ReviewVersions } = await import("../../../src/server/review/review-versions.ts");
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const reconcile = vi.spyOn(web.monitor, "reconcile");
  const retain = vi.spyOn(ReviewVersions.prototype, "retainBatch");
  const disconnected = Promise.withResolvers<undefined>();
  const received = (_request: IncomingMessage, response: ServerResponse) => {
    response.once("close", () => {
      disconnected.resolve(undefined);
    });
    // A background workspace refresh can run before the HTTP request is dispatched.
    reconcile.mockImplementationOnce(() => {
      entered();
      return blocked;
    });
  };
  web.server.prependOnceListener("request", received);
  const request = httpRequest(web.url + "/records/demo:ADR-0/review");
  let canceling = false;
  const watchdog = AbortSignal.timeout(15_000);
  const failed = new Promise<never>((_resolve, reject) => {
    watchdog.addEventListener(
      "abort",
      () => {
        reject(new Error("Review cancellation fixture did not complete"));
      },
      { once: true },
    );
    request.on("error", (error) => {
      if (!canceling) reject(error);
    });
  });
  try {
    request.end();
    await Promise.race([admitted, failed]);
    canceling = true;
    request.destroy();
    await Promise.race([disconnected.promise, failed]);
    release();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(retain).not.toHaveBeenCalled();
  } finally {
    release();
    web.server.off("request", received);
    reconcile.mockRestore();
    retain.mockRestore();
    request.destroy();
  }
});
