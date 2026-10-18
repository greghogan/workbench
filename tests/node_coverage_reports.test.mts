import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { InvalidNodeCoverageReport, readNodeCoverageReports } from "../scripts/node-coverage-reports.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-node-coverage-"));
  roots.push(root);
  return root;
}

test("report acquisition validates data and ignores unrelated files", () => {
  const root = fixture();
  const report = { result: [{ url: "file:///project/helper.mjs", functions: [] }] };
  writeFileSync(join(root, "coverage-123-456-0.json"), JSON.stringify(report));
  writeFileSync(join(root, "notes.txt"), "not coverage");
  expect([...readNodeCoverageReports(root)]).toEqual([report]);
});

test.each(["", '{"private-source": "DO NOT DISCLOSE', "{}", '{"result": [null]}'])(
  "invalid report diagnostics retain metadata without source contents: %j",
  (contents) => {
    const root = fixture();
    writeFileSync(join(root, "coverage-123-456-7.json"), contents);
    try {
      Array.from(readNodeCoverageReports(root));
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidNodeCoverageReport);
      if (!(error instanceof InvalidNodeCoverageReport)) throw error;
      expect(error.diagnostic).toEqual({
        file: "coverage-123-456-7.json",
        bytes: Buffer.byteLength(contents),
        pid: 123,
        thread: 7,
        reason: contents === "{}" || contents.includes("[null]") ? "invalid-shape" : "invalid-json",
      });
      expect(error.message).not.toContain("DO NOT DISCLOSE");
      expect(error.cause).toBeUndefined();
    }
  },
);

test("unreadable reports fail with bounded metadata and unknown process identity", () => {
  const root = fixture();
  mkdirSync(join(root, "unreadable.json"));
  // A directory is unreadable as a file on the supported Linux, macOS, and Windows hosts.
  expect(() => [...readNodeCoverageReports(root)]).toThrow(/unreadable.json/);
  const missing = join(root, "missing.json");
  symlinkSync(join(root, "does-not-exist"), missing, "file");
  rmSync(join(root, "unreadable.json"), { recursive: true });
  try {
    Array.from(readNodeCoverageReports(root));
    throw new Error("expected rejection");
  } catch (error) {
    if (!(error instanceof InvalidNodeCoverageReport)) throw error;
    expect(error.diagnostic).toEqual({
      file: "missing.json",
      bytes: null,
      pid: null,
      thread: null,
      reason: "read-failed",
    });
  }
});
