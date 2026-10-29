import { brotliCompressSync } from "node:zlib";
import { beforeEach, expect, test, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { webServers, readWebPage } from "./fixtures/web.mjs";
import { citationHtml, citationImage, citationPdf } from "../scripts/web-browser-fixtures.mjs";
import { captureCitationHtml } from "../src/citation-html.ts";
import { parseDOM } from "./fixtures/dom.mjs";
const servers = webServers();
let root: string, web: Awaited<ReturnType<typeof servers.start>>;
const pdf = citationPdf();
const digest = createHash("sha256").update(pdf).digest("hex");
beforeEach(async () => {
  root = servers.project();
  appendFileSync(join(root, "workbench/config.toml"), '\n[citations]\nlibrary_dir="library/citations"\n');
  mkdirSync(join(root, "workbench/citations/CIT-00"), { recursive: true });
  writeFileSync(
    join(root, "workbench/citations/CIT-00.json"),
    JSON.stringify([
      {
        id: "demo-CIT-0",
        type: "article-journal",
        title: "Retained paper",
        author: [{ family: "Author" }],
        issued: { "date-parts": [[2026]] },
        URL: "https://example.invalid/paper",
      },
    ]),
  );
  writeFileSync(
    join(root, "workbench/citations/CIT-00/acquisition.yaml"),
    `sources:\n  - kind: published\n    status: acquired\n    landing-url: https://example.invalid/paper\n    sha256: ${digest}\n  - kind: arxiv\n    status: pending\n    landing-url: https://example.invalid/preprint\n`,
  );
  mkdirSync(join(root, "library/citations"), { recursive: true });
  writeFileSync(join(root, "library/citations/CIT-00-published.pdf"), pdf);
  web = await servers.start(root);
});
const url = (query = "") => web.url + "/records/demo:CIT-0/document?source=published" + query;
test("citation pages and lists show local presence separately from recorded acquisition", async () => {
  const detail = await readWebPage(web, "/records/demo:CIT-0");
  for (const text of [
    "Source documents",
    "File present locally",
    "File missing locally",
    "Acquisition: acquired",
    "Acquisition: pending",
    "Read",
    "Download",
  ])
    expect(detail.html).toContain(text);
  const document = parseDOM(detail.html).window.document;
  expect(
    [...document.querySelectorAll(".citation-source")].map((section) => [
      section.querySelector("h3")?.textContent,
      ...[...section.querySelectorAll(".actions a")].map((link) => link.textContent),
    ]),
  ).toEqual([
    ["published", "Read", "Download", "Source"],
    ["arXiv", "Source"],
  ]);
  for (const link of document.querySelectorAll(".citation-source .actions a:last-child"))
    expect(link.classList.contains("button")).toBe(true);
  expect((await readWebPage(web, "/records?type=CIT")).html).toContain("1/2 documents present");
  rmSync(join(root, "library/citations/CIT-00-published.pdf"));
  const missing = await readWebPage(web, "/records/demo:CIT-0");
  expect(missing.html).toContain("Acquisition is recorded, but this checkout has no local copy.");
  const absent = parseDOM(missing.html).window.document;
  expect(
    [...absent.querySelectorAll(".citation-source .actions")].map((actions) =>
      [...actions.querySelectorAll("a")].map((link) => link.textContent),
    ),
  ).toEqual([["Source"], ["Source"]]);
  expect((await readWebPage(web, "/records?type=CIT")).html).toContain("No local document");
});
test("PDF views, downloads, HEAD, and byte ranges use verified source-specific files", async () => {
  const response = await fetch(url());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(response.headers.get("content-disposition")).toContain("inline");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(pdf);
  const download = await fetch(url("&download=1"));
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(Buffer.from(await download.arrayBuffer())).toEqual(pdf);
  const head = await fetch(url(), { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(pdf.length));
  expect((await head.arrayBuffer()).byteLength).toBe(0);
  const range = await fetch(url(), { headers: { Range: "bytes=0-4" } });
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe(`bytes 0-4/${String(pdf.length)}`);
  expect(await range.text()).toBe("%PDF-");
  const suffix = await fetch(url(), { headers: { Range: "bytes=-6" } });
  expect(suffix.status).toBe(206);
  expect(Buffer.from(await suffix.arrayBuffer())).toEqual(pdf.subarray(-6));
  expect((await fetch(url(), { headers: { Range: "bytes=99999-" } })).status).toBe(416);
  expect((await fetch(url(), { headers: { Range: "bytes=0-1,3-4" } })).status).toBe(416);
});
test("missing sources and altered bytes cannot expose arbitrary or mismatched files", async () => {
  expect((await fetch(web.url + "/records/demo:ADR-0/document?source=published")).status).toBe(404);
  expect((await fetch(web.url + "/records/demo:CIT-0/document?source=../../outside")).status).toBe(404);
  const missing = await fetch(url().replace("source=published", "source=arxiv"), { redirect: "manual" });
  expect(missing.status).toBe(302);
  expect(missing.headers.get("location")).toBe("https://example.invalid/preprint");
  expect((await fetch(url())).status).toBe(200);
  writeFileSync(join(root, "library/citations/CIT-00-published.pdf"), "%PDF-1.7\nChanged PDF bytes.\n");
  const changed = await fetch(url());
  expect(changed.status).toBe(409);
  expect(await changed.text()).toContain("SHA-256 differs");
});
test.skipIf(process.platform === "win32")("symlinked citation PDFs cannot expose other files", async () => {
  rmSync(join(root, "library/citations/CIT-00-published.pdf"));
  symlinkSync(join(root, "workbench/CHARTER.md"), join(root, "library/citations/CIT-00-published.pdf"));
  expect((await fetch(url())).status).toBe(400);
});
test("incomplete acquisition metadata remains visible without breaking citation browsing", async () => {
  writeFileSync(join(root, "workbench/citations/CIT-00/acquisition.yaml"), "sources: invalid\n");
  const page = await readWebPage(web, "/records/demo:CIT-0");
  expect(page.response.status).toBe(200);
  expect(page.html).toContain("Document status unavailable");
  expect(page.html).toContain("Retained paper");
});
test("external library changes refresh citation presence without acquiring or editing records", async () => {
  const changed = once(web.monitor, "change", { signal: AbortSignal.timeout(5000) });
  writeFileSync(join(root, "library/citations/CIT-00-arxiv.pdf"), pdf);
  await changed;
  const list = await readWebPage(web, "/records?type=CIT");
  expect(list.html).toContain("2/2 documents present");
});

test("one document URL serves retained HTML, exports a standalone file, and follows the source when missing", async () => {
  const captured = await captureCitationHtml(Buffer.from(citationHtml()), "https://example.invalid/article", () =>
    Promise.resolve(citationImage),
  );
  const metadata = join(root, "workbench/citations/CIT-00/acquisition.yaml");
  appendFileSync(
    metadata,
    `  - kind: web\n    format: html\n    status: acquired\n    landing-url: https://example.invalid/article\n    sha256: ${createHash("sha256").update(citationHtml()).digest("hex")}\n    extracted-sha256: ${createHash("sha256").update(captured).digest("hex")}\n`,
  );
  const path = join(root, "library/citations/CIT-00-web.html.br");
  writeFileSync(path, captured);
  writeFileSync(join(root, "library/citations/CIT-00-web.original.html.br"), brotliCompressSync(citationHtml()));
  const documentURL = url().replace("source=published", "source=web");
  const response = await fetch(documentURL, { headers: { "Accept-Encoding": "identity" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("content-encoding")).toBeNull();
  expect(response.headers.get("content-security-policy")).toContain("sandbox;");
  expect(response.headers.get("content-security-policy")).toContain("img-src data:");
  expect(response.headers.get("accept-ranges")).toBeNull();
  const html = await response.text();
  expect(html).toContain("Retained citation source");
  expect(html).toContain("data:image/png;base64,");
  const compressed = await fetch(documentURL, { method: "HEAD", headers: { "Accept-Encoding": "br" } });
  expect(compressed.headers.get("content-encoding")).toBe("br");
  expect(compressed.headers.get("content-length")).toBe(String(captured.length));
  expect(await compressed.text()).toBe("");
  const refused = await fetch(documentURL, { headers: { "Accept-Encoding": "br;q=0, *;q=1" } });
  expect(refused.headers.get("content-encoding")).toBeNull();
  await refused.arrayBuffer();
  const unavailable = await fetch(documentURL, { headers: { "Accept-Encoding": "*;q=0" } });
  expect(unavailable.status).toBe(406);
  await unavailable.arrayBuffer();
  const preferred = await fetch(documentURL, { headers: { "Accept-Encoding": "br;q=0.5, identity;q=1" } });
  expect(preferred.headers.get("content-encoding")).toBeNull();
  expect(await preferred.text()).toBe(html);
  const download = await fetch(documentURL + "&download=1", { headers: { "Accept-Encoding": "br" } });
  expect(download.headers.get("content-disposition")).toContain("CIT-00-web.html");
  expect(download.headers.get("content-encoding")).toBeNull();
  expect(await download.text()).toBe(html);
  const original = readFileSync(metadata);
  writeFileSync(path, "changed");
  expect((await fetch(documentURL)).status).toBe(409);
  rmSync(path);
  const absent = await fetch(documentURL, { redirect: "manual" });
  expect(absent.status).toBe(302);
  expect(absent.headers.get("location")).toBe("https://example.invalid/article");
  expect(readFileSync(metadata)).toEqual(original);
});

test("original source viewing blocks automatic connections, preserves explicit links, and exports exact acquired bytes", async () => {
  const original = citationHtml();
  const captured = await captureCitationHtml(Buffer.from(original), "https://example.invalid/article", () =>
    Promise.resolve(citationImage),
  );
  appendFileSync(
    join(root, "workbench/citations/CIT-00/acquisition.yaml"),
    `  - kind: web\n    format: html\n    status: acquired\n    landing-url: https://example.invalid/article\n    sha256: ${createHash("sha256").update(original).digest("hex")}\n    extracted-sha256: ${createHash("sha256").update(captured).digest("hex")}\n`,
  );
  writeFileSync(join(root, "library/citations/CIT-00-web.html.br"), captured);
  const originalPath = join(root, "library/citations/CIT-00-web.original.html.br");
  writeFileSync(originalPath, brotliCompressSync(original));
  const document = url().replace("/document?", "/original?").replace("source=published", "source=web");
  const wrapper = await fetch(document);
  const view = parseDOM(await wrapper.text()).window.document;
  const frame = view.querySelector("iframe");
  expect(frame?.getAttribute("sandbox")).not.toContain("allow-scripts");
  expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
  const contentUrl = new URL(frame?.getAttribute("src") ?? "", document);
  const response = await fetch(contentUrl);
  expect(response.headers.get("content-security-policy")).toContain("img-src data:;");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-dns-prefetch-control")).toBe("off");
  const source = parseDOM(await response.text()).window.document;
  expect(source.documentElement.lang).toBe("en");
  expect(source.body.textContent).toContain("Unrelated site navigation");
  expect(source.querySelector("script,iframe,form,[onclick],[onerror]")).toBeNull();
  expect(source.querySelector('a[href="https://example.invalid/details"]')?.getAttribute("rel")).toContain(
    "noreferrer",
  );
  const enabled = await fetch(new URL(contentUrl.href.replace("images=0", "images=1")));
  expect(enabled.headers.get("content-security-policy")).toContain("img-src data: https:;");
  const download = await fetch(document + "&download=1");
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(Buffer.from(await download.arrayBuffer())).toEqual(Buffer.from(original));
  appendFileSync(
    join(root, "workbench/citations/CIT-00/acquisition.yaml"),
    "    document-url: https://mirror.example.invalid/article\n",
  );
  const rebased = await fetch(contentUrl);
  expect(rebased.headers.get("etag")).not.toBe(response.headers.get("etag"));
  expect(await rebased.text()).toContain("https://mirror.example.invalid/details");
  await readWebPage(web, "/records/demo:CIT-0");
  writeFileSync(originalPath, brotliCompressSync("Changed source"));
  expect((await fetch(contentUrl)).status).toBe(409);
  rmSync(originalPath);
  expect((await fetch(contentUrl, { redirect: "manual" })).status).toBe(404);
});

test("original-only file changes refresh its availability without changing the metadata or reader", async () => {
  const original = citationHtml(),
    captured = await captureCitationHtml(Buffer.from(original), "https://example.invalid/article", () =>
      Promise.resolve(citationImage),
    );
  const metadata = join(root, "workbench/citations/CIT-00/acquisition.yaml");
  appendFileSync(
    metadata,
    `  - kind: web\n    format: html\n    status: acquired\n    landing-url: https://example.invalid/article\n    sha256: ${createHash("sha256").update(original).digest("hex")}\n    extracted-sha256: ${createHash("sha256").update(captured).digest("hex")}\n`,
  );
  const reader = join(root, "library/citations/CIT-00-web.html.br"),
    raw = join(root, "library/citations/CIT-00-web.original.html.br");
  writeFileSync(reader, captured);
  writeFileSync(raw, brotliCompressSync(original));
  const before = parseDOM((await readWebPage(web, "/records/demo:CIT-0")).html).window.document;
  expect([...before.querySelectorAll("a")].some((link) => link.textContent === "Original")).toBe(true);
  const untouched = readFileSync(metadata);
  const changed = once(web.monitor, "change", { signal: AbortSignal.timeout(5000) });
  rmSync(raw);
  await changed;
  const after = parseDOM((await readWebPage(web, "/records/demo:CIT-0")).html).window.document;
  expect([...after.querySelectorAll("a")].some((link) => link.textContent === "Original")).toBe(false);
  expect(readFileSync(metadata)).toEqual(untouched);
  expect(readFileSync(reader)).toEqual(captured);
});

test("known citation reads bypass unrelated refreshes but changed acquisition metadata requires reconciliation", async () => {
  const { citationInputsCurrent } = await import("../src/web/citation-freshness.ts");
  expect(citationInputsCurrent(web.monitor.index, "demo:CIT-0")).toBe(true);
  const reconcile = vi.spyOn(web.monitor, "reconcile");
  reconcile.mockImplementation(() => Promise.reject(new Error("Unrelated refresh unavailable")));
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# ADR-0: Unrelated edit\n");
  const response = await fetch(url());
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(pdf);
  expect(reconcile).not.toHaveBeenCalled();
  appendFileSync(join(root, "workbench/citations/CIT-00/acquisition.yaml"), "\n# Acquisition changed\n");
  expect(citationInputsCurrent(web.monitor.index, "demo:CIT-0")).toBe(false);
  reconcile.mockRestore();
  expect((await fetch(url())).status).toBe(200);
});
