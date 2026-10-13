import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "smol-toml";
import { afterEach, expect, test, vi } from "vitest";
import { toolProfiles, selectedToolProfile, toolProfileEnvironment } from "../src/tool-profiles.ts";
import { validateToolProfiles } from "../src/profile-schema.ts";

const temporary = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(profiles) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-tools-")));
  temporary.push(root);
  mkdirSync(join(root, "workbench"));
  mkdirSync(join(root, "app"));
  writeFileSync(
    join(root, "workbench/config.toml"),
    stringify({
      schema_version: 1,
      markdown: { wrap_width: 120 },
      compatibility: { required: false },
      toolchains: { profiles },
    }),
  );
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="example"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="app"\n',
  );
  return root;
}
const profile = { name: "node-22", paths: ["app"], tools: { node: "22.23.3" } };
test("tool profiles select whole registered roots and bind only recursive commands in their owning checkout", () => {
  const root = fixture([profile]);
  const other = fixture([]);
  expect(toolProfiles(root)).toEqual([profile]);
  expect(selectedToolProfile(join(root, "app"), "node-22")).toEqual(profile);
  const env = toolProfileEnvironment(join(root, "app"), "node-22");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  expect(selectedToolProfile(join(root, "app"))).toEqual(profile);
  expect(selectedToolProfile(join(other, "app"))).toBeUndefined();
  expect(() => selectedToolProfile(root, "node-22")).toThrow(/does not select/);
  expect(() => selectedToolProfile(join(root, "app"), "missing")).toThrow(/unknown tool profile/);
});
test("profile validation rejects undeclared roots, conflicting compilers, loose versions and unsupported platforms", () => {
  for (const value of [
    { ...profile, paths: ["../escape"] },
    { ...profile, tools: { node: "22" } },
    { ...profile, compiler: "gcc", tools: { clang: "23.1.3" } },
    { ...profile, platforms: ["windows-arm64"] },
    { ...profile, paths: ["app", "app"] },
    { ...profile, unknown: true },
  ])
    expect(() => validateToolProfiles([value], "profiles")).toThrow();
  expect(() => toolProfiles(fixture([{ ...profile, paths: ["missing"] }]))).toThrow(/unknown language root/);
});
