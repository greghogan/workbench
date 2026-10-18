import { required } from "../src/invariants.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { exactJavaVersion, javaSupport } from "../src/java-config.ts";
import { lockedQueries } from "../src/advisories.ts";
import { ciMatrix } from "../src/ci.ts";
import { nativeTools, assetFor } from "../src/native-assets.ts";
import { javaCoverageSummary } from "../scripts/java-coverage.mjs";

const repository = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-java-"));
  temporary.push(root);
  return root;
}
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Java support keeps full upstream build pins separate from compiler release", () => {
  for (const pin of ["17.0.20.1+1", "21.0.12.1+1", "25.0.4.1+1", "27+35"])
    expect(exactJavaVersion(pin, "test")).toBe(pin);
  for (const pin of ["25", "25.0.4", "25+", "25.0+1", 25])
    expect(() => exactJavaVersion(pin, "test")).toThrow(/exact Java/);
  const root = fixture();
  const pom = (release: string | number, minimum: string, extra = "") =>
    `<project><properties><maven.compiler.release>${String(release)}</maven.compiler.release><java.minimum>${minimum}</java.minimum>${extra}</properties></project>`;
  for (const [xml, error] of [
    [pom(11, "11.0.29+7"), /at least 17/],
    [pom(17, "21.0.12.1+1"), /agree/],
    [pom("${target}", "17.0.20.1+1"), /at least 17/],
    [pom(17, "17.0.20.1+1", "<java.minimum>17.0.20.1+1</java.minimum>"), /one literal/],
    ["<project/>", /one literal/],
    [
      `<project><profiles><profile>${pom(17, "17.0.20.1+1").replace(/<\/?project>/g, "")}</profile></profiles></project>`,
      /one literal/,
    ],
  ] as const) {
    writeFileSync(join(root, "pom.xml"), required(xml, "Expected fixture value"));
    expect(() => javaSupport(root)).toThrow(error);
  }
  writeFileSync(join(root, "pom.xml"), pom(17, "17.0.20.1+1") + "<!-- <java.minimum>ignored</java.minimum> -->");
  expect(javaSupport(root)).toEqual({ release: 17, minimum: "17.0.20.1+1" });
});

test("Java and JavaScript examples use development releases and verified native tools", () => {
  const matrix = ciMatrix(repository);
  expect(
    matrix.compatibility.include
      .filter((entry) => entry.path === "examples/languages/java")
      .map((entry) => entry.version),
  ).toEqual([]);
  expect(
    matrix.compatibility.include
      .filter((entry) => entry.path === "examples/languages/javascript")
      .map((entry) => entry.version),
  ).toEqual([]);
  const tools = nativeTools(join(repository, "examples/languages/java"), repository);
  expect(tools.map((tool) => tool.name)).toEqual(["java", "maven", "node"]);
  for (const tool of tools) {
    const asset = assetFor(repository, tool);
    expect(required(asset, "Expected fixture value: asset").sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      required(asset, "Expected fixture value: asset").signature ??
        required(asset, "Expected fixture value: asset").checksums,
    ).toBeDefined();
  }
});

test("Maven advisory queries describe resolved JARs and deduplicate classifiers without querying POM metadata", () => {
  const root = fixture();
  mkdirSync(join(root, ".mvn/checksums"), { recursive: true });
  const path = join(root, ".mvn/checksums/checksums.sha256");
  const line = (name: string) => `${"a".repeat(64)}  ${name}\n`;
  writeFileSync(
    path,
    [
      "org/example/library/1.2.3/library-1.2.3.jar",
      "org/example/library/1.2.3/library-1.2.3-tests.jar",
      "org/example/plugin/2.0/plugin-2.0.jar",
      "org/example/parent/1.0/parent-1.0.pom",
    ]
      .map(line)
      .join(""),
  );
  expect(lockedQueries(root, "java")).toEqual([
    { package: { name: "org.example:library", ecosystem: "Maven" }, version: "1.2.3" },
    { package: { name: "org.example:plugin", ecosystem: "Maven" }, version: "2.0" },
  ]);
  for (const invalid of [
    "bad",
    line("../escape.jar"),
    line("library/1.0/library-1.0.jar"),
    line("org/example/a/1.0/wrong.jar"),
    line("org/example/a/1.0/a-1.01.jar"),
    line("org/example/a/1.0/a-1.0.jar").repeat(2),
  ]) {
    writeFileSync(path, invalid);
    expect(() => lockedQueries(root, "java")).toThrow(/invalid Maven/);
  }
});

test("JaCoCo summaries preserve source identities and method coverage without inventing statements", () => {
  const counters =
    '<counter type="LINE" missed="1" covered="3"/><counter type="BRANCH" missed="0" covered="2"/><counter type="METHOD" missed="0" covered="1"/>';
  const xml = `<?xml version="1.0"?><!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd"><report name="reference"><package name="org/example"><class name="Count">${counters}</class><sourcefile name="Count.java">${counters}</sourcefile></package>${counters}</report>`;
  const summary = javaCoverageSummary(xml);
  expect(required(summary.total, "Expected fixture value").lines).toEqual({
    total: 4,
    covered: 3,
    skipped: 0,
    pct: 75,
  });
  expect(
    required(
      required(summary["src/main/java/org/example/Count.java"], "Expected fixture value").functions,
      "Expected fixture value",
    ).pct,
  ).toBe(100);
  expect(required(summary.total, "Expected fixture value").statements).toBeUndefined();
  for (const invalid of [
    "<report/>",
    xml.replace("org/example", "../escape"),
    xml.replace(`<sourcefile name="Count.java">${counters}`, '<sourcefile name="Count.java">'),
    xml.replace(/<sourcefile[^>]*>[\s\S]*?<\/sourcefile>/, ""),
  ])
    expect(() => javaCoverageSummary(invalid)).toThrow();
});
