import { parseDOM } from "./fixtures/dom.mjs";
import { expect, test } from "vitest";
import { writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { webServers, readWebPage, postWebForm, hiddenValue } from "./fixtures/web.mjs";
import { git } from "./fixtures/adoption.mjs";
import {
  approvePresentedReview,
  readReviewReceipt,
  reviewedBaselines,
  reviewStatus,
  reviewChangeDigest,
  presentedReviewDigest,
  ReviewSource,
  type PresentedReview,
} from "../src/review-service.ts";
import { ReviewVersions } from "../src/web/review-versions.ts";

const fixture = webServers(),
  path = "workbench/decisions/ADR-00.md";
const record = (body: string) => `---\nsummary: Review version retention.\n---\n\n# ADR-0: Versions\n\n${body}\n`;
function version(root: string, contents: string): PresentedReview {
  writeFileSync(join(root, path), contents);
  const change = reviewStatus(root, ReviewSource.Working).changes.find((change) => change.path === path);
  if (!change) throw new Error("Missing changed version");
  return {
    head: reviewStatus(root, ReviewSource.Working).head,
    change,
    contents: Buffer.from(contents).toString("base64"),
  };
}

test("a displayed version can be acknowledged after disk changes; the new diff starts at that exact acknowledgment", async () => {
  const root = fixture.project(),
    shown = record("Presented sentence."),
    latest = record("Newer sentence.");
  writeFileSync(join(root, path), shown);
  writeFileSync(
    join(root, "workbench/decisions/ADR-01.md"),
    "---\nsummary: Another pending decision.\n---\n\n# ADR-1: Another review\n\nReview this afterward.\n",
  );
  const web = await fixture.start(root),
    page = await readWebPage(web, "/records/demo:ADR-0/review?layout=split");
  const form = {
    csrf: hiddenValue(page.html, "csrf"),
    path,
    digest: hiddenValue(page.html, "digest"),
    reviewed: "yes",
    review_layout: "split",
  };
  writeFileSync(join(root, path), latest);
  await web.monitor.reconcile(true);
  const status = await fetch(web.url + "/review-status?id=demo:ADR-0");
  const statusPage = (await status.json()) as { versions: { path: string; digest: string }[] };
  const unshown = await postWebForm(web, "/actions/approve", { ...form, digest: statusPage.versions[0]?.digest ?? "" });
  expect(unshown.status).toBe(409);
  const response = await postWebForm(web, "/actions/approve", form);
  expect(response.status).toBe(200);
  const location = new URL(((await response.json()) as { redirect: string }).redirect, web.url);
  expect(location.searchParams.get("layout")).toBe("split");
  expect(readFileSync(join(root, path), "utf8")).toBe(latest);
  expect(reviewStatus(root, ReviewSource.Working).changes.find((change) => change.path === path)?.approved).toBe(false);
  expect(reviewedBaselines(root).get(path)?.contents).toBe(shown);
  const next = await readWebPage(web, location.pathname + location.search);
  expect(next.html).toContain("Presented");
  expect(next.html).toContain("Newer");
  const unknown = await postWebForm(web, "/actions/approve", { ...form, digest: "0".repeat(64) });
  expect(unknown.status).toBe(409);
  const failure = (await unknown.json()) as { recovery: { href: string; label: string } };
  const refreshed = parseDOM((await readWebPage(web, failure.recovery.href)).html).window.document;
  expect(refreshed.querySelector('input[name="path"]')?.getAttribute("value")).toBe(path);
  expect(refreshed.querySelector('nav[aria-label="Difference layout"] [aria-current="page"]')?.textContent).toBe(
    "Side-by-side",
  );
});

test("retained versions are immutable, bind their path and evict by count and byte capacity", () => {
  const root = fixture.project(),
    store = new ReviewVersions({ capacity: 2 }),
    values = ["First", "Second", "Third"].map((text) => version(root, record(text)));
  const retain = (value: PresentedReview) => {
    store.retain(value.change, { before: null, after: value.contents, error: "" }, value.head);
  };
  for (const value of values) retain(value);
  const [first, second, third] = values;
  if (!first || !second || !third) throw new Error("Missing versions");
  const digest = (value: PresentedReview) => presentedReviewDigest(value.change, value.head);
  expect(() => store.get(path, digest(first))).toThrow(/no longer retained/);
  expect(store.get(path, digest(second)).version.contents).toBe(second.contents);
  expect(() => store.get(path, "missing")).toThrow(/no longer retained/);
  const current = digest(third);
  if (!current) throw new Error("Missing digest");
  expect(store.get(path, current).version.contents).toBe(third.contents);
  third.change.path = "other.md";
  expect(store.get(path, current).version.change.path).toBe(path);
  expect(() => store.get("other.md", current)).toThrow(/no longer retained/);
  expect(() => {
    new ReviewVersions({ capacity: 2, maximumBytes: 1 }).retain(
      first.change,
      { before: null, after: first.contents, error: "" },
      first.head,
    );
  }).toThrow(/capacity/);
  const limited = new ReviewVersions({ capacity: 10, maximumBytes: 4096 }),
    large = [version(root, record("a".repeat(700))), version(root, record("b".repeat(700)))];
  for (const value of large)
    limited.retain(value.change, { before: null, after: value.contents, error: "" }, value.head);
  const firstLarge = large[0];
  if (!firstLarge) throw new Error("Missing byte-capacity fixture");
  expect(() => limited.get(path, digest(firstLarge))).toThrow(/no longer retained/);
  store.clear();
  expect(() => store.get(path, current)).toThrow(/no longer retained/);
});

test("acknowledging a displayed deletion does not approve a subsequently restored file", async () => {
  const root = fixture.project();
  rmSync(join(root, path));
  const web = await fixture.start(root),
    page = await readWebPage(web, "/records/demo:ADR-0/review");
  const restored = record("Restored after the displayed deletion.");
  writeFileSync(join(root, path), restored);
  const response = await postWebForm(web, "/actions/approve", {
    csrf: hiddenValue(page.html, "csrf"),
    path,
    digest: hiddenValue(page.html, "digest"),
    reviewed: "yes",
  });
  expect(response.status).toBe(200);
  expect(readFileSync(join(root, path), "utf8")).toBe(restored);
  expect(reviewedBaselines(root).get(path)?.contents).toBe("");
  expect(reviewStatus(root, ReviewSource.Working).changes.find((change) => change.path === path)?.approved).toBe(false);
});

test("binary supporting-file downloads and acknowledgment remain bound to their presented bytes", async () => {
  const root = fixture.project(),
    support = "workbench/decisions/ADR-00/payload.bin",
    original = Buffer.from([0, 1, 2]);
  mkdirSync(join(root, "workbench/decisions/ADR-00"));
  writeFileSync(join(root, support), original);
  const web = await fixture.start(root),
    page = await readWebPage(web, "/records/demo:ADR-0/review"),
    digest = hiddenValue(page.html, "digest");
  writeFileSync(join(root, support), Buffer.from([0, 3, 4]));
  const download = await fetch(
    web.url + `/review-file?path=${encodeURIComponent(support)}&digest=${digest}&side=after`,
  );
  expect(download.status).toBe(200);
  expect(Buffer.from(await download.arrayBuffer())).toEqual(original);
  const response = await postWebForm(web, "/actions/approve", {
    csrf: hiddenValue(page.html, "csrf"),
    path: support,
    digest,
    reviewed: "yes",
  });
  expect(response.status).toBe(200);
  expect(reviewStatus(root, ReviewSource.Working).changes.find((change) => change.path === support)?.approved).toBe(
    false,
  );
});

test("successive acknowledgments retain a valid bounded receipt and reject mismatched snapshot bytes", () => {
  const root = fixture.project();
  for (let index = 0; index < 6; index++) {
    const contents = record(`Version ${String(index)}.`),
      presented = version(root, contents);
    const digest = presentedReviewDigest(presented.change, presented.head);
    if (!digest) throw new Error("Missing digest");
    expect(() => {
      approvePresentedReview(
        root,
        { ...presented, contents: Buffer.from("wrong bytes").toString("base64") },
        digest,
        false,
      );
    }).toThrow(/invalid/);
    approvePresentedReview(root, presented, digest, false);
    expect(reviewedBaselines(root).get(path)?.contents).toBe(contents);
    expect(readReviewReceipt(join(root, ".git/workbench/review.json")).state).toBe("ready");
  }
});

test("review version identity is independent of presentation metadata or approval status", () => {
  const root = fixture.project(),
    presented = version(root, record("Identity."));
  const annotated = { ...presented.change, digest: "presentation", approved: true };
  expect(reviewChangeDigest(annotated)).toBe(reviewChangeDigest(presented.change));
});

test("retention admits a complete page or leaves all earlier presentations intact", () => {
  const store = new ReviewVersions({ capacity: 2 });
  const change = (path: string) => ({
    path,
    before: "100644:" + "a".repeat(40),
    after: "100644:" + "b".repeat(40),
    charter: false,
  });
  const presentation = (path: string) => ({
    change: change(path),
    document: { before: null, after: "Yg==", error: "" },
  });
  const original = presentation("original.md");
  store.retainBatch([original], "");
  expect(() => {
    store.retainBatch([presentation("one.md"), presentation("two.md"), presentation("three.md")], "");
  }).toThrow(/complete review exceeds/);
  expect(store.get(original.change.path, presentedReviewDigest(original.change, "")).version.change).toEqual(
    original.change,
  );
  const next = [presentation("one.md"), presentation("two.md")];
  store.retainBatch(next, "");
  for (const { change } of next)
    expect(store.get(change.path, presentedReviewDigest(change, "")).version.change.path).toBe(change.path);
});

test("presentations from distinct HEADs remain distinct and acknowledgment retains the original HEAD", () => {
  const root = fixture.project(),
    presented = version(root, record("Shown before unrelated commit.")),
    store = new ReviewVersions();
  store.retain(presented.change, { before: null, after: presented.contents, error: "" }, presented.head);
  writeFileSync(join(root, "unrelated.txt"), "unrelated commit");
  git(root, "add", "unrelated.txt");
  git(root, "commit", "-m", "unrelated");
  const currentHead = reviewStatus(root, ReviewSource.Working).head;
  expect(currentHead).not.toBe(presented.head);
  const digest = presentedReviewDigest(presented.change, presented.head),
    currentDigest = presentedReviewDigest(presented.change, currentHead);
  store.retain(presented.change, { before: null, after: presented.contents, error: "" }, currentHead);
  expect(store.get(path, digest).version.head).toBe(presented.head);
  expect(store.get(path, currentDigest).version.head).toBe(currentHead);
  approvePresentedReview(root, store.get(path, digest).version, digest, false);
  expect(reviewedBaselines(root).get(path)).toBeUndefined();
  expect(reviewedBaselines(root, presented.head).get(path)?.contents).toBe(record("Shown before unrelated commit."));
});
