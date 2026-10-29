import { writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { webServers } from "./fixtures/web.mjs";
import { readChecks } from "../src/check-configuration.ts";
import { planChecks } from "../src/check-plan.ts";
const fixtures = webServers();
for (const language of ["c", "cpp", "go", "rust"])
  test(`${language} reference PGO is available explicitly without joining a consumer's ordinary CI`, () => {
    const root = fixtures.project();
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", resolve(import.meta.dirname, ".."));
    appendFileSync(join(root, "workbench/projects.toml"), `\n[[language_root]]\nlanguage="${language}"\npath="."\n`);
    writeFileSync(join(root, "workbench/automation.toml"), `[[check_suite]]\nlanguage="${language}"\npath="."\n`);
    const checks = readChecks(root),
      roles = (stage?: "ci") =>
        planChecks(root, checks, {
          environment: "native",
          operatingSystem: "linux",
          architecture: "x64",
          ...(stage ? { stage } : { role: ["pgo"] }),
        }).sessions.flatMap((session) => session.checks.map((check) => check.role));
    expect(roles("ci")).not.toContain("pgo");
    expect(roles()).toContain("pgo");
  });
test("Workbench explicitly qualifies its reference workloads in its own CI without duplicating manual PGO", () => {
  const root = resolve(import.meta.dirname, ".."),
    checks = readChecks(root),
    selected = planChecks(root, checks, {
      stage: "ci",
      environment: "native",
      operatingSystem: "linux",
      architecture: "x64",
    }).sessions.flatMap((session) => session.checks);
  expect(
    selected
      .filter((check) => check.role === "pgo-qualification")
      .map((check) => check.location)
      .sort(),
  ).toEqual(["examples/languages/c", "examples/languages/cpp", "examples/languages/go", "examples/languages/rust"]);
  expect(selected.some((check) => check.role === "pgo")).toBe(false);
});
