import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { webServers } from "./fixtures/web.mjs";
import { git } from "./fixtures/adoption.mjs";
import { withEngineeringRun } from "../scripts/engineering-run.mjs";
import { optimizationInputs } from "../scripts/optimization-artifact.mjs";
const fixtures = webServers();
test("optimization provenance follows added source files and declared pins without extending a filename list", async () => {
  const root = fixtures.project(),
    builds = join(root, "build");
  mkdirSync(builds);
  writeFileSync(
    join(builds, ".workbench-build.json"),
    JSON.stringify({ checkout: root, root: ".", environment: "native", fingerprint: "a".repeat(24) }),
  );
  writeFileSync(join(root, ".gitignore"), "build/\n");
  writeFileSync(join(root, ".tool-versions"), "node 26.13.0\n");
  git(root, "add", ".gitignore", ".tool-versions");
  await withEngineeringRun(builds, "provenance-test", async (job) => {
    const recipe = resolve("scripts/optimization-artifact.mjs"),
      before = await optimizationInputs(job, root, builds, recipe);
    writeFileSync(join(root, "new source λ.ts"), "export const changed = true;\n");
    const added = await optimizationInputs(job, root, builds, recipe);
    expect(added.files["new source λ.ts"]).toMatch(/^[a-f0-9]{64}$/);
    expect(before.files).not.toHaveProperty("new source λ.ts");
    writeFileSync(join(root, ".tool-versions"), readFileSync(join(root, ".tool-versions"), "utf8") + "go 1.26.0\n");
    const updated = await optimizationInputs(job, root, builds, recipe);
    expect(updated.files[".tool-versions"]).not.toBe(before.files[".tool-versions"]);
    expect(updated.files).not.toHaveProperty("build/.workbench-build.json");
    rmSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "ignored.js"), "dependency output");
    const prepared = await optimizationInputs(job, root, builds, recipe);
    expect(prepared.files).toEqual(updated.files);
    writeFileSync(join(root, "new source λ.ts"), "export const changed = false;\n");
    expect((await optimizationInputs(job, root, builds, recipe)).files["new source λ.ts"]).not.toBe(
      prepared.files["new source λ.ts"],
    );
  });
});

test.each([".", "nested/component"])("PGO reads mounted sources while preserving host ownership (%s)", async (path) => {
  const project = fixtures.project(),
    root = join(project, path),
    builds = join(root, "build"),
    identity = {
      checkout: join(project, "unmounted-host-checkout"),
      root: path,
      environment: "guix",
      fingerprint: "a".repeat(24),
    };
  mkdirSync(builds, { recursive: true });
  writeFileSync(join(project, "workbench/projects.toml"), `[[language_root]]\npath="${path}"\nlanguage="rust"\n`);
  writeFileSync(join(builds, ".workbench-build.json"), JSON.stringify(identity));
  writeFileSync(join(root, "managed-check-inputs.json"), "{}\n");
  rmSync(join(project, ".git"), { recursive: true });
  await withEngineeringRun(builds, "mounted-provenance", async (job) => {
    const recipe = resolve("scripts/optimization-artifact.mjs"),
      before = await optimizationInputs(job, root, builds, recipe);
    expect(before.identity).toEqual(identity);
    expect(before.files["managed-check-inputs.json"]).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(join(root, "managed-check-inputs.json"), '{"changed":true}\n');
    const after = await optimizationInputs(job, root, builds, recipe);
    expect(after.files["managed-check-inputs.json"]).not.toBe(before.files["managed-check-inputs.json"]);
    expect(after.identity).toEqual(identity);
  });
});
