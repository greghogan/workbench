import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeProject } from "../src/initialization.ts";
import { collectionOriginals } from "../src/collection-git.ts";
import { acceptCollectionAdoption } from "../src/initial-collection.ts";
import { reconcileCollection } from "../src/collection-reconcile.ts";
import { readConfig } from "../src/project-configuration.ts";
import { reviewStatus, ReviewSource } from "../src/review-service.ts";
import { git, provider } from "./fixtures/adoption.mts";

const repository = "https://collection-fixture.invalid/workbench.git";
const launcher = resolve(import.meta.dirname, "../bundle/main.cjs");
let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "workbench-initial-collection-")));
  for (const type of ["CONFIG", "DATA", "CACHE", "STATE"]) vi.stubEnv(`WORKBENCH_${type}_HOME`, join(base, type));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});
function distribution(packaged = false) {
  const source = provider(base, "workbench", "1", ["Keep project files authoritative."]);
  writeFileSync(join(source.directory, "Makefile"), "all:\n\t@:\n");
  writeFileSync(join(source.directory, "package.json"), JSON.stringify({ version: "0.1.0", repository }));
  mkdirSync(join(source.directory, "languages"));
  writeFileSync(join(source.directory, "languages/index.toml"), "schema_version = 1\nlanguages = []\n");
  git(source.directory, "add", ".");
  git(source.directory, "commit", "-qm", "Distribution fixture");
  const commit = git(source.directory, "rev-parse", "HEAD");
  const directory = packaged ? join(base, "package") : source.directory;
  if (packaged) {
    cpSync(source.directory, directory, { recursive: true, filter: (path) => path !== join(source.directory, ".git") });
    writeFileSync(
      join(directory, "workbench-source.json"),
      JSON.stringify({ schema_version: 1, repository, revision: commit }),
    );
    const config = join(base, "gitconfig");
    // An installed release fetches its declared upstream; this fixture keeps that real Git exchange local.
    writeFileSync(
      config,
      `[url ${JSON.stringify(source.directory.replaceAll("\\", "/"))}]\n\tinsteadOf = ${repository}\n`,
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  } else {
    writeFileSync(join(source.directory, "workbench/decisions/ADR-00.md"), "Uncommitted policy must not be adopted.\n");
  }
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", directory);
  return { directory, commit };
}
function command(root: string, args: string[]) {
  const result = spawnSync(process.execPath, [launcher, ...args], {
    cwd: base,
    encoding: "utf8",
    env: { ...process.env, WORKBENCH_PROJECT_ROOT: root },
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout;
}
const cli = (root: string, ...args: string[]) => command(root, ["init", root, "--records-only", ...args]);

test("a fresh noninteractive project adopts the default collection without inventing acceptance", () => {
  distribution();
  const root = join(base, "consumer");
  cli(root);
  expect(readConfig(root).collections?.sources?.[0]?.id).toBe("workbench");
  expect(reviewStatus(root, ReviewSource.Working).changes).toContainEqual(
    expect.objectContaining({ path: "workbench/collections/workbench/decisions/ADR-00.md", approved: false }),
  );
});

test.each([false, true])(
  "initialization adopts committed policy by default (installed release: %s)",
  async (packaged) => {
    const source = distribution(packaged),
      root = join(base, "consumer");
    cli(root, "--yes");
    const pin = readConfig(root).collections?.sources?.[0];
    expect(pin).toMatchObject({ id: "workbench", source: repository, commit: source.commit, scopes: ["."] });
    if (!pin) throw new Error("Missing initial collection");
    expect(collectionOriginals(root, pin).manifest.decisions).toEqual(["0"]);
    const path = "workbench/collections/workbench/decisions/ADR-00.md";
    expect(readFileSync(join(root, path), "utf8")).toContain("Keep project files authoritative.");
    expect(readFileSync(join(root, "workbench/CHARTER.md"), "utf8")).toBe("");
    expect(readFileSync(join(root, ".gitmodules"), "utf8")).toContain(repository);
    expect(reviewStatus(root, ReviewSource.Working).changes).toContainEqual(
      expect.objectContaining({ path, approved: true }),
    );
    expect(reviewStatus(root, ReviewSource.Working).changes).toContainEqual(
      expect.objectContaining({ path: "workbench/CHARTER.md", approved: false }),
    );
    expect(git(root, "ls-files", "--stage")).toBe("");
    const adaptation = readFileSync(join(root, path), "utf8") + "\nProject adaptation.\n";
    writeFileSync(join(root, path), adaptation);
    await initializeProject(root, { recordsOnly: true, workbenchCollection: true });
    expect(readFileSync(join(root, path), "utf8")).toBe(adaptation);
    expect(readConfig(root).collections?.sources?.[0]).toEqual(pin);
    expect(reviewStatus(root, ReviewSource.Working).changes).toContainEqual(
      expect.objectContaining({ path, approved: false }),
    );
    expect(() => {
      acceptCollectionAdoption(root, pin);
    }).toThrow(/differs from its pinned original/);
  },
);

test("preview is read-only; declining is preserved until adoption is explicitly requested", async () => {
  distribution();
  const root = join(base, "consumer");
  await initializeProject(root, { recordsOnly: true, plan: true });
  expect(existsSync(root)).toBe(false);
  cli(root, "--no-workbench-collection");
  expect(readConfig(root).collections?.sources).toBeUndefined();
  await initializeProject(root, { recordsOnly: true });
  expect(readConfig(root).collections?.sources).toBeUndefined();
  cli(root, "--workbench-collection");
  expect(readConfig(root).collections?.sources?.[0]?.id).toBe("workbench");
  const missingConfirmation = spawnSync(process.execPath, [launcher, "collection", "accept", "workbench"], {
    cwd: base,
    encoding: "utf8",
    env: { ...process.env, WORKBENCH_PROJECT_ROOT: root },
  });
  expect(missingConfirmation.status).not.toBe(0);
  expect(missingConfirmation.stderr).toContain("interactive terminal or --yes");
  const path = "workbench/collections/workbench/decisions/ADR-00.md";
  expect(reviewStatus(root, ReviewSource.Working).changes).toContainEqual(
    expect.objectContaining({ path, approved: false }),
  );
  command(root, ["collection", "accept", "workbench", "--yes"]);
  expect(reviewStatus(root, ReviewSource.Working).changes).toContainEqual(
    expect.objectContaining({ path, approved: true }),
  );
  const incoming = provider(base, "workbench", "2", ["A newly selected policy requires fresh acceptance."]);
  reconcileCollection(
    root,
    repository,
    { commit: incoming.commit, fetchFrom: incoming.directory, visibility: "public", id: "workbench" },
    "workbench",
  );
  expect(reviewStatus(root, ReviewSource.Working).changes).toContainEqual(
    expect.objectContaining({ path, approved: false }),
  );
});

test("collection install --yes accepts a verified import without staging", () => {
  const source = distribution(),
    root = join(base, "consumer");
  cli(root, "--no-workbench-collection");
  command(root, ["collection", "install", source.directory, "--commit", source.commit, "--yes"]);
  expect(reviewStatus(root, ReviewSource.Working).changes).toContainEqual(
    expect.objectContaining({ path: "workbench/collections/workbench/decisions/ADR-00.md", approved: true }),
  );
  expect(git(root, "ls-files", "--stage")).toBe("");
});

test("namespace conflicts publish nothing, and failed acquisition can be retried without losing user files", async () => {
  const source = distribution(),
    root = join(base, "consumer");
  await expect(initializeProject(root, { id: "workbench", recordsOnly: true })).rejects.toThrow(/namespace/);
  expect(existsSync(root)).toBe(false);
  writeFileSync(
    join(source.directory, "workbench-source.json"),
    JSON.stringify({ schema_version: 1, repository, revision: "1".repeat(40) }),
  );
  await expect(initializeProject(root, { recordsOnly: true })).rejects.toThrow(/adoption failed/);
  expect(readConfig(root).collections?.sources).toBeUndefined();
  const charter = "# Human charter\n\nKeep the user's exact wording.\n";
  writeFileSync(join(root, "workbench/CHARTER.md"), charter);
  rmSync(join(source.directory, "workbench-source.json"));
  await initializeProject(root, { recordsOnly: true, workbenchCollection: true });
  expect(readFileSync(join(root, "workbench/CHARTER.md"), "utf8")).toBe(charter);
  expect(readConfig(root).collections?.sources?.[0]?.commit).toBe(source.commit);
  expect(git(root, "ls-files", "--stage")).toBe("");
});
