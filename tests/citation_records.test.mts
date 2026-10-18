import { required } from "../src/invariants.ts";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { stringify } from "yaml";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { acquisitionPath, parseAcquisition, parseCitation, readCitation } from "../src/citation-record.ts";
import { createRecord } from "../src/records.ts";
import { syncCitationStorage } from "../src/projects.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
const reference = {
  id: "demo-CIT-0",
  type: "article-journal",
  title: "Paper",
  author: [{ literal: "Author" }],
  issued: { "date-parts": [[2026]] },
  URL: "https://example.invalid/paper",
};
const source = { kind: "published", "landing-url": reference.URL, status: "pending" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-citation-record-"));
  temporary.push(root);
  mkdirSync(join(root, "workbench/citations/CIT-00"), { recursive: true });
  writeFileSync(
    join(root, "workbench/config.toml"),
    'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[citations]\nlibrary_dir="library/citations"\n',
  );
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
  const path = join(root, "workbench/citations/CIT-00.json");
  writeFileSync(path, JSON.stringify([reference]));
  writeFileSync(acquisitionPath(path), stringify({ sources: [source] }));
  return { root, path };
}

test.each([
  [null, /exactly one/],
  [[], /exactly one/],
  [[null], /object/],
  [[reference, reference], /exactly one/],
  [[{ ...reference, id: 42 }], /'id'/],
  [[{ ...reference, author: [null] }], /'author'/],
  [[{ ...reference, author: [{ given: "Name" }] }], /'author'/],
  [[{ ...reference, issued: { "date-parts": [2026] } }], /date-parts/],
  [[{ ...reference, URL: "http://example.invalid/paper" }], /HTTPS/],
  [[{ ...reference, workbench: {} }], /acquisition.yaml/],
])("bibliographic JSON rejects invalid data %#", (value, diagnostic) => {
  expect(() => parseCitation(JSON.stringify(value), "CIT-00.json")).toThrow(diagnostic);
});

test.each([
  [[], /mapping/],
  [{}, /sources/],
  [{ sources: [] }, /sources/],
  [{ sources: [null] }, /source kinds/],
  [{ sources: [source, source] }, /unique/],
  [{ sources: [{ ...source, kind: "../outside" }] }, /filename-safe/],
  [{ sources: [{ ...source, "download-url": "http://example.invalid/paper.pdf" }] }, /HTTPS/],
  [{ sources: [{ ...source, status: "unknown" }] }, /source status/],
  [{ sources: [{ ...source, status: "acquired" }] }, /requires one/],
  [{ sources: [{ ...source, sha256: "a".repeat(64) }] }, /only an acquired/],
  [{ sources: [{ ...source, sha256: "0".repeat(64) }] }, /all-zero/],
  [{ sources: [{ ...source, reason: "" }] }, /reason/],
  [{ sources: [source], upstream: { file: "../original.bib", sha256: "a".repeat(64) } }, /unsafe relative path/],
  [{ sources: [source], upstream: { file: "acquisition.yaml", sha256: "a".repeat(64) } }, /cannot name/],
])("acquisition YAML rejects invalid data %#", (value, diagnostic) => {
  expect(() => parseAcquisition(stringify(value), "acquisition.yaml")).toThrow(diagnostic);
});

test("missing metadata, missing originals, and mismatched canonical source URLs are diagnosed", () => {
  const { path } = fixture();
  writeFileSync(
    acquisitionPath(path),
    stringify({ sources: [{ ...source, "landing-url": "https://example.invalid/other" }] }),
  );
  expect(() => readCitation(path)).toThrow(/CSL URL must match/);
  writeFileSync(
    acquisitionPath(path),
    stringify({ sources: [source], upstream: { file: "upstream.bib", sha256: "a".repeat(64) } }),
  );
  expect(() => readCitation(path)).toThrow(/missing upstream metadata/);
  rmSync(acquisitionPath(path));
  expect(() => readCitation(path)).toThrow(/acquisition.yaml/);
});

test.skipIf(process.platform === "win32")(
  "linked supporting metadata is rejected without changing external files",
  () => {
    const { root, path } = fixture();
    const outside = join(root, "outside.yaml");
    const bytes = stringify({ sources: [source] });
    writeFileSync(outside, bytes);
    rmSync(acquisitionPath(path));
    symlinkSync(outside, acquisitionPath(path));
    expect(() => readCitation(path)).toThrow(/symlinks are not supported/);
    expect(readFileSync(outside, "utf8")).toBe(bytes);
  },
);

test.each(["record", "acquisition", "upstream"])("nonregular %s files are rejected", (kind) => {
  const { path } = fixture();
  const originalPath = join(path.slice(0, -5), "upstream.json");
  writeFileSync(
    acquisitionPath(path),
    stringify({ sources: [source], upstream: { file: "upstream.json", sha256: "a".repeat(64) } }),
  );
  const target = { record: path, acquisition: acquisitionPath(path), upstream: originalPath }[kind];
  rmSync(required(target, "Fixture value target"), { force: true });
  mkdirSync(required(target, "Fixture target"));
  expect(() => readCitation(path)).toThrow(/expected a regular file/);
});

test("synchronization preserves ignore rules when no citation library is configured", () => {
  const { root } = fixture();
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  writeFileSync(join(root, ".gitignore"), "/keep-local/\n");
  syncCitationStorage(root);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("/keep-local/\n");
});

test.each(["library/citations", "papers [local]"])(
  "cloned projects exclude %s downloads without running Workbench",
  (library) => {
    const { root } = fixture();
    const clone = mkdtempSync(join(tmpdir(), "workbench-citation-clone-"));
    temporary.push(clone);
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
    git("init", "--quiet");
    const config = join(root, "workbench/config.toml");
    writeFileSync(config, readFileSync(config, "utf8").replace("library/citations", library));
    writeFileSync(
      join(root, "workbench/projects.toml"),
      '[[project]]\nid="demo"\npath="."\n[[project]]\nid="api"\npath="nested/api client"\n',
    );
    mkdirSync(join(root, "nested/api client"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "/keep-local/\n");
    syncCitationStorage(root);
    const ignore = readFileSync(join(root, ".gitignore"));
    syncCitationStorage(root);
    expect(readFileSync(join(root, ".gitignore"))).toEqual(ignore);
    git("add", ".gitignore");
    git(
      "-c",
      "user.name=Workbench test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Fixture ignore rules",
    );
    git("clone", "--quiet", "--no-local", "--", root, clone);
    const retained = ["workbench/citations/CIT-00/upstream.bib", `${library}-notes/paper.pdf`];
    for (const path of [
      `${library}/paper.pdf`,
      `nested/api client/${library}/paper.pdf`,
      "keep-local/personal.txt",
      ...retained,
    ]) {
      const destination = join(clone, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, "fixture\n");
    }
    const visible = execFileSync("git", ["-C", clone, "ls-files", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)
      .sort();
    expect(visible).toEqual(retained.sort());
  },
);

test.each([".", "nested/project"])("Git preserves original bytes with autocrlf for scope %s", (scope) => {
  const { root, path } = fixture();
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  git("init", "--quiet");
  git("config", "core.autocrlf", "true");
  const attributes = join(root, ".gitattributes");
  writeFileSync(attributes, "*.md text eol=lf\n");
  syncCitationStorage(root);
  const contents = readFileSync(attributes);
  syncCitationStorage(root);
  expect(readFileSync(attributes)).toEqual(contents);
  expect(contents.toString()).toContain("*.md text eol=lf\n");
  const relative = [scope, "workbench/citations/01/00/CIT-01/upstream.bib"].filter((part) => part !== ".").join("/");
  const originalPath = join(root, relative);
  mkdirSync(dirname(originalPath), { recursive: true });
  const bytes = Buffer.from("@article{test,\r\n  title={Original},\r\n}\r\n");
  writeFileSync(originalPath, bytes);
  git("add", ".gitattributes", relative);
  expect(git("show", `:${relative}`)).toEqual(bytes);
  rmSync(originalPath);
  git("checkout-index", "--", relative);
  expect(readFileSync(originalPath)).toEqual(bytes);
  const upstreamPath = join(path.slice(0, -5), "upstream.bib");
  writeFileSync(upstreamPath, readFileSync(originalPath));
  writeFileSync(
    acquisitionPath(path),
    stringify({
      sources: [source],
      upstream: { file: "upstream.bib", sha256: createHash("sha256").update(bytes).digest("hex") },
    }),
  );
  expect(
    required(readCitation(path).acquisition.upstream, "Expected fixture value: readCitation(path).acquisition.upstream")
      .file,
  ).toBe("upstream.bib");
});

test("supporting-file creation rejects escaping paths and cleans only the supporting files it owns", async () => {
  const { root } = fixture();
  await expect(
    createRecord(root, "CIT", undefined, (number) => ({
      record: JSON.stringify([{ ...reference, id: `demo-CIT-${number}` }]),
      supporting: { "../escape.txt": "unsafe" },
    })),
  ).rejects.toThrow(/unsafe relative path/);
  expect(existsSync(join(root, "workbench/citations/CIT-01.json"))).toBe(false);
  expect(existsSync(join(root, "workbench/citations/CIT-01"))).toBe(false);
  expect(existsSync(join(root, "workbench/citations/escape.txt"))).toBe(false);
  await expect(
    createRecord(root, "CIT", undefined, (number) => {
      const directory = join(root, `workbench/citations/CIT-0${number}`);
      mkdirSync(directory);
      writeFileSync(join(directory, "user.txt"), "keep active work");
      return {
        record: JSON.stringify([{ ...reference, id: `demo-CIT-${number}` }]),
        supporting: { "acquisition.yaml": "sources: []\n" },
      };
    }),
  ).rejects.toThrow(/EEXIST/);
  expect(readFileSync(join(root, "workbench/citations/CIT-02/user.txt"), "utf8")).toBe("keep active work");
  expect(existsSync(join(root, "workbench/citations/CIT-02.json"))).toBe(false);
});
