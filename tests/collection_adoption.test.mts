import { required } from "../src/invariants.ts";
import { approveLocalPolicy, reviewLocalPolicy } from "../src/local-policy.ts";
import { collectionOriginals, collectionRepository, stageCollectionSubmodules } from "../src/collection-git.ts";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveCollections } from "../src/collections.ts";
import { installSelectedCollections } from "../src/collection-install.ts";
import { collectionChanges, reconcileCollection } from "../src/collection-reconcile.ts";
import { renderAgentContext } from "../src/agents.ts";
import { decisionScopes } from "../src/decisions.ts";
import { resolveRecordReference } from "../src/record-resolver.ts";
import { synchronize } from "../src/sync.ts";
import { readConfig } from "../src/core.ts";
import { setConfiguration } from "../src/config-command.ts";
import { provider, git } from "./fixtures/adoption.mjs";
import { collectionFixture, adopt, working, original, options } from "./fixtures/collection-scenarios.mjs";

const { fixture } = collectionFixture();

test("the executable does not automatically adopt its own decisions or provider exports", async () => {
  const root = await fixture();
  expect(decisionScopes(root, false).map((scope) => scope.project.id)).toEqual(["consumer"]);
  expect(renderAgentContext(root)).toContain("workbench collection context");
  expect(renderAgentContext(root)).not.toContain("workbench:ADR-");
  expect(resolveCollections(root, false)).toEqual([]);
});

test("local installation applies independently while project adoption retains originals and editable copies", async () => {
  const root = await fixture(),
    source = provider(root);
  adopt(root, source);
  expect(readFileSync(working(root), "utf8")).toEqual(
    required(original(root), "Expected fixture value: original(root)").toString("utf8"),
  );
  expect(
    required(
      required(
        required(readConfig(root).collections, "Expected fixture value: readConfig(root).collections").sources,
        "Expected fixture value: readConfig(root).collections.sources",
      )[0],
      "Expected fixture value: readConfig(root).collections.sources[0]",
    ).sha256,
  ).toBe(source.pin.sha256);
  expect(renderAgentContext(root)).toContain("workbench/collections/company/decision-map.md");
  expect(renderAgentContext(root)).not.toContain(".workbench/collections/");
  expect(collectionChanges(root, "company")).toEqual([]);
  expect(git(root, "ls-files", "--stage")).toBe("");
  stageCollectionSubmodules(
    root,
    required(
      required(readConfig(root).collections, "Expected fixture value: readConfig(root).collections").sources,
      'Fixture value required(readConfig(root).collections, "Expected fixture value: readCo',
    ),
  );
  expect(git(root, "ls-files", "--stage")).toContain(`160000 ${source.commit} 0\t.workbench/collections/company`);
  expect(existsSync(join(root, ".workbench/bin"))).toBe(false);
  expect(existsSync(join(root, ".workbench/collections/company/workbench/decisions"))).toBe(false);
  expect(readFileSync(join(root, ".gitmodules"), "utf8")).toContain("update = none");
});

test("collection acquisition verifies stable packs even when automatic maintenance is aggressively configured", async () => {
  const root = await fixture(),
    source = provider(root);
  adopt(root, source);
  const repository = collectionRepository(root, "company");
  git(repository, "config", "gc.auto", "1");
  git(repository, "config", "gc.autoPackLimit", "1");
  git(repository, "config", "maintenance.auto", "true");
  for (const revision of ["2", "3", "4"]) {
    const next = provider(root, "company", revision, [`Use retry policy ${revision}.`]);
    reconcileCollection(root, next.directory, options(next), "company");
    expect(readFileSync(working(root), "utf8")).toContain(`Use retry policy ${revision}.`);
    git(repository, "fsck", "--strict", "--no-reflogs", "--no-dangling", next.commit);
    expect(readdirSync(join(repository, "objects/pack")).some((name) => name.startsWith(".tmp-"))).toBe(false);
    expect(git(repository, "rev-parse", `refs/workbench/${source.commit}`)).toBe(source.commit);
  }
  expect(git(repository, "config", "maintenance.auto")).toBe("true");
});

test("project adaptations are authoritative and remain visible after their upstream source disappears", async () => {
  const root = await fixture(),
    source = provider(root);
  adopt(root, source);
  writeFileSync(working(root), readFileSync(working(root), "utf8").replaceAll("Policy 0.", "Project instructions."));
  rmSync(source.directory, { recursive: true });
  expect(renderAgentContext(root)).toContain("Project instructions.");
  expect(collectionChanges(root, "company")).toEqual([{ path: "decisions/ADR-00.md", change: "modified" }]);
  expect(resolveRecordReference(root, "company:ADR-0").contents).toContain("Project instructions.");
});

test("missing original objects affect comparison but not committed project context", async () => {
  const root = await fixture(),
    source = provider(root);
  adopt(root, source);
  const pin = required(
    required(readConfig(root).collections, "Expected fixture value: readConfig(root).collections").sources,
    "Expected fixture value: readConfig(root).collections.sources",
  )[0];
  rmSync(collectionRepository(root, required(pin, "Expected fixture value: pin").id), { recursive: true });
  expect(() => collectionOriginals(root, required(pin, "Fixture value pin"))).toThrow(/fetch/);
  expect(renderAgentContext(root)).toContain("company:ADR-0");
  expect(resolveCollections(root, false)).toHaveLength(1);
});

test("namespace collisions reject adoption without changing configuration or existing project files", async () => {
  const root = await fixture(),
    source = provider(root, "consumer");
  const before = readFileSync(join(root, "workbench/config.toml"));
  expect(() => adopt(root, source)).toThrow(/collision/);
  expect(readFileSync(join(root, "workbench/config.toml"))).toEqual(before);
  expect(existsSync(join(root, "workbench/collections/consumer"))).toBe(false);
});

test("root-scope adoption retains the provider charter as context and omits its settings", async () => {
  const root = await fixture(),
    source = provider(root);
  rmSync(join(source.directory, "workbench/collection.toml"));
  writeFileSync(join(source.directory, "workbench/projects.toml"), '[[project]]\nid="company"\npath="."\n');
  writeFileSync(join(source.directory, "workbench/CHARTER.md"), "Provider intent.\n");
  writeFileSync(join(source.directory, "workbench/config.toml"), "provider_setting=true\n");
  const providerMap = join(source.directory, "workbench/decision-map.md");
  writeFileSync(providerMap, readFileSync(providerMap, "utf8") + "\nScope charter: [CHARTER.md](CHARTER.md).\n");
  git(source.directory, "add", ".");
  git(source.directory, "commit", "-qm", "Root provider fixture");
  const commit = git(source.directory, "rev-parse", "HEAD");
  installSelectedCollections(root, [{ source: source.directory }], { scope: "project", commit });
  const pin = required(
    required(readConfig(root).collections, "Expected fixture value: readConfig(root).collections").sources,
    "Expected fixture value: readConfig(root).collections.sources",
  )[0];
  expect(required(pin, "Expected fixture value: pin").revision).toBe(commit);
  expect(
    required(
      collectionOriginals(root, required(pin, "Fixture value pin")).files.get("workbench/decision-map.md"),
      'Expected fixture value: collectionOriginals(root, pin).files.get("workbench/decision-map.md")',
    ).toString("utf8"),
  ).toContain("CHARTER.md");
  const active = join(root, "workbench/collections/company");
  expect(readFileSync(join(active, "decision-map.md"), "utf8")).toContain("[company:ADR-0: Policy 0]");
  expect(readFileSync(join(active, "decision-map.md"), "utf8")).toContain(
    "[Published collection charter (context)](CHARTER.md)",
  );
  expect(readFileSync(join(active, "CHARTER.md"), "utf8")).toBe("Provider intent.\n");
  expect(renderAgentContext(root)).not.toContain("Provider intent.");
  expect(existsSync(join(active, "config.toml"))).toBe(false);
  expect(collectionChanges(root, "company")).toEqual([]);
});

test("scoped project collections govern descendants and allow direct policy edits without overrides", async () => {
  const root = await fixture(),
    source = provider(root);
  adopt(root, source);
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="consumer"\npath="."\n[[project]]\nid="service"\npath="service"\n',
  );
  mkdirSync(join(root, "service/workbench"), { recursive: true });
  const pin = required(
    required(readConfig(root).collections, "Expected fixture value: readConfig(root).collections").sources,
    "Expected fixture value: readConfig(root).collections.sources",
  )[0];
  setConfiguration(root, "collections.sources", JSON.stringify([{ ...pin, scopes: ["service"] }]), "project");
  expect(
    required(
      decisionScopes(root, false).find((scope) => scope.project.id === "company"),
      'Expected fixture value: decisionScopes(root, false).find((scope) => scope.project.id === "company")',
    ).appliesTo,
  ).toEqual(["service"]);
  expect(renderAgentContext(root)).toContain("`service/` and descendants");
});

test("local guidance remains separate from committed context and cannot satisfy project pins", async () => {
  const root = await fixture(),
    source = provider(root);
  const sharedContext = renderAgentContext(root);
  adopt(root, source, "local");
  const base = join(root, "workbench/.local-collections");
  approveLocalPolicy(base, source.pin.id, reviewLocalPolicy(base, source.pin.id).digest, true);
  expect(renderAgentContext(root)).toBe(sharedContext);
  expect(renderAgentContext(root)).not.toContain("company");
  expect(renderAgentContext(root, true)).toContain("company:ADR-0");
  expect(renderAgentContext(root, true)).not.toContain("workbench collection context");
  const before = readFileSync(join(root, "workbench/config.toml"));
  expect(readConfig(root).collections).toBeUndefined();
  synchronize(root);
  expect(readFileSync(join(root, "workbench/config.toml"))).toEqual(before);
});
