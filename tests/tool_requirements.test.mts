import { expect, test } from "vitest";
import { resolve } from "node:path";
import { toolRequirement, isToolRequirement, matchesToolRequirement } from "../src/tool-requirements.ts";

test("tool requirements normalize Miri while retaining exact native destinations", () => {
  expect(toolRequirement({ name: "miri", version: "nightly-2026-10-01" })).toEqual({
    tool: "rust",
    version: "nightly-2026-10-01",
  });
  const directory = resolve("toolchain");
  expect(toolRequirement({ name: "ruby", version: "4.0.7" }, directory)).toEqual({
    tool: "ruby",
    version: "4.0.7",
    directory,
  });
});

test("requirement validation distinguishes optional destinations from invalid values", () => {
  for (const invalid of [
    null,
    [],
    {},
    { tool: 1, version: "1" },
    { tool: "ruby", version: false },
    { tool: "ruby", version: "4.0.7", directory: "relative" },
  ] as const)
    expect(isToolRequirement(invalid)).toBe(false);
  expect(isToolRequirement({ tool: "ruby", version: "4.0.7" })).toBe(true);
  expect(isToolRequirement({ tool: "ruby", version: "4.0.7", directory: resolve("tools") })).toBe(true);
  expect(isToolRequirement({ tool: "", version: "" })).toBe(false);
  expect(isToolRequirement({ tool: "ruby", version: "" })).toBe(false);
});

test("Workbench matches the owned destination and runtime managers match tool and version", () => {
  const directory = resolve("native"),
    requirement = { tool: "ruby", version: "4.0.7", directory };
  const native = { ...requirement, provider: "workbench" };
  expect(matchesToolRequirement(requirement, native)).toBe(true);
  expect(matchesToolRequirement({ ...requirement, directory: resolve("other") }, native)).toBe(false);
  for (const provider of ["uv", "rustup"]) {
    expect(matchesToolRequirement(requirement, { ...native, provider, directory: resolve("managed") })).toBe(true);
    expect(matchesToolRequirement({ ...requirement, version: "different" }, { ...native, provider })).toBe(false);
    expect(matchesToolRequirement({ ...requirement, tool: "other" }, { ...native, provider })).toBe(false);
  }
});
