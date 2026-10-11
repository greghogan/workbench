import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { rubyMinimum, phpMinimum } from "../src/script-language-config.ts";
import { bundlerVersion } from "../src/ruby-manager.ts";
import { rubyCoverageSummary } from "../scripts/ruby-coverage.mjs";
import { sevenZipMembers } from "../src/seven-zip.ts";
import { artifactLimits } from "../src/artifact-streams.ts";
import { lockedQueries } from "../src/advisories.ts";
import { ciMatrix } from "../src/ci.ts";
import { nativeTools, assetFor } from "../src/native-assets.ts";
const repository = resolve(import.meta.dirname, "..");
const temporary = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-script-languages-"));
  temporary.push(root);
  return root;
}
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Ruby support is literal and never evaluates a gem specification", () => {
  const root = fixture();
  expect(() => rubyMinimum(root)).toThrow(/one root gemspec/);
  const path = join(root, "sample.gemspec");
  for (const source of ['spec.required_ruby_version = ">=3.3.12"', "spec.required_ruby_version = '>= 3.3.12'"]) {
    writeFileSync(path, source);
    expect(rubyMinimum(root)).toBe("3.3.12");
  }
  for (const source of [
    'spec.required_ruby_version = ">=3.3"',
    "spec.required_ruby_version = calculate()",
    'spec.required_ruby_version = ">=3.3.12"\nspec.required_ruby_version = ">=3.4.11"',
  ]) {
    writeFileSync(path, source);
    expect(() => rubyMinimum(root)).toThrow(/one literal/);
  }
  writeFileSync(join(root, "Gemfile.lock"), "GEM\n\nBUNDLED WITH\n   4.0.22\n");
  expect(bundlerVersion(root)).toBe("4.0.22");
  writeFileSync(join(root, "Gemfile.lock"), "BUNDLED WITH\n   latest\n");
  expect(() => bundlerVersion(root)).toThrow(/exact version/);
});

test("PHP resolution platform must equal its literal application minimum", () => {
  const root = fixture();
  const path = join(root, "composer.json");
  writeFileSync(path, JSON.stringify({ require: { php: ">=8.2.34" }, config: { platform: { php: "8.2.34" } } }));
  expect(phpMinimum(root)).toBe("8.2.34");
  for (const value of [
    { require: { php: "^8.2" } },
    { require: { php: ">=8.2.34" }, config: { platform: { php: "8.5.11" } } },
  ]) {
    writeFileSync(path, JSON.stringify(value));
    expect(() => phpMinimum(root)).toThrow();
  }
});

test("Ruby coverage validates fresh suites, source containment and counters", () => {
  const root = fixture();
  const file = join(root, "lib/count.rb");
  const report = {
    suite: { coverage: { [file]: { lines: [null, 1, 0], branches: { condition: { yes: 1, no: 0 } } } } },
  };
  expect(rubyCoverageSummary(report, root).total.lines).toEqual({ total: 2, covered: 1, skipped: 0, pct: 50 });
  expect(rubyCoverageSummary(report, root).total.branches.pct).toBe(50);
  expect(() => rubyCoverageSummary({}, root)).toThrow(/fresh/);
  expect(() => rubyCoverageSummary({ a: report.suite, b: report.suite }, root)).toThrow(/fresh/);
  report.suite.coverage[file].lines = [-1];
  expect(() => rubyCoverageSummary(report, root)).toThrow(/counter/);
  expect(() => rubyCoverageSummary({ suite: { coverage: { "/elsewhere/count.rb": { lines: [1] } } } }, root)).toThrow(
    /outside/,
  );
});

test("7-Zip preflight bounds and rejects unsafe archive structures", () => {
  const file = (path, size = 4, extra = "") => `Path = ${path}\nSize = ${size}\nAttributes = A\n${extra}`.trim();
  expect(sevenZipMembers(file("ruby/bin/ruby.exe")).get("ruby/bin/ruby.exe")).toBe(4);
  expect(sevenZipMembers(file("ruby\\bin\\ruby.exe")).get("ruby/bin/ruby.exe")).toBe(4);
  for (const listing of [
    file("../bad"),
    file("C:\\bad"),
    file("ruby", 4, "Symbolic Link = /tmp/bad"),
    file("a") + "\n\n" + file("A"),
    file("a") + "\n\n" + file("a/b"),
    file("a", 4, "Encrypted = +"),
    file("a", 4, "Size = 5"),
  ])
    expect(() => sevenZipMembers(listing)).toThrow();
  expect(() => sevenZipMembers(file("a", 10), { ...artifactLimits, retained: 9 })).toThrow(/bounds/);
  expect(() => sevenZipMembers(file("a", 10), { ...artifactLimits, metadata: 4 })).toThrow(/metadata/);
});

test("Ruby advisory queries exclude local packages and normalize native gem variants", () => {
  const root = fixture();
  writeFileSync(
    join(root, "Gemfile.lock"),
    "PATH\n  remote: .\n  specs:\n    local (0.1.0)\n\nGEM\n  remote: https://rubygems.org/\n  specs:\n    ffi (1.17.4-x86_64-linux-gnu)\n    ffi (1.17.4-x64-mingw-ucrt)\n    rake (13.4.2)\n\nPLATFORMS\n  ruby\n",
  );
  expect(lockedQueries(root, "ruby")).toEqual([
    { package: { name: "ffi", ecosystem: "RubyGems" }, version: "1.17.4" },
    { package: { name: "rake", ecosystem: "RubyGems" }, version: "13.4.2" },
  ]);
});

test("Ruby and PHP declare maintained runtime matrices and all native platform artifacts", () => {
  const matrix = ciMatrix(repository);
  for (const [language, versions] of [
    ["ruby", ["3.3.12", "3.4.11"]],
    ["php", ["8.2.34", "8.3.35", "8.4.26"]],
  ]) {
    expect(
      matrix.compatibility.include
        .filter((entry) => entry.path === `examples/languages/${language}`)
        .map((entry) => entry.version),
    ).toEqual(versions);
    const tool = nativeTools(join(repository, `examples/languages/${language}`), repository).find(
      (entry) => entry.name === language,
    );
    expect(assetFor(repository, tool)).toMatchObject({ build: language, format: "tar" });
  }
});

test("PHP advisory queries cover both locked tool graphs while excluding local verification code", () => {
  const root = fixture();
  for (const sub of [".", "tools", "tools/compat"]) {
    mkdirSync(join(root, sub), { recursive: true });
    writeFileSync(
      join(root, sub, "composer.lock"),
      JSON.stringify({
        packages: [
          { name: "local/verifier", version: "1.0.0", dist: { type: "path" } },
          { name: "vendor/shared", version: "v1.2.3", dist: { type: "zip" } },
        ],
        "packages-dev": [
          { name: "vendor/tool", version: sub === "tools/compat" ? "2.0.0" : "3.0.0", dist: { type: "zip" } },
        ],
      }),
    );
  }
  expect(lockedQueries(root, "php")).toEqual([
    { package: { name: "vendor/shared", ecosystem: "Packagist" }, version: "1.2.3" },
    { package: { name: "vendor/tool", ecosystem: "Packagist" }, version: "3.0.0" },
    { package: { name: "vendor/tool", ecosystem: "Packagist" }, version: "2.0.0" },
  ]);
  const inventory = JSON.parse(readFileSync(join(repository, "scripts/native-assets.json"), "utf8"));
  for (const language of ["ruby", "php"])
    for (const hosts of Object.values(inventory[language])) {
      expect(Object.keys(hosts).sort()).toEqual(["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"]);
      for (const asset of Object.values(hosts)) {
        expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(Boolean(asset.signature) !== Boolean(asset.authenticationUnavailable)).toBe(true);
      }
    }
});
