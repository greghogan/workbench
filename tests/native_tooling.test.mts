import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "vitest";
import {
  nativeSources,
  toolingArtifact,
  untrackedToolingOutput,
  unshippedToolingOutput,
} from "../scripts/tooling-artifacts.mts";
import { verifyNativeTooling } from "../scripts/runtime-dependencies.mjs";
import { buildTooling } from "../scripts/build-tooling.mts";

test("new helpers are neither shipped nor committed implicitly, while bootstrap tracking is independent of shipment", () => {
  expect(toolingArtifact("scripts/future-tool.mts")).toMatchObject({ tracked: false, shipped: false });
  expect(toolingArtifact("scripts/check-bootstrap.mts")).toMatchObject({ tracked: true, shipped: false });
  expect(untrackedToolingOutput("scripts/check-bootstrap.mjs")).toBe(false);
  expect(unshippedToolingOutput("scripts/check-bootstrap.mjs")).toBe(true);
  expect(toolingArtifact("scripts/owned-child.mts")).toMatchObject({ tracked: true, shipped: true });
  for (const source of nativeSources)
    expect(toolingArtifact(source)).toMatchObject({ tracked: false, shipped: false, emission: "none", output: null });
});
test("source-run modules reject compiler-only syntax and do not regenerate obsolete JavaScript", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-native-tooling-"));
  try {
    mkdirSync(join(root, "scripts"));
    const source = join(root, "scripts/ci-plan.mts"),
      output = join(root, "scripts/ci-plan.mjs");
    writeFileSync(source, "enum Mode { First }\nconsole.log(Mode.First);\n");
    expect(() => {
      verifyNativeTooling(root);
    }).toThrow(/erasableSyntaxOnly/);
    writeFileSync(source, 'const value: string = "direct TypeScript"; console.log(value);\n');
    verifyNativeTooling(root);
    writeFileSync(
      output,
      '// Generated from ci-plan.mts; edit the TypeScript source.\nthrow new Error("stale output");\n',
    );
    await expect(buildTooling({ root, operation: "verify" })).rejects.toThrow(/obsolete/);
    await buildTooling({ root, operation: "build" });
    expect(existsSync(output)).toBe(false);
    await buildTooling({ root, operation: "prepare-development" });
    expect(existsSync(output)).toBe(false);
    const result = spawnSync(process.execPath, [source], { encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("direct TypeScript");
    writeFileSync(output, "// user-authored content\n");
    await expect(buildTooling({ root, operation: "build" })).rejects.toThrow(/Preserving unrecognized/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("CI planning runs from source before development dependency installation", () => {
  const root = resolve(import.meta.dirname, ".."),
    directory = mkdtempSync(join(tmpdir(), "workbench-native-plan-"));
  try {
    const result = spawnSync(process.execPath, [join(root, "scripts/ci-platform.mts"), "plan"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: join(directory, "output"),
        RUNNER_TEMP: directory,
        CI_MATRIX: JSON.stringify({
          os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform,
          architecture: process.arch,
          node: process.versions.node,
          paths: ["."],
          msvc: false,
        }),
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
