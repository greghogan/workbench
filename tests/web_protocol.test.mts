import { afterEach, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decodeCollectionRequest,
  decodeCollectionWorkerRequest,
  decodeCollectionPreview,
} from "../src/web/protocol.ts";
import { runCollectionWorker } from "../src/web/collection-runner.ts";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const request = { source: join(tmpdir(), "provider"), commit: "a".repeat(40), collection: ".", visibility: "public" };
const plan = () => ({
  digest: "b".repeat(64),
  pin: { id: "company", revision: "1", sha256: "c".repeat(64), scopes: ["."], visibility: "public" },
  files: [
    {
      path: "workbench/collections/company/decisions/ADR-00.md",
      before: null,
      after: "# Decision",
      before_sha256: null,
      after_sha256: "d".repeat(64),
    },
  ],
  differences: {},
});

test("collection requests reject malformed and unexpected fields before invoking acquisition", () => {
  expect(decodeCollectionRequest(request)).toEqual(request);
  expect(() => decodeCollectionRequest({ ...request, commit: "main" })).toThrow(/immutable/);
  expect(() => decodeCollectionRequest({ ...request, collection: "../outside" })).toThrow();
  expect(() => decodeCollectionRequest({ ...request, visibility: true })).toThrow(/visibility/);
  expect(() => decodeCollectionRequest({ ...request, id: 5 })).toThrow(/text/);
  expect(() => decodeCollectionRequest({ ...request, unknown: "field" })).toThrow(/unknown/);
  expect(() => decodeCollectionWorkerRequest({ request, expected: "old" })).toThrow(/digest/);
  expect(decodeCollectionWorkerRequest({ request, expected: "e".repeat(64) }).expected).toBe("e".repeat(64));
});
test("collection previews validate file ownership paths, identities, digests, and differences", () => {
  const valid = plan();
  expect(decodeCollectionPreview(valid)).toEqual(valid);
  expect(() => decodeCollectionPreview({ ...valid, pin: { ...valid.pin, id: "INVALID" } })).toThrow(/identity/);
  expect(() => decodeCollectionPreview({ ...valid, files: [{ ...valid.files[0], path: "../outside" }] })).toThrow();
  expect(() => decodeCollectionPreview({ ...valid, files: [...valid.files, ...valid.files] })).toThrow(/repeated/);
  expect(() => decodeCollectionPreview({ ...valid, files: [{ ...valid.files[0], after: 42 }] })).toThrow(/contents/);
  expect(() => decodeCollectionPreview({ ...valid, differences: { outside: "unowned" } })).toThrow(/unknown/);
});
function worker(code: string) {
  const root = mkdtempSync(join(tmpdir(), "workbench-worker-protocol-"));
  roots.push(root);
  mkdirSync(join(root, "languages"));
  writeFileSync(join(root, "languages/index.toml"), "");
  mkdirSync(join(root, "bundle"));
  writeFileSync(join(root, "bundle/main.cjs"), `process.stdin.resume();process.stdin.on('end',()=>{${code}});`);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", root);
  return root;
}
test("a malformed successful worker response cannot become an actionable preview", async () => {
  const root = worker('console.log(JSON.stringify({digest:"not-a-plan"}));');
  await expect(runCollectionWorker(root, "preview", decodeCollectionRequest(request), undefined)).rejects.toThrow(
    /preview/,
  );
});
test("worker failure diagnostics retain process status and bounded service output", async () => {
  const root = worker('console.error("retained worker cause");process.exitCode=7;');
  await expect(runCollectionWorker(root, "preview", decodeCollectionRequest(request), undefined)).rejects.toThrow(
    /pid=\d+, status=7, signal=null\)\nretained worker cause/,
  );
});
