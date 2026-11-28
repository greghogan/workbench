import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareWorkbenchPackage } from "../../../src/core/artifacts/package.ts";
import { readReleaseChecksum, stageReleaseArchive } from "../../../src/core/distribution/release-archive.ts";
import {
  distributionManifestFile,
  readDistributionManifest,
} from "../../../src/core/distribution/distribution-source-manifest.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-source-manifest-"));
  roots.push(root);
  return root;
}
test("a prepared candidate retains its original manifest independently of subsequent checkout edits", async () => {
  const root = fixture();
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/cli.mjs"), "console.log('prebuilt');\n");
  const contents =
    JSON.stringify(
      {
        name: "fixture",
        version: "1.0.0",
        files: ["bin"],
        scripts: { prepare: "must not run" },
        devDependencies: { fixture: "1.0.0" },
      },
      null,
      2,
    ) + "\n";
  writeFileSync(join(root, "package.json"), contents);
  const candidate = await prepareWorkbenchPackage(root, { output: join(root, "dist") });
  writeFileSync(join(root, "package.json"), "a different checkout manifest");
  const sha256 = readReleaseChecksum(dirname(candidate.archive));
  const staged = await stageReleaseArchive(candidate.archive, sha256, fixture());
  expect(staged.manifest).toEqual({
    contents,
    sha256: createHash("sha256").update(contents).digest("hex"),
  });
  const runtime = JSON.parse(readFileSync(join(staged.directory, "package.json"), "utf8")) as Record<string, unknown>;
  expect(runtime.scripts).toBeUndefined();
  expect(runtime.devDependencies).toBeUndefined();
  const rejected = fixture();
  writeFileSync(candidate.archive, "archive changed after the checksum was selected");
  await expect(stageReleaseArchive(candidate.archive, sha256, rejected)).rejects.toThrow(/checksum mismatch/);
  expect(readdirSync(rejected)).toEqual([]);
  expect(readDistributionManifest(staged.directory)).toEqual(staged.manifest);
});
test.each(["malformed", "array", "oversized"])("%s manifests are rejected", (kind) => {
  const root = fixture();
  writeFileSync(
    join(root, distributionManifestFile),
    kind === "malformed" ? "{" : kind === "array" ? "[]" : " ".repeat(1024 * 1024 + 1),
  );
  expect(() => readDistributionManifest(root)).toThrow();
});
