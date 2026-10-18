import { required } from "../src/invariants.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeCollectionManifest } from "../src/collections.ts";
import { collectionChanges, reconcileCollection } from "../src/collection-reconcile.ts";
import { collectionDecisionMap, compareCollection } from "../src/collection-commands.ts";
import { synchronize } from "../src/sync.ts";
import { readConfig } from "../src/core.ts";
import { setConfiguration } from "../src/config-command.ts";
import { provider, git } from "./fixtures/adoption.mjs";
import { collectionFixture, adopt, working, original, options } from "./fixtures/collection-scenarios.mjs";

const { fixture } = collectionFixture();

test("updates reconcile independent text changes and advance originals without losing adaptations", async () => {
  const root = await fixture();
  const source = provider(root, "company", "1", ["First rule.\n\nMiddle rule.\n\nLast rule."]);
  adopt(root, source);
  adopt(root, provider(root, "other", "1", ["Independent other policy."]));
  const configPath = join(root, "workbench/config.toml");
  const commentedConfig = readFileSync(configPath, "utf8")
    .replaceAll("[[collections.sources]]", "# Explain the following collection\n[[collections.sources]]")
    .replace('revision = "1"', 'revision = "1" # retained collection rationale');
  writeFileSync(configPath, "# project configuration rationale\n" + commentedConfig);
  writeFileSync(working(root), readFileSync(working(root), "utf8").replace("First rule.", "Project first rule."));
  const next = provider(root, "company", "2", ["First rule.\n\nMiddle rule.\n\nUpdated last rule."]);
  reconcileCollection(root, next.directory, options(next), "company");
  expect(readFileSync(configPath, "utf8")).toContain("# project configuration rationale");
  expect(readFileSync(configPath, "utf8")).toContain('revision = "2" # retained collection rationale');
  expect(readConfig(root).collections?.sources?.map((entry) => entry.id)).toEqual(["company", "other"]);
  const otherBefore = commentedConfig.slice(commentedConfig.lastIndexOf("# Explain the following collection"));
  expect(readFileSync(configPath, "utf8").endsWith(otherBefore)).toBe(true);
  expect(readFileSync(working(root), "utf8")).toContain("Project first rule.");
  expect(readFileSync(working(root), "utf8")).toContain("Updated last rule.");
  expect(required(original(root), "Expected fixture value: original(root)").toString("utf8")).not.toContain(
    "Project first rule.",
  );
  expect(
    required(
      required(
        required(readConfig(root).collections, "Expected fixture value: readConfig(root).collections").sources,
        "Expected fixture value: readConfig(root).collections.sources",
      )[0],
      "Expected fixture value: readConfig(root).collections.sources[0]",
    ).revision,
  ).toBe("2");
  expect(collectionChanges(root, "company")).toHaveLength(1);
});

test("upstream additions and removals and project-owned additions are reconciled explicitly", async () => {
  const root = await fixture(),
    source = provider(root, "company", "1", ["First.", "Second."]);
  adopt(root, source);
  const own = working(root, "company", "02");
  writeFileSync(
    own,
    readFileSync(working(root), "utf8").replaceAll("Policy 0", "Policy 2").replace("# ADR-0:", "# ADR-2:"),
  );
  const next = provider(root, "company", "2", ["Updated first."]);
  reconcileCollection(root, next.directory, options(next), "company");
  expect(existsSync(working(root, "company", "01"))).toBe(false);
  expect(existsSync(own)).toBe(true);
  expect(collectionChanges(root, "company")).toEqual([{ path: "decisions/ADR-02.md", change: "added" }]);
});

test("maps are rebuilt from reconciled records rather than merged or reported as adaptations", async () => {
  const root = await fixture(),
    source = provider(root);
  setConfiguration(root, "markdown.wrap_width", "80");
  adopt(root, source);
  const map = join(root, "workbench/collections/company/decision-map.md");
  writeFileSync(map, "Locally regenerated map with a different format.\n");
  expect(collectionChanges(root, "company")).toEqual([]);
  writeFileSync(
    working(root),
    readFileSync(working(root), "utf8").replace("summary: Policy 0.", "summary: Project summary."),
  );
  const next = provider(root, "company", "2");
  const incoming = join(next.directory, "workbench/decisions/ADR-00.md");
  writeFileSync(incoming, readFileSync(incoming, "utf8").replace("# ADR-0: Policy 0", "# ADR-0: Updated title"));
  writeFileSync(
    join(next.directory, "workbench/decision-map.md"),
    collectionDecisionMap(next.directory, { id: "company", decisions: ["0"] }),
  );
  next.pin = writeCollectionManifest(next.directory, {
    id: "company",
    revision: "2",
    visibility: "public",
    decisions: ["0"],
  });
  git(next.directory, "add", ".");
  git(next.directory, "commit", "-qm", "Update title");
  next.commit = git(next.directory, "rev-parse", "HEAD");
  reconcileCollection(root, next.directory, options(next), "company");
  expect(readFileSync(map, "utf8").replace(/\s+/g, " ")).toContain(
    "[company:ADR-0: Updated title](decisions/ADR-00.md) — Project summary.",
  );
  expect(collectionChanges(root, "company")).toEqual([{ path: "decisions/ADR-00.md", change: "modified" }]);
  const generated = readFileSync(map, "utf8");
  expect(generated.split("\n").every((line) => line.length <= 80)).toBe(true);
  synchronize(root);
  expect(readFileSync(map, "utf8")).toBe(generated);
});

test("binary supporting files survive adoption and unchanged updates", async () => {
  const root = await fixture(),
    binary = Buffer.from([0, 255, 10, 128]);
  const source = provider(root, "company", "1", ["See [evidence](ADR-00/evidence.bin)."], "public", {
    "evidence.bin": binary,
  });
  adopt(root, source);
  expect(readFileSync(join(root, "workbench/collections/company/decisions/ADR-00/evidence.bin"))).toEqual(binary);
  const next = provider(root, "company", "2", ["See [evidence](ADR-00/evidence.bin)."], "public", {
    "evidence.bin": binary,
  });
  reconcileCollection(root, next.directory, options(next), "company");
  expect(collectionChanges(root, "company")).toEqual([]);
});

test("private policy comparisons require an explicit audience and never mutate selections", async () => {
  const root = await fixture(),
    source = provider(root, "company", "1", ["Private."], "private");
  adopt(root, source);
  const next = provider(root, "company", "2", ["New private policy."], "private");
  expect(() => compareCollection(root, "company", next.directory, options(next), false)).toThrow(/private/);
  expect(compareCollection(root, "company", next.directory, options(next), true).changes).toHaveLength(1);
  expect(
    required(
      required(
        required(readConfig(root).collections, "Expected fixture value: readConfig(root).collections").sources,
        "Expected fixture value: readConfig(root).collections.sources",
      )[0],
      "Expected fixture value: readConfig(root).collections.sources[0]",
    ).revision,
  ).toBe("1");
});
