import { promised } from "./fixtures/promised.mjs";
import { required } from "../src/invariants.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { parse, stringify } from "yaml";
import { acquisitionPath, readCitation } from "../src/citation-record.ts";
import { formatFiles } from "../src/formatting.ts";
import {
  addCitation,
  citationStatus,
  fetchCitation,
  importCitation,
  listCitationStatus,
  syncCitations,
} from "../src/citations.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("citation metadata reads are bounded and reject incomplete source metadata before creating a record", async () => {
  let canceled = false;
  vi.stubGlobal(
    "fetch",
    (_url: Parameters<typeof globalThis.fetch>[0], options: Parameters<typeof globalThis.fetch>[1]) => {
      return promised(() => {
        assert.ok(options?.signal instanceof AbortSignal);
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(256 * 1024));
            },
            cancel() {
              canceled = true;
            },
          }),
        );
      });
    },
  );
  await assert.rejects(addCitation("/unused", "10.1234/example"), /1,048,576-byte/);
  assert.equal(canceled, true);
  for (const metadata of [null, [], {}, { type: "article" }]) {
    vi.stubGlobal("fetch", () => promised(() => new Response(JSON.stringify(metadata))));
    await assert.rejects(addCitation("/unused", "10.1234/example"), /metadata/);
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-citation-"));
  temporary.push(root);
  mkdirSync(join(root, "workbench/citations/CIT-00"), { recursive: true });
  writeFileSync(
    join(root, "workbench/config.toml"),
    'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[citations]\nlibrary_dir="library/citations"\n',
  );
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
  const path = join(root, "workbench/citations/CIT-00.json");
  const reference = {
    id: "demo-CIT-0",
    type: "article-journal",
    title: "Paper",
    author: [{ literal: "Author" }],
    issued: { "date-parts": [[2026]] },
    URL: "https://example.invalid/published",
  };
  const source = (kind: string) => ({
    kind,
    "landing-url": `https://example.invalid/${kind}`,
    "download-url": `https://example.invalid/${kind}.pdf`,
    status: "pending",
  });
  const metadata = { sources: [source("published"), source("preprint")] };
  writeFileSync(path, JSON.stringify([reference]));
  writeFileSync(acquisitionPath(path), stringify(metadata));
  return { root, path, reference, metadata };
}

test.each(["reordered", "replaced", "unchanged", "title edited", "metadata note edited", "URL edited"])(
  "acquisition with source %s during download",
  async (change) => {
    const { root, path, reference, metadata } = fixture();
    const pdf = "%PDF-1.7\nverified source bytes\n";
    let edited;
    vi.stubGlobal("fetch", () => {
      return promised(() => {
        if (change === "reordered") metadata.sources.reverse();
        else if (change === "replaced")
          required(metadata.sources[0], "Expected fixture value: metadata.sources[0]")["download-url"] =
            "https://example.invalid/replacement.pdf";
        else if (change === "title edited") reference.title = "Edited title";
        else if (change === "URL edited") reference.URL = "https://example.invalid/other";
        writeFileSync(path, JSON.stringify([reference]));
        edited = (change === "metadata note edited" ? "# New note\n" : "") + stringify(metadata);
        writeFileSync(acquisitionPath(path), edited);
        return new Response(pdf);
      });
    });
    const destination = join(root, "library/citations/CIT-00-published.pdf");
    if (["reordered", "replaced", "URL edited"].includes(change)) {
      await assert.rejects(
        fetchCitation(root, "demo:CIT-0", "published"),
        /changed during acquisition|CSL URL must match/,
      );
      assert.equal(readFileSync(acquisitionPath(path), "utf8"), edited);
      assert.ok(
        (parse(required(edited, "Edited acquisition")) as { sources: { sha256?: string }[] }).sources.every(
          (entry) => entry.sha256 === undefined,
        ),
      );
      assert.equal(existsSync(destination), false);
    } else {
      await fetchCitation(root, "demo:CIT-0", "published");
      assert.equal(readFileSync(destination, "utf8"), pdf);
      const saved = readCitation(path);
      assert.equal(saved.reference.title, reference.title);
      assert.deepEqual(saved.acquisition.sources[0], {
        ...metadata.sources[0],
        status: "acquired",
        sha256: createHash("sha256").update(pdf).digest("hex"),
      });
      if (change === "metadata note edited") assert.match(readFileSync(acquisitionPath(path), "utf8"), /# New note/);
    }
  },
);

test("identifier import retains every bibliographic field and the exact upstream bytes through batch formatting", async () => {
  const { root, path } = fixture();
  const original =
    JSON.stringify(
      {
        id: "upstream",
        type: "proceedings-article",
        title: "Original title",
        author: [{ literal: "Author" }],
        issued: { "date-parts": [[2026]] },
        abstract: "A complete abstract.",
        language: "en",
        ISBN: "12345",
        volume: 3,
        custom: { original_dataset: "dataset-1" },
      },
      null,
      4,
    ) + "\n\n";
  const fetch = vi.fn(
    (_url: Parameters<typeof globalThis.fetch>[0], options: Parameters<typeof globalThis.fetch>[1]) => {
      return promised(() => {
        assert.equal(
          new Headers(required(options, "Fixture value options").headers).get("Accept"),
          "application/vnd.citationstyles.csl+json",
        );
        return new Response(original);
      });
    },
  );
  vi.stubGlobal("fetch", fetch);
  const imported = await addCitation(root, "10.1234/example");
  assert.notEqual(imported, path);
  const saved = readCitation(imported);
  const input = JSON.parse(original) as Record<string, unknown>;
  assert.deepEqual(saved.reference, {
    ...input,
    id: "demo-CIT-1",
    type: "paper-conference",
    URL: "https://doi.org/10.1234/example",
  });
  const upstream = join(imported.slice(0, -5), "upstream.json");
  assert.equal(readFileSync(upstream, "utf8"), original);
  assert.equal(
    required(saved.acquisition.upstream, "Expected fixture value: saved.acquisition.upstream").sha256,
    createHash("sha256").update(original).digest("hex"),
  );
  await formatFiles(root, undefined, { all: true, write: true });
  await formatFiles(root, undefined, { all: true, check: true });
  assert.equal(readFileSync(upstream, "utf8"), original);
  assert.equal(fetch.mock.calls.length, 1);
  writeFileSync(upstream, original + " ");
  assert.throws(() => readCitation(imported), /upstream metadata SHA-256 differs/);
});

test("unavailable sources skip bulk acquisition and can later be explicitly fetched or manually imported", async () => {
  const { root, path, metadata } = fixture();
  for (const source of metadata.sources)
    Object.assign(source, { status: "unavailable", reason: "No access under current conditions." });
  writeFileSync(acquisitionPath(path), stringify(metadata));
  const bibliography = readFileSync(path);
  const pdf = "%PDF-1.7\nobtained later\n";
  const fetch = vi.fn(() => promised(() => new Response(pdf)));
  vi.stubGlobal("fetch", fetch);
  await syncCitations(root);
  assert.equal(fetch.mock.calls.length, 0);
  await fetchCitation(root, "demo:CIT-0", "published");
  const manual = join(root, "manual.pdf");
  writeFileSync(manual, pdf);
  await importCitation(root, "demo:CIT-0", manual, "preprint");
  for (const source of readCitation(path).acquisition.sources) {
    assert.equal(source.status, "acquired");
    assert.equal(source.reason, undefined);
    assert.equal(source.sha256, createHash("sha256").update(pdf).digest("hex"));
  }
  assert.deepEqual(readFileSync(path), bibliography);
});

test("citation status distinguishes recorded acquisition from local presence without creating storage", () => {
  const { root, path, metadata } = fixture();
  Object.assign(required(metadata.sources[0], "Acquisition source"), { status: "acquired", sha256: "a".repeat(64) });
  writeFileSync(acquisitionPath(path), stringify(metadata));
  const original = readFileSync(acquisitionPath(path));
  const entries = citationStatus(root);
  assert.deepEqual(
    entries.map(({ id, source, state, present }) => ({ id, source, state, present })),
    [
      { id: "demo:CIT-0", source: "published", state: "acquired", present: false },
      { id: "demo:CIT-0", source: "preprint", state: "pending", present: false },
    ],
  );
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  listCitationStatus(root, { missing: true, source: "published", json: true });
  assert.deepEqual(
    JSON.parse(String(required(output.mock.calls[0], "Expected fixture value: output.mock.calls[0]")[0])),
    [entries[0]],
  );
  output.mockClear();
  listCitationStatus(root, { missing: true, source: "published" });
  const rows = String(required(output.mock.calls[0], "Expected fixture value: output.mock.calls[0]")[0])
    .split("\n")
    .filter((line: string) => line.startsWith("|"))
    .map((line: string) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell: string) => cell.trim()),
    );
  assert.deepEqual(rows, [
    ["CITATION", "TITLE", "SOURCE", "FILE", "ACQUISITION", "PDF URL"],
    ["demo:CIT-0", "Paper", "published", "missing", "acquired", "set"],
  ]);
  assert.throws(() => citationStatus(root, "unknown"), /unknown project/);
  assert.equal(existsSync(join(root, "library")), false);
  assert.deepEqual(readFileSync(acquisitionPath(path)), original);
});

test("fetch reports only new PDFs with relative paths and summarizes verification on repeated runs", async () => {
  const { root } = fixture();
  const fetch = vi.fn(() => promised(() => new Response("%PDF-1.7\nfixture\n")));
  vi.stubGlobal("fetch", fetch);
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await syncCitations(root);
  assert.deepEqual(
    output.mock.calls.map(([message]) => String(message)),
    [
      "Fetched demo:CIT-0 (published) to library/citations/CIT-00-published.pdf.",
      "Fetched demo:CIT-0 (preprint) to library/citations/CIT-00-preprint.pdf.",
      "Citations: 1; sources: 2; fetched: 2; verified: 0.",
    ],
  );
  output.mockClear();
  await syncCitations(root);
  assert.deepEqual(output.mock.calls, [["Citations: 1; sources: 2; fetched: 0; verified: 2."]]);
  assert.equal(fetch.mock.calls.length, 2);
  output.mockClear();
  await syncCitations(root, undefined, "preprint");
  assert.deepEqual(output.mock.calls, [["Citations: 1; sources: 1; fetched: 0; verified: 1."]]);
  assert.equal(fetch.mock.calls.length, 2);
  const before = readFileSync(
    required(citationStatus(root)[0], "Expected fixture value: citationStatus(root)[0]").path,
  );
  output.mockClear();
  await fetchCitation(root, "demo:CIT-0", "published");
  assert.deepEqual(output.mock.calls, [["Citations: 1; sources: 1; fetched: 0; verified: 1."]]);
  assert.equal(fetch.mock.calls.length, 2);
  assert.deepEqual(
    readFileSync(required(citationStatus(root)[0], "Expected fixture value: citationStatus(root)[0]").path),
    before,
  );
  assert.ok(citationStatus(root).every((entry) => entry.state === "acquired" && entry.present));
  output.mockClear();
  listCitationStatus(root, { missing: true });
  assert.deepEqual(output.mock.calls, [["No missing citation documents."]]);
});

test("transient acquisition errors leave pending state and original BibTeX provenance untouched", async () => {
  const { root, path, metadata } = fixture();
  const original = "@article{original,\n  title = {Original metadata},\n}\n";
  writeFileSync(join(root, "workbench/citations/CIT-00/upstream.bib"), original);
  Object.assign(metadata, {
    upstream: { file: "upstream.bib", sha256: createHash("sha256").update(original).digest("hex") },
  });
  const before = stringify(metadata);
  writeFileSync(acquisitionPath(path), before);
  vi.stubGlobal("fetch", () => promised(() => new Response("temporary failure", { status: 503 })));
  await assert.rejects(fetchCitation(root, "demo:CIT-0", "published"), /HTTP 503/);
  assert.equal(readFileSync(acquisitionPath(path), "utf8"), before);
  await formatFiles(root, undefined, { all: true, write: true });
  assert.equal(readFileSync(join(root, "workbench/citations/CIT-00/upstream.bib"), "utf8"), original);
  assert.ok(readCitation(path).acquisition.sources.every((source) => source.status === "pending"));
});
