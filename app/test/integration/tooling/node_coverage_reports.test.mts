import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { collectNodeCoverageBatch, InvalidNodeCoverageReport } from "../../../../scripts/node-coverage-reports.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-node-coverage-"));
  roots.push(root);
  return root;
}

function read(root: string, name: string) {
  return collectNodeCoverageBatch(root, { files: [name], final: true, retire: false }, () => {
    throw new Error("Expected malformed coverage");
  });
}

test.each([
  "",
  '{"private-source": "DO NOT DISCLOSE',
  "{}",
  '{"result": [null]}',
  '{"result": [{"url":"file:///example.mjs","functions":[{"functionName":"DO NOT DISCLOSE","isBlockCoverage":true}]}]}',
])("invalid report diagnostics retain metadata without source contents: %j", (contents) => {
  const root = fixture();
  writeFileSync(join(root, "coverage-123-456-7.json"), contents);
  try {
    read(root, "coverage-123-456-7.json");
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidNodeCoverageReport);
    if (!(error instanceof InvalidNodeCoverageReport)) throw error;
    expect(error.diagnostic).toEqual({
      file: "coverage-123-456-7.json",
      bytes: Buffer.byteLength(contents),
      pid: 123,
      thread: 7,
      reason: contents.endsWith("}") ? "invalid-shape" : "invalid-json",
    });
    expect(error.message).not.toContain("DO NOT DISCLOSE");
    expect(error.cause).toBeUndefined();
  }
});

test("unreadable reports fail with bounded metadata and unknown process identity", () => {
  const root = fixture();
  mkdirSync(join(root, "unreadable.json"));
  // A directory is unreadable as a file on the supported Linux, macOS, and Windows hosts.
  expect(() => read(root, "unreadable.json")).toThrow(/unreadable.json/);
  const missing = join(root, "missing.json");
  symlinkSync(join(root, "does-not-exist"), missing, "file");
  rmSync(join(root, "unreadable.json"), { recursive: true });
  try {
    read(root, "missing.json");
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

test("a single oversized report fails explicitly while coverage is still collecting", () => {
  const root = fixture();
  const name = "coverage-123-456-7.json";
  const path = join(root, name);
  writeFileSync(path, "");
  truncateSync(path, 65 * 1024 ** 2);
  expect(() =>
    collectNodeCoverageBatch(root, { files: [name], final: false, retire: true }, () => {
      throw new Error("The oversized report must never be parsed");
    }),
  ).toThrow(/size-limit/);
});
