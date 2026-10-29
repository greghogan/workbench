import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureSignedToolAsset } from "./fixtures/tool-asset.mjs";
import { MaintenanceKind, MaintenanceProvider, MaintenanceState } from "../scripts/maintenance/contract.mjs";
import { MaintenanceSources } from "../scripts/maintenance/sources.mjs";
import { discoverMaintenance } from "../scripts/maintenance/plan.mjs";
import { readMaintenancePlan } from "../scripts/maintenance/apply.mjs";
import { bindPublication, recipeDigest } from "../scripts/maintenance/publication.mjs";
import { readNativeCatalogs, renderNativeArtifacts, uniqueAsset } from "../scripts/maintenance/native.mjs";
import { decodePHPReleases, parsePHPWindowsPackage } from "../scripts/maintenance/php.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("only the proof-absence review timestamp is excluded from a recipe's publication identity", () => {
  const recipe = {
    ...fixtureSignedToolAsset("tool", "1.0.0"),
    authenticationUnavailable: { checked: "2026-01-01", reason: "test", source: "https://example.test/proof" },
    checked: "2026-01-01",
    policy: { checked: "2026-01-01" },
  };
  const same = structuredClone(recipe);
  same.authenticationUnavailable.checked = "2026-02-02";
  expect(recipeDigest(same)).toBe(recipeDigest(recipe));
  for (const mutate of [
    (value: typeof recipe) => {
      value.checked = "2026-02-02";
    },
    (value: typeof recipe) => {
      value.policy.checked = "2026-02-02";
    },
    (value: typeof recipe) => {
      value.authenticationUnavailable.source += "/changed";
    },
    (value: typeof recipe) => {
      value.signature = { url: "https://example.test/signature", keys: "other.asc", signers: ["b".repeat(40)] };
    },
    (value: typeof recipe) => {
      value.strip++;
    },
    (value: typeof recipe) => {
      value.sha256 = "f".repeat(64);
    },
    (value: typeof recipe) => {
      value.filter = { revision: 1, include: ["bin/*"], required: ["bin/tool"] };
    },
  ]) {
    const changed = structuredClone(recipe);
    mutate(changed);
    expect(recipeDigest(changed)).not.toBe(recipeDigest(recipe));
  }
});

test("a publication identity is scoped to its selected tool/platform recipes, and rendering is repeatable", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-scoped-publication-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  const recipe = fixtureSignedToolAsset("example", "1.0.0");
  const catalog = {
    example: { "1.0.0": { "linux-x64": recipe } },
    other: { "1.0.0": { "win32-x64": structuredClone(recipe) } },
  };
  const path = join(root, "scripts/native-assets.json");
  writeFileSync(path, JSON.stringify(catalog));
  const target = {
    id: "example",
    name: "example",
    path: ".tool-versions",
    current: "1.0.0",
    provider: MaintenanceProvider.Tool,
    kind: MaintenanceKind.Toolchains,
  } as const;
  const release = {
    version: "1.0.0",
    reference: "https://example.test/release",
    assets: [{ name: "linux-x64.tar.gz", sha256: "b".repeat(64) }],
  };
  const sources = new MaintenanceSources(() => Promise.reject(new Error("No metadata request expected")));
  const snapshot = readNativeCatalogs(root);
  const bound = await bindPublication(snapshot, target, release, sources);
  catalog.other["1.0.0"]["win32-x64"].sha256 = "c".repeat(64);
  writeFileSync(path, JSON.stringify(catalog));
  const rebound = await bindPublication(readNativeCatalogs(root), target, release, sources);
  expect(rebound.release.artifacts).toEqual(bound.release.artifacts);
  const first = renderNativeArtifacts(snapshot, bound.artifacts);
  expect(renderNativeArtifacts(snapshot, bound.artifacts)).toEqual(first);
  expect(readFileSync(path, "utf8")).toBe(JSON.stringify(catalog));
  const conflicting = structuredClone(bound.artifacts);
  const conflict = conflicting[0];
  if (!conflict) throw new Error("Missing resolved artifact");
  conflict.recipe.sha256 = "d".repeat(64);
  expect(() => renderNativeArtifacts(snapshot, [...bound.artifacts, ...conflicting])).toThrow(
    /Conflicting native recipes/,
  );
});

test("duplicate release assets cannot choose an arbitrary publication", () => {
  const assets = [
    { name: "archive", sha256: "a".repeat(64) },
    { name: "archive", sha256: "b".repeat(64) },
  ];
  expect(() => uniqueAsset(assets, (asset) => asset.name === "archive", "archive")).toThrow(
    /Ambiguous published artifact/,
  );
});

test("PHP feeds provide validated full archive identities rather than version-only candidates", () => {
  const source = { filename: "php-8.5.1.tar.xz", sha256: "a".repeat(64) };
  expect(decodePHPReleases({ version: "8.5.1", source: [source] }, "https://example.test/index")[0]?.assets).toEqual([
    { name: source.filename, sha256: source.sha256, url: "https://www.php.net/distributions/php-8.5.1.tar.xz" },
  ]);
  for (const value of [
    { "8.5.1": {} },
    { version: "8.5.1", source: [] },
    { version: "8.5.1", source: [source, source] },
    { version: "8.5.1", source: [{ ...source, sha256: "bad" }] },
  ])
    expect(() => decodePHPReleases(value, "https://example.test/index")).toThrow(/Missing|Ambiguous|SHA-256/);
  expect(parsePHPWindowsPackage("php-8.5.1-2-nts-Win32-vs17-x64.zip")).toEqual({
    runtime: "8.5.1",
    revision: 2,
    filename: "php-8.5.1-2-nts-Win32-vs17-x64.zip",
    compiler: "vs17",
    architecture: "x64",
  });
  expect(() => parsePHPWindowsPackage("php-8.5.1-9999999999999999999-nts-Win32-vs17-x64.zip")).toThrow(
    /Invalid Windows PHP package revision/,
  );
});

test("unavailable discovery preserves sanitized network causes in the reviewable plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-maintenance-errors-"));
  roots.push(root);
  mkdirSync(join(root, "workbench"));
  writeFileSync(join(root, "workbench/projects.toml"), '[[language_root]]\npath="."\nlanguage="typescript"\n');
  writeFileSync(join(root, "workbench/config.toml"), "schema_version=1\n");
  writeFileSync(join(root, ".node-version"), "22.1.0\n");
  const plan = await discoverMaintenance(root, () =>
    Promise.reject(
      new Error("fetch failed", {
        cause: Object.assign(new Error("Connection refused: https://user:password@example.test/index?token=private"), {
          code: "ECONNREFUSED",
        }),
      }),
    ),
  );
  expect(plan.entries[0]?.state).toBe(MaintenanceState.Unavailable);
  expect(plan.entries[0]?.reason).toMatch(/fetch failed; caused by: ECONNREFUSED: Connection refused/);
  expect(plan.entries[0]?.reason).toContain("https://example.test/index");
  expect(plan.entries[0]?.reason).not.toMatch(/password|private/);
  expect(() => readMaintenancePlan(root, { ...plan, schema_version: 2 })).toThrow(/generate and review a new plan/);
  expect(readFileSync(join(root, ".node-version"), "utf8")).toBe("22.1.0\n");
});
