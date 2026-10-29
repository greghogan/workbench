import { expect, test } from "vitest";
import { normalizeTargets, targetExclusion } from "../src/check-targets.ts";
test("one target evaluator identifies the actual excluded dimension", () => {
  const target = normalizeTargets(
      { operating_systems: ["linux"], environments: ["native"], architectures: ["x64"], toolchain: false },
      "fixture",
    ),
    actual = { operatingSystem: "linux", environment: "native", architecture: "x64", toolchain: false as const };
  expect(targetExclusion(target, actual)).toBeUndefined();
  for (const [key, value, message] of [
    ["operatingSystem", "windows", "operating system"],
    ["environment", "guix", "environment"],
    ["architecture", "arm64", "architecture"],
    ["toolchain", "other", "tool profile"],
  ] as const)
    expect(targetExclusion(target, { ...actual, [key]: value })).toContain(message);
  for (const invalid of [
    null,
    "native",
    [],
    { architectures: null },
    { architecture: ["x64"] },
    { architectures: [] },
    { environments: ["invalid"] },
    { operating_systems: ["linux", "linux"] },
    { toolchain: " " },
  ])
    expect(() => normalizeTargets(invalid, "fixture")).toThrow();
});
