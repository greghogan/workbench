import { reviewStatus, ReviewSource } from "../src/review-service.ts";
import { localCollectionScope, LocalCollectionScope, systemCollectionDirectories } from "../src/collections.ts";
import { afterEach, expect, test, vi } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { webFixture } from "./fixtures/web.mjs";
import { provider, git, distribution } from "./fixtures/adoption.mjs";
import { previewCollection, applyCollection, applyCollectionForReview } from "../src/web/collection-service.ts";
import { workspaceRecords } from "../src/record-service.ts";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
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

test("collection application prepares generated context and validation for unified review without staging", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = webFixture();
  roots.push(root);
  const source = provider(root);
  const request = { source: source.directory, commit: source.commit, collection: ".", visibility: "public" as const };
  const index = git(root, "ls-files", "--stage");
  writeFileSync(
    join(root, "workbench/config.toml"),
    readFileSync(join(root, "workbench/config.toml"), "utf8") + '\n[citations]\nlibrary_dir="library/citations"\n',
  );
  const applied = await applyCollectionForReview(root, request, previewCollection(root, request).digest);
  expect(applied).toEqual({ id: "company", issues: [], omitted: 0 });
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("company:ADR-0");
  expect(readFileSync(join(root, "workbench/decision-map.md"), "utf8")).toContain(
    "collections/company/decision-map.md",
  );
  expect(readFileSync(join(root, "workbench/collections/company/decision-map.md"), "utf8")).toContain("company:ADR-0");
  const protectedFiles = reviewStatus(root, ReviewSource.Working).changes.filter((change) =>
    change.path.startsWith("workbench/collections/company/"),
  );
  expect(protectedFiles.map((change) => change.path)).toContain("workbench/collections/company/decisions/ADR-00.md");
  expect(protectedFiles.every((change) => !change.approved)).toBe(true);
  expect(git(root, "ls-files", "--stage")).toBe(index);
});

test("post-application validation reports issues while preserving the applied collection", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = webFixture();
  roots.push(root);
  const source = provider(root);
  const request = { source: source.directory, commit: source.commit, collection: ".", visibility: "public" as const };
  writeFileSync(join(root, "README.md"), "# Fixture\n\n[Missing document](missing.md)\n");
  const index = git(root, "ls-files", "--stage");
  writeFileSync(
    join(root, "workbench/config.toml"),
    readFileSync(join(root, "workbench/config.toml"), "utf8") + '\n[citations]\nlibrary_dir="library/citations"\n',
  );
  const applied = await applyCollectionForReview(root, request, previewCollection(root, request).digest);
  expect(applied.id).toBe("company");
  expect(applied.issues.join("\n")).toContain("missing.md");
  expect(workspaceRecords(root).some((record) => record.id === "company:ADR-0")).toBe(true);
  expect(git(root, "ls-files", "--stage")).toBe(index);
});

test("local policy installation labels distinguish checkout, user, machine, and custom paths", () => {
  const root = webFixture();
  roots.push(root);
  const user = join(root, ".git", "user-data");
  vi.stubEnv("WORKBENCH_DATA_HOME", user);
  expect(localCollectionScope(root, join(root, "workbench/.local-collections/policy/1"))).toBe(
    LocalCollectionScope.Checkout,
  );
  expect(localCollectionScope(root, join(user, "collections/policy/1"))).toBe(LocalCollectionScope.User);
  for (const system of systemCollectionDirectories())
    expect(localCollectionScope(root, join(system, "policy/1"))).toBe(LocalCollectionScope.System);
  expect(localCollectionScope(root, join(user, "collections-custom/policy/1"))).toBe(LocalCollectionScope.Configured);
});
