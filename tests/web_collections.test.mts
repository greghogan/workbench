import { afterEach, expect, test } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { webFixture } from "./fixtures/web.mjs";
import { provider, git } from "./fixtures/adoption.mjs";
import { previewCollection, applyCollection } from "../src/web/collection-service.ts";
import { workspaceRecords } from "../src/record-service.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("collection previews preserve project files and bind application to exact reconciliation inputs", () => {
  const root = webFixture();
  roots.push(root);
  const source = provider(root);
  const request = { source: source.directory, commit: source.commit, collection: ".", visibility: "public" as const };
  const config = readFileSync(join(root, "workbench/config.toml"), "utf8"),
    index = git(root, "ls-files", "--stage");
  const plan = previewCollection(root, request);
  expect(plan.pin.id).toBe("company");
  expect(plan.files.some((file) => file.path.endsWith("ADR-00.md"))).toBe(true);
  expect(existsSync(join(root, "workbench/collections/company"))).toBe(false);
  expect(existsSync(join(root, ".gitmodules"))).toBe(false);
  expect(readFileSync(join(root, "workbench/config.toml"), "utf8")).toBe(config);
  expect(git(root, "ls-files", "--stage")).toBe(index);
  writeFileSync(join(root, "workbench/config.toml"), config + "\n# Concurrent configuration note\n");
  expect(() => {
    applyCollection(root, request, plan.digest);
  }).toThrow(/proposal changed/);
  expect(existsSync(join(root, "workbench/collections/company"))).toBe(false);
  const fresh = previewCollection(root, request);
  applyCollection(root, request, fresh.digest);
  expect(workspaceRecords(root).find((record) => record.id === "company:ADR-0")?.editable).toBe(true);
  expect(readFileSync(join(root, "workbench/config.toml"), "utf8")).toContain("# Concurrent configuration note");
  expect(git(root, "ls-files", "--stage")).toBe(index);
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="company"\npath="."\n');
  expect(() => {
    workspaceRecords(root);
  }).toThrow(/namespace collision/);
});
