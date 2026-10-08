import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { parse, stringify } from "yaml";
import { fetchCitation } from "../src/citations.ts";

const temporary = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test.each(["reordered", "replaced", "unchanged", "title edited"])(
  "acquisition with source %s during download",
  async (change) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-citation-race-"));
    temporary.push(root);
    mkdirSync(join(root, "workbench/citations"), { recursive: true });
    writeFileSync(
      join(root, "workbench/config.toml"),
      'schema_version = 1\n[markdown]\nwrap_width = 120\n[compatibility]\nrequired = false\n[citations]\nlibrary_dir = "library/citations"\n',
    );
    writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid = "demo"\npath = "."\n');
    const path = join(root, "workbench/citations/CIT-00.yaml");
    const source = (kind) => ({
      kind,
      "landing-url": `https://example.invalid/${kind}`,
      "download-url": `https://example.invalid/${kind}.pdf`,
      status: "pending",
    });
    const record = {
      references: [
        {
          id: "demo-CIT-0",
          type: "article-journal",
          title: "Paper",
          author: [{ literal: "Author" }],
          issued: { "date-parts": [[2026]] },
          URL: "https://example.invalid/published",
        },
      ],
      workbench: { sources: [source("published"), source("preprint")] },
    };
    writeFileSync(path, stringify(record));
    const pdf = "%PDF-1.7\nverified source bytes\n";
    let edited;
    vi.stubGlobal("fetch", async () => {
      if (change === "reordered") record.workbench.sources.reverse();
      else if (change === "replaced")
        record.workbench.sources[0]["download-url"] = "https://example.invalid/replacement.pdf";
      else if (change === "title edited") record.references[0].title = "Edited title";
      edited = stringify(record);
      writeFileSync(path, edited);
      return new Response(pdf);
    });
    const destination = join(root, "library/citations/CIT-00-published.pdf");
    if (change === "reordered" || change === "replaced") {
      await assert.rejects(fetchCitation(root, "demo:CIT-0", "published"), /changed during acquisition/);
      assert.equal(readFileSync(path, "utf8"), edited);
      assert.ok(parse(edited).workbench.sources.every((entry) => entry.sha256 === undefined));
      // No orphan PDF can be silently attributed to the replacement source on a later sync.
      assert.equal(existsSync(destination), false);
    } else {
      await fetchCitation(root, "demo:CIT-0", "published");
      assert.equal(readFileSync(destination, "utf8"), pdf);
      const saved = parse(readFileSync(path, "utf8"));
      assert.equal(saved.references[0].title, record.references[0].title);
      assert.deepEqual(saved.workbench.sources[0], {
        ...record.workbench.sources[0],
        status: "acquired",
        sha256: createHash("sha256").update(pdf).digest("hex"),
      });
    }
  },
);
