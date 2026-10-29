import { beforeEach, expect, test } from "vitest";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { webServers, readWebPage } from "./fixtures/web.mjs";
import { citationPdf } from "../scripts/web-browser-fixtures.mjs";
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
const url = (query = "") => web.url + "/citation-document?id=demo:CIT-0&source=published" + query;
test("citation pages and lists show local presence separately from recorded acquisition", async () => {
  const detail = await readWebPage(web, "/record?id=demo:CIT-0");
  for (const text of [
    "Source documents",
    "File present locally",
    "File missing locally",
    "Acquisition: acquired",
    "Acquisition: pending",
    "View PDF",
    "Download PDF",
  ])
    expect(detail.html).toContain(text);
  expect((await readWebPage(web, "/records?type=CIT")).html).toContain("1/2 PDFs present");
  rmSync(join(root, "library/citations/CIT-00-published.pdf"));
  const missing = await readWebPage(web, "/record?id=demo:CIT-0");
  expect(missing.html).toContain("Acquisition is recorded, but this checkout has no local copy.");
  expect(missing.html).not.toContain(">View PDF<");
  expect((await readWebPage(web, "/records?type=CIT")).html).toContain("No local PDF");
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
  expect((await fetch(web.url + "/citation-document?id=demo:ADR-0&source=published")).status).toBe(404);
  expect((await fetch(web.url + "/citation-document?id=demo:CIT-0&source=../../outside")).status).toBe(404);
  expect((await fetch(url().replace("source=published", "source=arxiv"))).status).toBe(404);
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
  const page = await readWebPage(web, "/record?id=demo:CIT-0");
  expect(page.response.status).toBe(200);
  expect(page.html).toContain("Document status unavailable");
  expect(page.html).toContain("Retained paper");
});
test("external library changes refresh citation presence without acquiring or editing records", async () => {
  const changed = once(web.monitor, "change", { signal: AbortSignal.timeout(5000) });
  writeFileSync(join(root, "library/citations/CIT-00-arxiv.pdf"), pdf);
  await changed;
  const list = await readWebPage(web, "/records?type=CIT");
  expect(list.html).toContain("2/2 PDFs present");
});
