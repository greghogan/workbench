import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { imageCatalog, recordImage } from "../src/image-catalog.ts";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("catalogs retain rebuilds and publication history while coalescing repeated observations", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-image-catalog-"));
  roots.push(root);
  const manifest = { builder: "native", platform: "linux-x64", files: [["pin", "a".repeat(64), 0]] };
  const entry = {
    inputs: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    manifest,
    image: `sha256:${"b".repeat(64)}`,
    reference: "ghcr.io/example/project:inputs",
    verified: "2026-10-13T00:00:00Z",
  };
  expect(imageCatalog(root).images).toEqual([]);
  await recordImage(root, entry);
  await recordImage(root, { ...entry, verified: "2026-10-13T00:01:00Z" });
  await recordImage(root, { ...entry, image: `sha256:${"c".repeat(64)}` });
  await recordImage(root, {
    ...entry,
    published: `ghcr.io/example/project@sha256:${"d".repeat(64)}`,
    publishedAt: "2026-10-13T00:02:00Z",
  });
  expect(imageCatalog(root).images).toHaveLength(3);
  expect(imageCatalog(root).images[0]).toEqual(entry);
  await expect(recordImage(root, { ...entry, manifest: { different: true } })).rejects.toThrow(/digest/);
  expect(imageCatalog(root).images).toHaveLength(3);
  writeFileSync(join(root, "workbench/image-catalog.json"), '{"version":99,"images":[]}');
  await expect(recordImage(root, entry)).rejects.toThrow(/Invalid image catalog/);
});
