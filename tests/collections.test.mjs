import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { stringify, parse } from "smol-toml";
import { afterEach, test, vi } from "vitest";
import {
  inspectCollection,
  storeCollection,
  selectInstalledCollections,
  resolveCollections,
  writeCollectionManifest,
} from "../src/collections.ts";
import {
  collectionDecisionMap,
  compareCollection,
  exportCollection,
  checkCollectionExport,
} from "../src/collection-commands.ts";
import { decisionScopes } from "../src/decisions.ts";
import { renderAgentContext } from "../src/agents.ts";
import { synchronize } from "../src/sync.ts";
import { validate } from "../src/validation.ts";
import { collectionLink, syncCollectionLinks } from "../src/collection-links.ts";
import { resolveRecordReference } from "../src/record-resolver.ts";
import { setConfiguration } from "../src/config-command.ts";
import { provisionCollectionSnapshot } from "../src/collection-provision.ts";
import { addFeedback, resolveFeedback } from "../src/feedback.ts";
import { installSelectedCollections } from "../src/collection-install.ts";
import { userDirectory } from "../src/storage.ts";

const distribution = resolve(import.meta.dirname, "..");
const temporary = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(id = "product") {
  const base = mkdtempSync(join(tmpdir(), "workbench-collections-"));
  temporary.push(base);
  const root = join(base, "project");
  mkdirSync(join(root, "workbench"), { recursive: true });
  writeFileSync(
    join(root, "workbench/config.toml"),
    'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[checks]\nallow_empty=true\n[citations]\nlibrary_dir="library/citations"\n',
  );
  writeFileSync(join(root, "workbench/projects.toml"), `[[project]]\nid="${id}"\npath="."\n`);
  copyFileSync(join(distribution, "workbench/CHARTER.md"), join(root, "workbench/CHARTER.md"));
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  vi.stubEnv("WORKBENCH_DATA_HOME", join(base, "data"));
  vi.stubEnv("WORKBENCH_CONFIG_HOME", join(base, "config"));
  vi.stubEnv("XDG_DATA_DIRS", join(base, "system"));
  vi.stubEnv("PROGRAMDATA", join(base, "system"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  const run = (...args) => {
    const result = spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  return { root, base, run };
}

function decision(root, number, instruction, overrides = []) {
  const path = join(root, `workbench/decisions/ADR-${number.padStart(2, "0")}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `---\nsummary: ${instruction}\nagent_instruction: ${instruction}\n${overrides.length ? `overrides: ${JSON.stringify(overrides)}\n` : ""}---\n\n# ADR-${number}: Policy ${number}\n\n${instruction}\n`,
  );
  return path;
}

function source(
  base,
  id = "company",
  revision = "1",
  visibility = "public",
  dependency = [],
  instruction = "Use the company retry budget.",
) {
  const directory = join(base, `source-${id}-${revision}`);
  mkdirSync(directory, { recursive: true });
  decision(directory, "0", instruction);
  const namespace = [{ id, path: ".", decisions: ["0"] }];
  writeFileSync(join(directory, "workbench/decision-map.md"), collectionDecisionMap(directory, namespace[0]));
  const pin = writeCollectionManifest(directory, { id, revision, visibility, namespace, dependency });
  return { directory, pin };
}

function adopt(root, ...pins) {
  const path = join(root, "workbench/config.toml");
  const config = parse(readFileSync(path, "utf8"));
  config.collections = { sources: pins };
  writeFileSync(path, stringify(config));
}

// Resolver fixtures deliberately include invalid policy graphs; real installations use installSelectedCollections.
function installCollection(source, digest, base = join(userDirectory("data"), "collections"), register = true) {
  const pin = storeCollection(source, digest, base);
  if (register) selectInstalledCollections(base, [pin], () => {});
  return pin;
}

test("the first shipped collection is optional and local installation exposes benchd:ADR-0 automatically", () => {
  const { root, run } = fixture();
  assert.match(
    readFileSync(join(distribution, "workbench/decisions/ADR-0L.md"), "utf8"),
    /# ADR-L: Installed shared collections/,
  );
  assert.doesNotMatch(run("collection", "context"), /Use the installed scheduler/);
  assert.deepEqual(resolveCollections(root), []);
  const benchd = inspectCollection(join(distribution, "collections/benchd/1"));
  run("collection", "install", benchd.directory, "--sha256", benchd.pin.sha256, "--scope", "local");
  const records = JSON.parse(run("decision", "--json"));
  assert.ok(records.some((record) => record.reference === "benchd:ADR-0" && record.installation === "local"));
  assert.match(run("decision", "show", "benchd:ADR-0"), /Use the installed scheduler/);
  assert.equal(JSON.parse(run("decision", "show", "0", "--project", "BENCHD", "--json")).source.id, "benchd");
  assert.match(run("collection", "context"), /benchd:ADR-0/);
  assert.throws(() => resolveRecordReference(root, "benchd:TSK-0"), /unknown project/);
});

test("feedback resolutions can reference applicable provider decisions", () => {
  const { root } = fixture();
  const benchd = join(distribution, "collections/benchd/1");
  installCollection(benchd, inspectCollection(benchd).pin.sha256);
  const path = addFeedback("Scheduling requirement");
  resolveFeedback(root, basename(path, ".md"), "accepted", "Already addressed by installed policy.", ["benchd:ADR-0"]);
  assert.match(readFileSync(path, "utf8"), /Records: benchd:ADR-0/);
  const missing = addFeedback("Unknown policy");
  assert.throws(
    () => resolveFeedback(root, basename(missing, ".md"), "accepted", "Unresolved.", ["benchd:ADR-Z"]),
    /not found/,
  );
  assert.match(readFileSync(missing, "utf8"), /Disposition: New/);
});

test("local installation applies without adoption while shared project installation is self-contained", async () => {
  const { root, base, run } = fixture();
  const company = source(base);
  writeFileSync(join(company.directory, "workbench/CHARTER.md"), "PRIVATE PROVIDER CHARTER");
  mkdirSync(join(company.directory, "workbench/tasks"));
  writeFileSync(join(company.directory, "workbench/tasks/TSK-00.md"), "PROVIDER TASK");
  writeFileSync(join(company.directory, "workbench/config.toml"), "invalid provider configuration");
  synchronize(root);
  const shared = readFileSync(join(root, "AGENTS.md"), "utf8");
  run("collection", "install", company.directory, "--sha256", company.pin.sha256);
  assert.ok(JSON.parse(run("collection", "--installed", "--json")).some((entry) => entry.id === "company"));
  assert.deepEqual(
    resolveCollections(root).map((entry) => entry.pin.id),
    ["company"],
  );
  assert.match(run("collection", "context"), /Local company decisions/);
  synchronize(root);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), shared);
  run("collection", "install", company.directory, "--sha256", company.pin.sha256, "--scope", "project");
  synchronize(root);
  await validate(root);
  const context = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.match(context, /Shared company decisions/);
  assert.match(context, /collections\/company\/1\/workbench\/decision-map.md/);
  assert.doesNotMatch(context, /PRIVATE PROVIDER CHARTER|PROVIDER TASK/);
  assert.equal(existsSync(join(root, "workbench/decisions/ADR-00.md")), false);
  assert.equal(existsSync(join(root, "collections/company/1/workbench/tasks")), false);
  assert.match(readFileSync(join(root, "workbench/decision-map.md"), "utf8"), /company, revision 1/);
  const clone = join(base, "clone");
  cpSync(root, clone, { recursive: true });
  vi.stubEnv("WORKBENCH_DATA_HOME", join(base, "empty-data"));
  rmSync(company.directory, { recursive: true });
  rmSync(join(base, "data"), { recursive: true });
  assert.equal(resolveCollections(clone)[0].directory, join(clone, "collections/company/1"));
  assert.equal(resolveCollections(clone)[0].local, undefined);
  assert.equal(renderAgentContext(clone), context);
  await validate(clone);
});

test("local upgrades select the installed revision without changing shared files or discarding older contents", () => {
  const { root, base, run } = fixture();
  synchronize(root);
  const paths = ["workbench/config.toml", "workbench/decision-map.md", "AGENTS.md"];
  const before = paths.map((path) => readFileSync(join(root, path), "utf8"));
  const first = source(base);
  const second = source(base, "company", "2", "public", [], "Use the upgraded retry budget.");
  run("collection", "install", first.directory, "--sha256", first.pin.sha256);
  const comparison = compareCollection(root, "company", second.directory, second.pin.sha256, false);
  assert.equal(comparison.before.revision, "1");
  assert.match(comparison.changes[0].after, /upgraded retry budget/);
  run("collection", "install", second.directory, "--sha256", second.pin.sha256);
  assert.equal(resolveCollections(root)[0].pin.revision, "2");
  assert.match(renderAgentContext(root, true), /upgraded retry budget/);
  assert.deepEqual(
    paths.map((path) => readFileSync(join(root, path), "utf8")),
    before,
  );
  assert.equal(inspectCollection(join(base, "data/collections/company/1")).pin.sha256, first.pin.sha256);
});

test.each(["user", "system", "local", "project"])(
  "%s installation rejects a bad policy selection while preserving the previous revision",
  (scope) => {
    const { root, base, run } = fixture();
    const first = source(base);
    const broken = source(base, "company", "2", "public", [], "Follow missing:ADR-0.");
    const destination =
      scope === "project"
        ? join(root, "collections")
        : scope === "local"
          ? join(root, "workbench/.local-collections")
          : scope === "system"
            ? join(base, "system/workbench/collections")
            : join(base, "data/collections");
    if (scope === "system") setConfiguration(root, "collections.directories", JSON.stringify([destination]), "local");
    const scopeOptions = ["--scope", scope, ...(scope === "system" ? ["--directory", destination] : [])];
    run("collection", "install", first.directory, "--sha256", first.pin.sha256, ...scopeOptions);
    const selection = scope === "project" ? join(root, "workbench/config.toml") : join(destination, "index.toml");
    const before = readFileSync(selection, "utf8");
    const context = renderAgentContext(root, scope !== "project");
    // Reusing already stored contents must repeat the preflight too.
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(
        () => run("collection", "install", broken.directory, "--sha256", broken.pin.sha256, ...scopeOptions),
        /selection rejected; previous selection is unchanged:.*ADR reference not found/s,
      );
      assert.equal(readFileSync(selection, "utf8"), before);
      assert.equal(resolveCollections(root)[0].pin.revision, "1");
      assert.equal(renderAgentContext(root, scope !== "project"), context);
      assert.equal(existsSync(join(destination, ".registry.lock")), false);
      assert.equal(existsSync(join(root, "workbench/.collection-selection.lock")), false);
    }
    assert.equal(inspectCollection(join(destination, "company/2")).pin.sha256, broken.pin.sha256);
  },
);

test.each(["user", "project"])("%s dependency upgrades can select one verified batch atomically", (scope) => {
  const { root, base, run } = fixture();
  const identity = ({ pin }) => ({
    id: pin.id,
    revision: pin.revision,
    sha256: pin.sha256,
    visibility: pin.visibility,
  });
  const first = source(base);
  const dependent = source(base, "division", "1", "public", [identity(first)], "Follow company:ADR-0.");
  const second = source(base, "company", "2");
  const upgraded = source(base, "division", "2", "public", [identity(second)], "Follow company:ADR-0.");
  const install = (...collections) =>
    run(
      "collection",
      "install",
      ...collections.map((entry) => entry.directory),
      ...collections.flatMap((entry) => ["--sha256", entry.pin.sha256]),
      "--scope",
      scope,
    );
  install(first, dependent);
  const selected = () => resolveCollections(root).map(({ pin }) => [pin.id, pin.revision]);
  const before = selected();
  for (const entry of [second, upgraded]) {
    assert.throws(() => install(entry), /missing or mismatched dependency/);
    assert.deepEqual(selected(), before);
  }
  const result = JSON.parse(install(upgraded, second));
  assert.equal(result.length, 2);
  assert.deepEqual(selected(), [
    ["company", "2"],
    ["division", "2"],
  ]);
  assert.ok(decisionScopes(root).some((entry) => entry.source?.id === "division"));
});

test("preflight rejects namespace collisions and local/shared conflicts without changing selections", () => {
  const { root, base, run } = fixture();
  const first = source(base);
  run("collection", "install", first.directory, "--sha256", first.pin.sha256);
  run("collection", "install", first.directory, "--sha256", first.pin.sha256, "--scope", "project");
  const registry = join(base, "data/collections/index.toml");
  const before = readFileSync(registry, "utf8");
  const collision = source(base, "product");
  assert.throws(() => run("collection", "install", collision.directory, "--sha256", collision.pin.sha256), /collide/);
  const second = source(base, "company", "2");
  assert.throws(
    () => run("collection", "install", second.directory, "--sha256", second.pin.sha256),
    /conflicting local and project installations/,
  );
  assert.equal(readFileSync(registry, "utf8"), before);
  assert.equal(resolveCollections(root)[0].pin.revision, "1");
});

test("installation outside a project preflights installed and distribution policy without initializing a project", () => {
  const { base } = fixture();
  const outside = join(base, "outside");
  mkdirSync(outside);
  const company = source(base, "company", "1", "public", [], "Follow workbench:ADR-0.");
  const install = (entry) =>
    installSelectedCollections(outside, [{ source: entry.directory, sha256: entry.pin.sha256 }], { scope: "user" });
  assert.equal(install(company)[0].id, "company");
  assert.equal(existsSync(join(outside, "workbench")), false);
  assert.equal(resolveCollections(outside)[0].pin.id, "company");
  const collision = source(base, "workbench");
  assert.throws(() => install(collision), /shared and local project IDs collide/);
  assert.deepEqual(
    resolveCollections(outside).map(({ pin }) => pin.id),
    ["company"],
  );
  assert.equal(existsSync(join(outside, "workbench")), false);
});

test.each(["user", "project"])("%s selection respects an existing writer lock", (scope) => {
  const { root, base } = fixture();
  const first = source(base);
  const second = source(base, "company", "2");
  const install = (entry) =>
    installSelectedCollections(root, [{ source: entry.directory, sha256: entry.pin.sha256 }], { scope });
  install(first);
  const lock =
    scope === "project"
      ? join(root, "workbench/.collection-selection.lock")
      : join(base, "data/collections/.registry.lock");
  mkdirSync(lock);
  assert.throws(() => install(second), /EEXIST/);
  assert.equal(existsSync(lock), true);
  assert.equal(resolveCollections(root)[0].pin.revision, "1");
  rmSync(lock, { recursive: true });
  assert.equal(install(second)[0].revision, "2");
});

test("a failed batch keeps every previous selection and rejects incomplete digest lists", () => {
  const { root, base, run } = fixture();
  const first = source(base);
  run("collection", "install", first.directory, "--sha256", first.pin.sha256);
  const second = source(base, "company", "2");
  const broken = source(base, "other", "1", "public", [], "Follow absent:ADR-0.");
  const registry = join(base, "data/collections/index.toml");
  const before = readFileSync(registry, "utf8");
  assert.throws(
    () => run("collection", "install", second.directory, broken.directory, "--sha256", second.pin.sha256),
    /one --sha256 for each directory/,
  );
  assert.throws(
    () =>
      run(
        "collection",
        "install",
        second.directory,
        broken.directory,
        "--sha256",
        second.pin.sha256,
        "--sha256",
        broken.pin.sha256,
      ),
    /selection rejected/,
  );
  assert.equal(readFileSync(registry, "utf8"), before);
  assert.deepEqual(
    resolveCollections(root).map(({ pin }) => pin.revision),
    ["1"],
  );
  assert.throws(
    () =>
      run(
        "collection",
        "install",
        first.directory,
        second.directory,
        "--sha256",
        first.pin.sha256,
        "--sha256",
        second.pin.sha256,
      ),
    /duplicate collection/,
  );
  assert.equal(readFileSync(registry, "utf8"), before);
});

test("shared upgrades preserve declared project scopes and report the installed selection accurately", () => {
  const { root, base, run } = fixture();
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="product"\npath="."\n[[project]]\nid="api"\npath="api"\n',
  );
  mkdirSync(join(root, "api"));
  const first = source(base);
  const second = source(base, "company", "2");
  run("collection", "install", first.directory, "--sha256", first.pin.sha256, "--scope", "project");
  adopt(root, { ...first.pin, scopes: ["api"] });
  const installed = JSON.parse(
    run("collection", "install", second.directory, "--sha256", second.pin.sha256, "--scope", "project"),
  );
  assert.deepEqual(installed.scopes, ["api"]);
  assert.deepEqual({ ...resolveCollections(root, false)[0].pin }, { ...second.pin, scopes: ["api"] });
  assert.equal(inspectCollection(join(root, "collections/company/1")).pin.sha256, first.pin.sha256);
});

test("shared policy cannot depend on a host installation or reference optional local records", () => {
  const { root, base } = fixture();
  const company = source(base);
  installCollection(company.directory, company.pin.sha256);
  adopt(root, company.pin);
  assert.throws(() => resolveCollections(root), /not installed in the repository/);
  adopt(root);
  const record = decision(root, "0", "Follow company:ADR-0.");
  assert.throws(() => decisionScopes(root), /cannot depend on local installations/);
  decision(root, "0", "Use the project policy.", ["company:ADR-0"]);
  assert.throws(() => decisionScopes(root), /cannot override local installations/);
  rmSync(record);
  const identity = {
    id: company.pin.id,
    revision: company.pin.revision,
    sha256: company.pin.sha256,
    visibility: company.pin.visibility,
  };
  const division = source(base, "division", "1", "public", [identity], "Follow company:ADR-0.");
  installCollection(division.directory, division.pin.sha256, join(root, "collections"), false);
  adopt(root, division.pin);
  assert.throws(() => resolveCollections(root), /cannot depend on a local installation/);
});

test("identical local and shared selections deduplicate while differing revisions or scopes fail explicitly", () => {
  const { root, base } = fixture();
  const first = source(base);
  const second = source(base, "company", "2");
  installCollection(first.directory, first.pin.sha256);
  installCollection(first.directory, first.pin.sha256, join(root, "collections"), false);
  adopt(root, first.pin);
  assert.equal(resolveCollections(root).length, 1);
  assert.equal(resolveCollections(root)[0].local, undefined);
  assert.doesNotMatch(renderAgentContext(root, true), /Local company decisions/);
  installCollection(second.directory, second.pin.sha256);
  assert.throws(() => resolveCollections(root), /conflicting local and project installations/);
  installCollection(first.directory, first.pin.sha256);
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="product"\npath="."\n[[project]]\nid="api"\npath="api"\n',
  );
  mkdirSync(join(root, "api"));
  adopt(root, { ...first.pin, scopes: ["api"] });
  assert.throws(() => resolveCollections(root), /conflicting local and project installations/);
});

test("private local policies remain readable locally but never become provider export dependencies or bundle contents", async () => {
  const { root, base, run } = fixture("provider");
  const company = source(base, "company", "1", "private", [], "PRIVATE LOCAL POLICY");
  run("collection", "install", company.directory, "--sha256", company.pin.sha256, "--scope", "local");
  decision(root, "0", "Use the provider policy.");
  synchronize(root);
  assert.match(renderAgentContext(root, true), /PRIVATE LOCAL POLICY/);
  assert.doesNotMatch(renderAgentContext(root), /PRIVATE LOCAL POLICY|company:ADR-0/);
  checkCollectionExport(root, false);
  const output = join(base, "export");
  await exportCollection(root, output, "provider", "1", ["0"], undefined, false, "public");
  assert.deepEqual(inspectCollection(output).manifest.dependency, []);
  const bundled = join(base, "bundle");
  run("collection", "bundle", bundled);
  assert.equal(existsSync(join(bundled, "company")), false);
  decision(root, "0", "Follow company:ADR-0.");
  const rejected = join(base, "rejected-export");
  await assert.rejects(
    exportCollection(root, rejected, "provider", "2", ["0"], undefined, false, "public"),
    /ADR reference not found/,
  );
  assert.equal(existsSync(rejected), false);
});

test("user, system and explicit local sources verify identical duplicates and reject substitutions", () => {
  const { root, base } = fixture();
  const company = source(base);
  installCollection(company.directory, company.pin.sha256);
  installCollection(company.directory, company.pin.sha256, join(base, "system/workbench/collections"));
  const explicit = join(base, "explicit");
  installCollection(company.directory, company.pin.sha256, explicit);
  setConfiguration(
    root,
    "collections.directories",
    JSON.stringify([explicit, join(base, "system/workbench/collections")]),
    "local",
  );
  assert.match(resolveCollections(root).find((entry) => entry.pin.id === "company").directory, /explicit/);
  writeFileSync(join(base, "system/workbench/collections/company/1/workbench/decisions/ADR-00.md"), "substituted");
  assert.throws(() => resolveCollections(root), /failed verification/);
});

test("global collection directories are separate from portable project pins", () => {
  const { root, base } = fixture();
  const company = source(base);
  const external = join(base, "shared");
  installCollection(company.directory, company.pin.sha256, external);
  setConfiguration(root, "collections.directories", JSON.stringify([external]), "global");
  assert.equal(
    resolveCollections(root).find((entry) => entry.pin.id === "company").directory,
    join(external, "company/1"),
  );
  assert.doesNotMatch(readFileSync(join(root, "workbench/config.toml"), "utf8"), /shared/);
  assert.throws(() => setConfiguration(root, "collections.directories", '["relative"]', "global"), /absolute/);
});

test("provider upgrades coexist and comparison exposes exact policy changes without changing the pin", () => {
  const { root, base } = fixture();
  const first = source(base);
  const second = source(base, "company", "2", "public", [], "Use the revised retry budget.");
  installCollection(first.directory, first.pin.sha256, join(root, "collections"), false);
  installCollection(second.directory, second.pin.sha256, join(root, "collections"), false);
  adopt(root, first.pin);
  const original = readFileSync(join(root, "workbench/config.toml"), "utf8");
  const report = compareCollection(root, "company", second.directory, second.pin.sha256, false);
  assert.equal(report.changes.length, 1);
  assert.match(report.changes[0].before, /company retry budget/);
  assert.match(report.changes[0].after, /revised retry budget/);
  assert.equal(readFileSync(join(root, "workbench/config.toml"), "utf8"), original);
  adopt(root, second.pin);
  synchronize(root);
  assert.match(renderAgentContext(root), /revision `2`/);
  assert.equal(inspectCollection(join(root, "collections/company/1")).pin.sha256, first.pin.sha256);
});

test("scoped collections apply to descendants and permit explicit local overrides without governing siblings", () => {
  const { root, base } = fixture();
  const registry = join(root, "workbench/projects.toml");
  writeFileSync(
    registry,
    readFileSync(registry, "utf8") +
      '\n[[project]]\nid="api"\npath="api"\n[[project]]\nid="worker"\npath="api/worker"\n[[project]]\nid="web"\npath="web"\n',
  );
  for (const path of ["api", "api/worker", "web"]) mkdirSync(join(root, path, "workbench"), { recursive: true });
  const company = source(base);
  installCollection(company.directory, company.pin.sha256, join(root, "collections"), false);
  adopt(root, { ...company.pin, scopes: ["api"] });
  decision(join(root, "api"), "0", "Use the local retry budget.", ["company:ADR-0"]);
  assert.match(renderAgentContext(root), /Shared company decisions\n\nApplies to: `api\/` and descendants/);
  assert.match(renderAgentContext(root), /Overrides in this scope: \[company:ADR-0\]/);
  decision(join(root, "web"), "0", "Use the web retry budget.", ["company:ADR-0"]);
  assert.throws(() => decisionScopes(root), /outside the same or an inherited scope/);
});

test("private standards integrate locally but exports and comparisons require a private audience", () => {
  const { root, base } = fixture();
  const company = source(base, "company", "1", "private");
  installCollection(company.directory, company.pin.sha256, join(root, "collections"), false);
  adopt(root, company.pin);
  assert.match(renderAgentContext(root), /\(private\)/);
  assert.throws(() => checkCollectionExport(root, false), /private ADR collections/);
  checkCollectionExport(root, true);
  const second = source(base, "company", "2", "private");
  assert.throws(
    () => compareCollection(root, "company", second.directory, second.pin.sha256, false),
    /private policy comparison/,
  );
  assert.equal(compareCollection(root, "company", second.directory, second.pin.sha256, true).after.revision, "2");
});

test("missing, modified, conflicting and unsupported collection pins fail without dropping policy", () => {
  const { root, base } = fixture();
  const company = source(base);
  adopt(root, company.pin);
  assert.throws(() => resolveCollections(root), /not installed/);
  installCollection(company.directory, company.pin.sha256, join(root, "collections"), false);
  adopt(root, { ...company.pin, sha256: "a".repeat(64) });
  assert.throws(() => resolveCollections(root), /does not match pin/);
  adopt(root, { ...company.pin, scopes: ["missing"] });
  assert.throws(() => resolveCollections(root), /registered project paths/);
  adopt(root, { ...company.pin, revision: "../escape" });
  assert.throws(() => resolveCollections(root), /invalid collection revision/);
  const path = join(company.directory, "workbench/collection.toml");
  const manifest = readFileSync(path, "utf8");
  writeFileSync(path, manifest.replace("schema_version = 1", "schema_version = 2"));
  assert.throws(() => inspectCollection(company.directory), /unsupported collection manifest/);
  writeFileSync(path, manifest.replace('id = "company"', 'id = "company"\nunknown = true'));
  assert.throws(() => inspectCollection(company.directory), /unknown field/);
});

test("namespace collisions, unresolved references and later ADR references are rejected", () => {
  const { root, base } = fixture();
  const collision = source(base, "product");
  installCollection(collision.directory, collision.pin.sha256, join(root, "collections"), false);
  adopt(root, collision.pin);
  assert.throws(() => decisionScopes(root), /IDs collide/);
  const missing = source(base, "company", "missing", "public", [], "Follow absent:ADR-0.");
  installCollection(missing.directory, missing.pin.sha256, join(root, "collections"), false);
  adopt(root, missing.pin);
  assert.throws(() => decisionScopes(root), /ADR reference not found/);
  const later = source(base, "company", "later", "public", [], "Follow ADR-1.");
  decision(later.directory, "1", "The later rule.");
  const manifest = inspectCollection(later.directory).manifest;
  manifest.namespace[0].decisions.push("1");
  writeFileSync(
    join(later.directory, "workbench/decision-map.md"),
    collectionDecisionMap(later.directory, manifest.namespace[0]),
  );
  const pin = writeCollectionManifest(later.directory, {
    id: "company",
    revision: "later",
    visibility: "public",
    namespace: manifest.namespace,
    dependency: [],
  });
  installCollection(later.directory, pin.sha256, join(root, "collections"), false);
  adopt(root, pin);
  assert.throws(() => decisionScopes(root), /earlier decision/);
});

test("collection dependencies are explicit, pinned and cover every governed scope", () => {
  const { root, base } = fixture();
  const company = source(base);
  const identity = (pin) => ({ id: pin.id, revision: pin.revision, sha256: pin.sha256, visibility: pin.visibility });
  const division = source(base, "division", "1", "public", [identity(company.pin)], "Apply company:ADR-0.");
  installCollection(company.directory, company.pin.sha256, join(root, "collections"), false);
  installCollection(division.directory, division.pin.sha256, join(root, "collections"), false);
  adopt(root, division.pin);
  assert.throws(() => resolveCollections(root), /missing or mismatched dependency/);
  adopt(root, division.pin, company.pin);
  assert.deepEqual(
    resolveCollections(root).map((entry) => entry.pin.id),
    ["company", "division"],
  );
  assert.doesNotThrow(() => decisionScopes(root));
  const undeclared = source(base, "division", "2", "public", [], "Apply company:ADR-0.");
  installCollection(undeclared.directory, undeclared.pin.sha256, join(root, "collections"), false);
  adopt(root, undeclared.pin, company.pin);
  assert.throws(() => decisionScopes(root), /declared dependencies/);
});

test("inventory checks reject path escape, symlinked records, stale maps and corrupted files before installation", () => {
  const { base } = fixture();
  const company = source(base);
  const record = join(company.directory, "workbench/decisions/ADR-00.md");
  const bytes = readFileSync(record);
  rmSync(record);
  const outside = join(base, "outside.md");
  writeFileSync(outside, bytes);
  symlinkSync(outside, record);
  assert.throws(() => installCollection(company.directory, company.pin.sha256), /symlinks are not supported/);
  rmSync(record);
  writeFileSync(record, bytes);
  const manifestPath = join(company.directory, "workbench/collection.toml");
  const manifest = parse(readFileSync(manifestPath, "utf8"));
  manifest.namespace[0].path = "../escape";
  writeFileSync(manifestPath, stringify(manifest));
  assert.throws(() => inspectCollection(company.directory), /unsafe relative path/);
  manifest.namespace[0].path = ".";
  writeFileSync(manifestPath, stringify(manifest));
  writeFileSync(join(company.directory, "workbench/decision-map.md"), "stale map\n");
  assert.throws(
    () =>
      writeCollectionManifest(company.directory, {
        id: "company",
        revision: "1",
        visibility: "public",
        namespace: manifest.namespace,
        dependency: [],
      }),
    /map is stale/,
  );
});

test("failed installs leave existing revisions intact and never publish partial contents", () => {
  const { base } = fixture();
  const company = source(base);
  assert.throws(() => installCollection(company.directory, "f".repeat(64)), /does not match/);
  assert.equal(existsSync(join(base, "data/collections/company/1")), false);
  installCollection(company.directory, company.pin.sha256);
  installCollection(company.directory, company.pin.sha256);
  const revised = source(base, "company", "other", "public", [], "Use different rules.");
  const data = parse(readFileSync(join(revised.directory, "workbench/collection.toml"), "utf8"));
  data.revision = "1";
  writeFileSync(join(revised.directory, "workbench/collection.toml"), stringify(data));
  const digest = hash(readFileSync(join(revised.directory, "workbench/collection.toml")));
  assert.throws(() => installCollection(revised.directory, digest), /does not match pin/);
  assert.equal(inspectCollection(join(base, "data/collections/company/1")).pin.sha256, company.pin.sha256);
  assert.equal(existsSync(join(base, "data/collections/company/1.lock")), false);
});

test("local context follows installation locations without changing tracked context or existing ignored data", () => {
  const { root, base } = fixture();
  const company = source(base);
  synchronize(root);
  const first = renderAgentContext(root);
  installCollection(company.directory, company.pin.sha256);
  assert.match(renderAgentContext(root, true), /Local company decisions/);
  const link = collectionLink(root, "company", "1");
  mkdirSync(link, { recursive: true });
  writeFileSync(join(link, "keep.txt"), "user data");
  synchronize(root);
  assert.equal(readFileSync(join(link, "keep.txt"), "utf8"), "user data");
  const relocated = join(base, "relocated");
  cpSync(join(base, "data/collections"), relocated, { recursive: true });
  vi.stubEnv("WORKBENCH_DATA_HOME", join(base, "empty-data"));
  setConfiguration(root, "collections.directories", JSON.stringify([relocated]), "local");
  synchronize(root);
  syncCollectionLinks(root, true);
  assert.equal(renderAgentContext(root), first);
  assert.match(renderAgentContext(root, true), /relocated/);
});

test("provider export includes only explicitly selected ADRs and never overwrites an immutable export", async () => {
  const { root, base } = fixture("company");
  decision(root, "0", "Use the shared budget.");
  decision(root, "1", "Implementation-only choice.");
  const output = join(base, "export");
  const pin = await exportCollection(root, output, "company", "1", ["0"], undefined, false, "public");
  assert.deepEqual(inspectCollection(output).manifest.namespace[0].decisions, ["0"]);
  assert.equal(existsSync(join(output, "workbench/decisions/ADR-01.md")), false);
  assert.equal(existsSync(join(output, "workbench/CHARTER.md")), false);
  assert.equal(pin.sha256, hash(readFileSync(join(output, "workbench/collection.toml"))));
  await assert.rejects(
    exportCollection(root, output, "company", "1", ["0"], undefined, false, "public"),
    /already exists/,
  );
  await assert.rejects(
    exportCollection(root, join(base, "other"), "company", "2", [], undefined, false, "public"),
    /explicitly select/,
  );
});

test("provider exports cannot expose private dependencies as public policy", async () => {
  const { root, base } = fixture("provider");
  const company = source(base, "company", "1", "private");
  installCollection(company.directory, company.pin.sha256, join(root, "collections"), false);
  adopt(root, company.pin);
  decision(root, "0", "Apply company:ADR-0.");
  await assert.rejects(
    exportCollection(root, join(base, "public"), "provider", "1", ["0"], undefined, false, "public"),
    /private dependencies/,
  );
  await exportCollection(root, join(base, "private"), "provider", "1", ["0"], undefined, false, "private");
  assert.equal(existsSync(join(base, "public")), false);
});

test("selective exports include only referenced collections and their transitive dependencies", async () => {
  const { root, base } = fixture("provider");
  const foundation = source(base, "foundation");
  const foundationIdentity = {
    id: foundation.pin.id,
    revision: foundation.pin.revision,
    sha256: foundation.pin.sha256,
    visibility: foundation.pin.visibility,
  };
  const company = source(base, "company", "1", "public", [foundationIdentity], "Apply foundation:ADR-0.");
  const privatePolicy = source(base, "private-policy", "1", "private");
  for (const item of [foundation, company, privatePolicy])
    installCollection(item.directory, item.pin.sha256, join(root, "collections"), false);
  adopt(root, foundation.pin, company.pin, privatePolicy.pin);
  decision(root, "0", "Independent public policy.");
  decision(root, "1", "Apply company:ADR-0.");
  const independent = join(base, "independent");
  await exportCollection(root, independent, "provider", "1", ["0"], undefined, false, "public");
  assert.deepEqual(inspectCollection(independent).manifest.dependency, []);
  const dependent = join(base, "dependent");
  await exportCollection(root, dependent, "provider", "2", ["1"], undefined, false, "public");
  assert.deepEqual(
    inspectCollection(dependent)
      .manifest.dependency.map((pin) => pin.id)
      .sort(),
    ["company", "foundation"],
  );
});

test("removing a source leaves dangling overrides invalid instead of silently dropping their target", () => {
  const { root, base } = fixture();
  const company = source(base);
  installCollection(company.directory, company.pin.sha256, join(root, "collections"), false);
  adopt(root, company.pin);
  decision(root, "0", "Use a local exception.", ["company:ADR-0"]);
  assert.doesNotThrow(() => decisionScopes(root));
  adopt(root);
  assert.throws(() => decisionScopes(root), /overridden ADR not found/);
});

test("collection dependency scopes and public/private boundaries cannot be weakened", () => {
  const { root, base } = fixture();
  writeFileSync(
    join(root, "workbench/projects.toml"),
    readFileSync(join(root, "workbench/projects.toml"), "utf8") + '\n[[project]]\nid="api"\npath="api"\n',
  );
  mkdirSync(join(root, "api"));
  const company = source(base);
  const identity = {
    id: company.pin.id,
    revision: company.pin.revision,
    sha256: company.pin.sha256,
    visibility: company.pin.visibility,
  };
  const division = source(base, "division", "1", "public", [identity]);
  for (const entry of [company, division])
    installCollection(entry.directory, entry.pin.sha256, join(root, "collections"), false);
  adopt(root, division.pin, { ...company.pin, scopes: ["api"] });
  assert.throws(() => resolveCollections(root), /does not cover its scopes/);
  const privateCompany = source(base, "company", "private", "private");
  const publicDivision = source(base, "division", "private-dependency", "public", [
    {
      id: privateCompany.pin.id,
      revision: privateCompany.pin.revision,
      sha256: privateCompany.pin.sha256,
      visibility: "private",
    },
  ]);
  for (const entry of [privateCompany, publicDivision])
    installCollection(entry.directory, entry.pin.sha256, join(root, "collections"), false);
  adopt(root, publicDivision.pin, privateCompany.pin);
  assert.throws(() => resolveCollections(root), /depends on private material/);
});

test("independent collection overrides cannot compete on overlapping scopes", () => {
  const { root, base } = fixture();
  const benchd = inspectCollection(join(distribution, "collections/benchd/1")).pin;
  installCollection(join(distribution, "collections/benchd/1"), benchd.sha256, join(root, "collections"), false);
  const dependency = [
    { id: benchd.id, revision: benchd.revision, sha256: benchd.sha256, visibility: benchd.visibility },
  ];
  const candidates = [];
  for (const id of ["company", "division"]) {
    const collection = source(base, id);
    decision(collection.directory, "0", "Use this scheduling exception.", ["benchd:ADR-0"]);
    const namespace = [{ id, path: ".", decisions: ["0"] }];
    writeFileSync(
      join(collection.directory, "workbench/decision-map.md"),
      collectionDecisionMap(collection.directory, namespace[0]),
    );
    const pin = writeCollectionManifest(collection.directory, {
      id,
      revision: "1",
      visibility: "public",
      namespace,
      dependency,
    });
    installCollection(collection.directory, pin.sha256, join(root, "collections"), false);
    candidates.push(pin);
  }
  adopt(root, benchd, ...candidates);
  assert.throws(() => decisionScopes(root), /competing replacements/);
});

test("cross-source record cycles fail even when namespace numbering grants no precedence", () => {
  const { root, base } = fixture();
  const module = join(base, "module");
  mkdirSync(join(module, "languages"), { recursive: true });
  writeFileSync(join(module, "languages/index.toml"), "schema_version=1\nlanguages=[]\n");
  mkdirSync(join(root, ".workbench/workbench"), { recursive: true });
  writeFileSync(join(root, ".workbench/workbench/projects.toml"), '[[project]]\nid="workbench"\npath="."\n');
  decision(join(root, ".workbench"), "0", "Apply company:ADR-0.");
  const company = source(base, "company", "1", "public", [], "Apply workbench:ADR-0.");
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", module);
  installCollection(company.directory, company.pin.sha256, join(root, "collections"), false);
  adopt(root, company.pin);
  assert.throws(() => decisionScopes(root), /ADR reference cycle/);
});

test("collections may export multiple namespaces while their maps retain the Workbench hierarchy", () => {
  const { root, base } = fixture();
  const company = source(base);
  const security = join(company.directory, "security");
  decision(
    security,
    "0",
    "Use the security policy from company:ADR-0 through [company policy](../../../workbench/decisions/ADR-00.md).",
  );
  const namespace = [
    { id: "company", path: ".", decisions: ["0"] },
    { id: "security", path: "security", decisions: ["0"] },
  ];
  writeFileSync(join(security, "workbench/decision-map.md"), collectionDecisionMap(security, namespace[1]));
  const pin = writeCollectionManifest(company.directory, {
    id: "company",
    revision: "1",
    visibility: "public",
    namespace,
    dependency: [],
  });
  installCollection(company.directory, pin.sha256, join(root, "collections"), false);
  adopt(root, pin);
  synchronize(root);
  assert.match(renderAgentContext(root), /collections\/company\/1\/security\/workbench\/decision-map.md/);
  assert.equal(resolveRecordReference(root, "security:ADR-0").contents.includes("security policy"), true);
});

test("bounded verification and portable paths reject oversized or unexported inventory entries", () => {
  const { base } = fixture();
  const company = source(base);
  const manifestPath = join(company.directory, "workbench/collection.toml");
  const original = readFileSync(manifestPath, "utf8");
  const manifest = parse(original);
  manifest.files["workbench/config.toml"] = "f".repeat(64);
  manifest.content_sha256 = hash(
    JSON.stringify(Object.entries(manifest.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
  writeFileSync(manifestPath, stringify(manifest));
  assert.throws(() => inspectCollection(company.directory), /exactly exported ADRs and maps/);
  writeFileSync(manifestPath, original);
  writeFileSync(join(company.directory, "workbench/decisions/ADR-00.md"), "a".repeat(1024 * 1024 + 1));
  assert.throws(() => inspectCollection(company.directory), /no larger than 1 MiB/);
});

test("provider self-dependencies and exported links to unselected content fail", () => {
  const { root, base } = fixture();
  const company = source(base);
  const manifestPath = join(company.directory, "workbench/collection.toml");
  const manifest = parse(readFileSync(manifestPath, "utf8"));
  manifest.dependency = [
    {
      id: company.pin.id,
      revision: company.pin.revision,
      sha256: company.pin.sha256,
      visibility: company.pin.visibility,
    },
  ];
  writeFileSync(manifestPath, stringify(manifest));
  assert.throws(() => inspectCollection(company.directory), /self collection dependency/);
  const escaped = source(base, "company", "escape", "public", [], "Read [private notes](../../private.md).");
  installCollection(escaped.directory, escaped.pin.sha256, join(root, "collections"), false);
  adopt(root, escaped.pin);
  assert.throws(() => decisionScopes(root), /links outside selected records/);
});

test("local CI freezes verified external policies into ignored workspace files for container use", () => {
  const { root, base } = fixture();
  const company = source(base, "company", "1", "private");
  installCollection(company.directory, company.pin.sha256);
  synchronize(root);
  const expected = readFileSync(join(root, "AGENTS.md"), "utf8");
  const snapshot = join(base, "snapshot");
  cpSync(join(root, "workbench"), join(snapshot, "workbench"), {
    recursive: true,
    filter: (path) => !path.includes(".collections"),
  });
  provisionCollectionSnapshot(root, snapshot);
  rmSync(join(base, "data/collections/company"), { recursive: true });
  vi.stubEnv("WORKBENCH_DATA_HOME", join(base, "other-host"));
  vi.stubEnv("WORKBENCH_COLLECTIONS_MATERIALIZED", "1");
  assert.match(resolveCollections(snapshot).find((entry) => entry.pin.id === "company").directory, /snapshot/);
  assert.equal(renderAgentContext(snapshot), expected);
  assert.match(renderAgentContext(snapshot, true), /Local company decisions/);
  assert.equal(
    readFileSync(join(snapshot, "workbench/.collections/company/1/workbench/decisions/ADR-00.md"), "utf8"),
    readFileSync(join(company.directory, "workbench/decisions/ADR-00.md"), "utf8"),
  );
});

test("staged gates resolve local policies without committing them", () => {
  const { root, base } = fixture();
  for (const path of ["bin", "bundle", ".githooks", ".gitattributes", "skills", "languages", "collections", "Makefile"])
    cpSync(join(distribution, path), join(root, path), { recursive: true });
  const company = source(base, "company", "1", "private");
  installCollection(company.directory, company.pin.sha256);
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const run = (...args) => {
    const result = spawnSync(process.execPath, [join(root, "bin/workbench.mjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  git("init", "-q");
  git("config", "core.hooksPath", ".githooks");
  run("sync");
  git("add", ".");
  const digest = /Review digest: ([0-9a-f]{64})/.exec(run("review"))[1];
  run("review", "approve", "--digest", digest, "--human-written-charters");
  git("hook", "run", "pre-commit");
  assert.equal(git("ls-files", "workbench/.collections"), "");
});

test("standalone packaging carries an optional benchd export without inheriting local policy", () => {
  const { base } = fixture();
  const output = join(base, "release");
  const result = spawnSync(process.execPath, [join(distribution, "scripts/package-workbench.mjs")], {
    cwd: distribution,
    encoding: "utf8",
    env: { ...process.env, WORKBENCH_RELEASE_OUTPUT: output, WORKBENCH_DISTRIBUTION_ROOT: distribution },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const packaged = join(output, "workbench");
  assert.equal(existsSync(join(packaged, "node_modules")), false);
  assert.equal(existsSync(join(packaged, "workbench/.local-collections")), false);
  const show = spawnSync(
    process.execPath,
    [join(packaged, "bin/workbench.mjs"), "collection", "inspect", join(packaged, "collections/benchd/1")],
    {
      cwd: packaged,
      encoding: "utf8",
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: packaged },
    },
  );
  assert.equal(show.status, 0, show.stdout + show.stderr);
  assert.equal(JSON.parse(show.stdout).id, "benchd");
  assert.doesNotMatch(readFileSync(join(packaged, "AGENTS.md"), "utf8"), /benchd:ADR-0/);
});

test("exports reject references to omitted local decisions before publishing any files", async () => {
  const { root, base } = fixture("provider");
  decision(root, "0", "Foundational consumer policy.");
  const output = join(base, "invalid-export");
  for (const instruction of ["Apply ADR-0.", "Apply [the foundation](ADR-00.md)."]) {
    decision(root, "1", instruction);
    await assert.rejects(
      exportCollection(root, output, "provider", "1", ["1"], undefined, false, "public"),
      /outside the export/,
    );
    assert.equal(existsSync(output), false);
  }
});
