import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareWorkbenchPackage } from "../src/package.ts";
import { distributionManifestFile, readDistributionManifest } from "../src/distribution-source-manifest.ts";

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
  expect(readDistributionManifest(candidate.directory)).toEqual({
    contents,
    sha256: createHash("sha256").update(contents).digest("hex"),
  });
  const runtime = JSON.parse(readFileSync(join(candidate.directory, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  expect(runtime.scripts).toBeUndefined();
  expect(runtime.devDependencies).toBeUndefined();
});
test.each(["malformed", "array", "oversized"])("%s manifests are rejected", (kind) => {
  const root = fixture();
  writeFileSync(
    join(root, distributionManifestFile),
    kind === "malformed" ? "{" : kind === "array" ? "[]" : " ".repeat(1024 * 1024 + 1),
  );
  expect(() => readDistributionManifest(root)).toThrow();
});
