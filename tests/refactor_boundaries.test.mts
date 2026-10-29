import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { readBoundedFile, readFilePrefix } from "../src/file-reads.ts";
import { publishFile, writeNew } from "../scripts/file-publication.mjs";
import { readReviewReceipt } from "../src/review-service.ts";
import { metadataBytes } from "../scripts/metadata-http.mjs";
import { testFailureSummary } from "../scripts/test-failures.mjs";
import { admittedWork } from "../scripts/work-admission.mjs";
import { materializeDistribution } from "../src/runtime-distribution.ts";
import { cacheAmount, discoverCacheSizes } from "../src/cache-size.ts";
import { totalBytes } from "../src/byte-size.ts";
import { cacheDeletionIdentity } from "../src/cache-plan-identity.ts";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-boundaries-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("bounded descriptor reads reject oversized, nonregular, and symlink inputs", () => {
  const root = fixture(),
    file = join(root, "record");
  writeFileSync(file, "complete");
  expect(readBoundedFile(file, 8).toString()).toBe("complete");
  expect(readFilePrefix(file, 4).toString()).toBe("comp");
  expect(readFilePrefix(file, 0)).toEqual(Buffer.alloc(0));
  expect(readFilePrefix(file, 20).toString()).toBe("complete");
  expect(() => readBoundedFile(file, 7)).toThrow("oversized");
  expect(() => readBoundedFile(root, 4096)).toThrow();
  expect(() => readFilePrefix(root, 4)).toThrow();
  expect(() => readFilePrefix(file, -1)).toThrow("Invalid file byte limit");
  if (process.platform !== "win32") {
    symlinkSync(file, join(root, "alias"));
    expect(() => readBoundedFile(join(root, "alias"), 8)).toThrow();
    expect(() => readFilePrefix(join(root, "alias"), 4)).toThrow();
  }
});
test("publication rejects stale contents and never overwrites a newly created file", () => {
  const root = fixture(),
    file = join(root, "record");
  writeNew(file, "first");
  expect(() => {
    writeNew(file, "second");
  }).toThrow();
  expect(() => {
    publishFile(file, "second", Buffer.from("stale"));
  }).toThrow("changed before replacement");
  expect(readFileSync(file, "utf8")).toBe("first");
  publishFile(file, "second", Buffer.from("first"));
  expect(readFileSync(file, "utf8")).toBe("second");
});
test("review state distinguishes missing and malformed receipts", () => {
  const file = join(fixture(), "review.json");
  expect(readReviewReceipt(file).state).toBe("missing");
  writeFileSync(file, "{}");
  const receipt = readReviewReceipt(file);
  expect(receipt.state).toBe("invalid");
  if (receipt.state === "invalid") expect(receipt.problem).toBeInstanceOf(Error);
});
test("metadata streams enforce bounds and cancel their reader", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("too large"));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await expect(metadataBytes(response, 3, "Fixture")).rejects.toThrow("exceeds");
  expect(cancelled).toBe(true);
  expect((await metadataBytes(new Response("okay"), 4, "Fixture")).toString()).toBe("okay");
});
test("failure summaries retain failed assertions and bound the remaining cases", () => {
  const assertion = {
    status: "failed",
    fullName: "recognizable failing case",
    failureMessages: ["Expected 0 but received null\nretained assertion"],
  };
  const text = testFailureSummary({ testResults: [{ assertionResults: Array.from({ length: 8 }, () => assertion) }] });
  expect(text).toContain("recognizable failing case: Expected 0 but received null retained assertion");
  expect(text).toContain("2 additional failed tests");
  expect(text.length).toBeLessThan(4000);
});
test("capacity is released after cancellation and preserves work and cleanup errors", async () => {
  const controller = new AbortController(),
    primary = new Error("operation failed"),
    cleanup = new Error("release failed");
  let released = 0;
  const admission = {
    acquire: () =>
      Promise.resolve({
        release: () => {
          released++;
          throw cleanup;
        },
      }),
  };
  await expect(admittedWork(admission, undefined, () => Promise.reject(primary))).rejects.toMatchObject({
    cause: primary,
    errors: [primary, cleanup],
  });
  expect(released).toBe(1);
  const cancelDuringAcquire = {
    acquire: () => {
      controller.abort();
      return Promise.resolve({
        release: () => {
          released++;
        },
      });
    },
  };
  let ran = false;
  await expect(
    admittedWork(cancelDuringAcquire, controller.signal, () => {
      ran = true;
      return Promise.resolve();
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(ran).toBe(false);
  expect(released).toBe(2);
});
test("rehearsal distribution includes the demo and isolates writable copies", () => {
  const source = fixture(),
    project = fixture(),
    destination = fixture();
  mkdirSync(join(destination, ".git"));
  mkdirSync(join(source, "demo"));
  mkdirSync(join(source, "src"));
  mkdirSync(join(source, "src/node_modules"));
  writeFileSync(join(source, "package.json"), JSON.stringify({ files: ["demo", "src"] }));
  writeFileSync(join(source, "demo/fixture"), "original");
  writeFileSync(join(source, "src/node_modules/unwanted"), "excluded");
  const copy = materializeDistribution(project, destination, source);
  expect(readFileSync(join(copy, "demo/fixture"), "utf8")).toBe("original");
  expect(existsSync(join(copy, "src/node_modules"))).toBe(false);
  writeFileSync(join(copy, "demo/fixture"), "changed");
  expect(readFileSync(join(source, "demo/fixture"), "utf8")).toBe("original");
});
test("unknown cache measurements remain unknown and measurement publication preserves deletion identity", () => {
  const root = fixture();
  writeFileSync(join(root, "asset"), "payload");
  const result = discoverCacheSizes(() => cacheAmount(root));
  expect(result.value.bytes).toBeUndefined();
  expect(result.value.measurement.state).toBe("pending");
  expect(totalBytes([2, result.value.bytes])).toBeUndefined();
  expect(totalBytes([])).toBe(0);
  const before = cacheDeletionIdentity(root);
  writeFileSync(join(root, ".workbench-cache-size.json"), "measurement only");
  expect(cacheDeletionIdentity(root)).toEqual(before);
});

test("policy provenance and reconciliation files reject malformed data before field access", async () => {
  const { readDraftProvenance, readLocalReconciliation, readProjectReconciliation } =
    await import("../src/policy-state.ts");
  const file = join(fixture(), "state.json"),
    pin = { id: "fixture", revision: "1", sha256: "f".repeat(64), visibility: "private", scopes: ["."] };
  writeFileSync(file, JSON.stringify({ source: "/fixture", pin }));
  expect(readDraftProvenance(file, "fixture").pin).toEqual(pin);
  expect(() => readDraftProvenance(file, "another")).toThrow("provenance");
  writeFileSync(file, "null");
  expect(() => readDraftProvenance(file, "fixture")).toThrow();
  writeFileSync(file, JSON.stringify({ before: null, after: pin.sha256, local: pin.sha256 }));
  expect(readLocalReconciliation(file).before).toBeNull();
  writeFileSync(file, JSON.stringify({ after: pin, project_sha256: pin.sha256 }));
  expect(readProjectReconciliation(file).after).toEqual(pin);
  writeFileSync(file, JSON.stringify({ after: null, project_sha256: pin.sha256 }));
  expect(() => readProjectReconciliation(file)).toThrow();
});
