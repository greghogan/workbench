import { expect, test } from "vitest";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { securityFindings, formatSecurityFinding } from "../scripts/check-security-results.mjs";

const report = (results: unknown[], extra = {}) => ({
  version: "2.1.0",
  runs: [{ tool: { driver: { name: "fixture analyzer" } }, results, ...extra }],
});
test.each([false, true])("the standalone security bootstrap gates SARIF through a directory alias: %s", (alias) => {
  const actual = mkdtempSync(join(tmpdir(), "workbench-security-bootstrap-"));
  const root = alias ? actual + "-alias" : actual;
  try {
    if (alias) symlinkSync(actual, root, "junction");
    const script = join(root, "check.mjs");
    copyFileSync(resolve(import.meta.dirname, "../scripts/check-security-results.mjs"), script);
    const sarif = join(root, "results.sarif");
    writeFileSync(sarif, JSON.stringify(report([])));
    const run = () => spawnSync(process.execPath, [script, actual], { cwd: root, encoding: "utf8" });
    const clean = run();
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    expect(clean.stdout).toContain("Security analysis passed (1 SARIF report(s))");
    writeFileSync(sarif, JSON.stringify(report([{ ruleId: "fixture-rule", message: { text: "Actual finding" } }])));
    const failed = run();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("fixture-rule");
    expect(failed.stderr).toContain("Actual finding");
  } finally {
    if (alias) rmSync(root, { recursive: true, force: true });
    rmSync(actual, { recursive: true, force: true });
  }
});
test("security reports fail on findings and preserve rule identity and explanations", () => {
  expect(
    securityFindings(
      report([
        {
          ruleId: "path-injection",
          level: "error",
          message: { text: "Untrusted input reaches a filesystem operation" },
        },
      ]),
    ),
  ).toEqual([
    { tool: "fixture analyzer", rule: "path-injection", message: "Untrusted input reaches a filesystem operation" },
  ]);
  expect(securityFindings(report([{ ruleId: "warning", message: { text: "Default finding severity" } }]))).toHaveLength(
    1,
  );
});
test("security analysis distinguishes clean runs, informational results, and accepted suppressions", () => {
  expect(securityFindings(report([]))).toEqual([]);
  expect(
    securityFindings(
      report([
        { level: "note", message: { text: "Informational" } },
        { suppressions: [{ kind: "external", status: "accepted" }], message: { text: "Reviewed exception" } },
      ]),
    ),
  ).toEqual([]);
  expect(
    securityFindings(
      report([{ suppressions: [{ kind: "external", status: "underReview" }], message: { text: "Pending exception" } }]),
    ),
  ).toHaveLength(1);
});
test("missing or failed analysis cannot masquerade as a clean report", () => {
  expect(() => securityFindings({ version: "2.1.0", runs: [] })).toThrow(/runs/);
  expect(() => securityFindings(report([], { invocations: [{ executionSuccessful: false }] }))).toThrow(/failed/);
  expect(() => securityFindings({ version: "1.0", runs: [] })).toThrow(/version/);
  expect(() => securityFindings({ version: "2.1.0", runs: [{ tool: { driver: { name: "analyzer" } } }] })).toThrow(
    /results/,
  );
});

test("security findings reject malformed result kinds and bound terminal diagnostics", () => {
  expect(() => securityFindings(report([{ kind: "unknown", message: { text: "Invalid" } }]))).toThrow(/result kind/);
  expect(() =>
    securityFindings({ version: "2.1.0", runs: [{ tool: { driver: { name: " " } }, results: [] }] }),
  ).toThrow(/analyzer name/);
  const record = securityFindings(
    report([{ message: { text: "\u001b[31m" + "x".repeat(5000) + "\nsecond line" } }]),
  )[0];
  expect(record).toBeDefined();
  const finding = record ? formatSecurityFinding(record) : "";
  expect(finding).not.toMatch(/\p{Cc}/u);
  expect(finding.length).toBeLessThan(2100);
});

test("only explicit source exceptions or accepted suppressions bypass findings", () => {
  const result = (suppression: unknown) => ({ suppressions: [suppression], message: { text: "Review this warning" } });
  expect(
    securityFindings(
      report([result({ kind: "inSource", justification: "Exclusive creation rejects an existing path" })]),
    ),
  ).toEqual([]);
  expect(securityFindings(report([result({ kind: "external" })]))).toHaveLength(1);
  expect(
    securityFindings(report([result({ kind: "inSource", status: "rejected", justification: "Old exception" })])),
  ).toHaveLength(1);
});

test("open security results require triage instead of passing silently", () => {
  expect(
    securityFindings(report([{ kind: "open", message: { text: "The trust boundary needs review" } }])),
  ).toHaveLength(1);
});

test("typed findings retain primary source locations and format actionable diagnostics", () => {
  const [finding] = securityFindings(
    report([
      {
        ruleId: "unsafe-path",
        message: { text: "Untrusted path" },
        locations: [{ physicalLocation: { artifactLocation: { uri: "src/input.ts" }, region: { startLine: 42 } } }],
      },
    ]),
  );
  expect(finding).toEqual({
    tool: "fixture analyzer",
    rule: "unsafe-path",
    message: "Untrusted path",
    path: "src/input.ts",
    line: 42,
  });
  if (!finding) throw new Error("Missing finding");
  expect(formatSecurityFinding(finding)).toContain("src/input.ts:42:");
  expect(() =>
    securityFindings(
      report([{ message: { text: "Finding" }, locations: [{ physicalLocation: { region: { startLine: 0 } } }] }]),
    ),
  ).toThrow(/line/);
  expect(() => securityFindings(report([], { invocations: [{ executionSuccessful: "yes" }] }))).toThrow(
    /execution result/,
  );
  expect(() =>
    securityFindings(
      report([{ suppressions: [{ kind: "unknown", status: "accepted" }], message: { text: "Finding" } }]),
    ),
  ).toThrow(/suppression kind/);
});
