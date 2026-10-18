import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { guixImageDefinition, guixPackArguments } from "../scripts/pack-guix-image.mjs";
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
const declared = JSON.parse(
  readFileSync(new URL("../.devcontainer/guix/image.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
function fixture(value: unknown = declared) {
  const root = mkdtempSync(join(tmpdir(), "workbench-guix-image-"));
  temporary.push(root);
  mkdirSync(join(root, ".devcontainer/guix"), { recursive: true });
  writeFileSync(join(root, ".devcontainer/guix/image.json"), JSON.stringify(value));
  return root;
}
test("declared layout controls entrypoint, links, local state and account materialization", () => {
  const definition = guixImageDefinition(fixture());
  expect(definition).toEqual(declared);
  const env = {
    WORKBENCH_IMAGE_INPUTS: "a".repeat(64),
    WORKBENCH_MANAGED_CORES: "64",
    WORKBENCH_MANAGED_JOBS: "8",
    WORKBENCH_MANAGED_OUTPUT: "/output with spaces",
  };
  const args = guixPackArguments(definition, env);
  expect(args).toContain("--entry-point=bin/workbench-start");
  expect(args).toContain("--symlink=/opt/workbench-environments=opt/workbench-environments");
  expect(args).toContain("--root=/output with spaces/image-root");
  expect(args).toContain("--localstatedir");
  const changed = {
    ...definition,
    entry_point: "bin/other-start",
    local_state: false,
    symlinks: { "/bin": "custom-bin" },
  };
  const selected = guixPackArguments(changed, { ...env, WORKBENCH_MANAGED_CORES: "4", WORKBENCH_MANAGED_JOBS: "2" });
  expect(selected).toContain("--entry-point=bin/other-start");
  expect(selected).toContain("--symlink=/bin=custom-bin");
  expect(selected).not.toContain("--localstatedir");
  expect(selected).toContain("--cores=4");
  expect(selected).toContain("--max-jobs=2");
  for (const bad of [{}, { ...env, WORKBENCH_IMAGE_INPUTS: "bad" }, { ...env, WORKBENCH_MANAGED_CORES: "0" }])
    expect(() => guixPackArguments(definition, bad)).toThrow(/requires/);
});
test.each([
  null,
  [],
  { ...declared, typo: true },
  { ...declared, entry_point: "../escape" },
  { ...declared, symlinks: { relative: "bin" } },
  { ...declared, symlinks: { "/bin": "../escape" } },
  { ...declared, materialize: ["/etc/shadow"] },
  { ...declared, materialize: ["/etc/passwd", "/etc/passwd"] },
])("malformed image definitions cannot construct a pack", (value) => {
  expect(() => guixImageDefinition(fixture(value))).toThrow(/invalid Guix image definition/);
});
