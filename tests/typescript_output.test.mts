import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

test("external TypeScript output retains dependencies and package self references without stale modules", () => {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-typescript-output-"));
  const root = join(temporary, "project");
  const output = join(temporary, "cache with spaces");
  const repository = resolve(import.meta.dirname, "..");
  try {
    for (const path of ["src", "node_modules/@typescript", "node_modules/dependency"])
      mkdirSync(join(root, path), { recursive: true });
    symlinkSync(
      join(repository, "node_modules/@typescript/native"),
      join(root, "node_modules/@typescript/native"),
      "junction",
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", type: "module", exports: "./build/src/main.js" }),
    );
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "NodeNext", rootDir: ".", strict: true }, include: ["src"] }),
    );
    writeFileSync(
      join(root, "node_modules/dependency/package.json"),
      JSON.stringify({ type: "module", exports: { types: "./index.d.ts", default: "./index.js" } }),
    );
    writeFileSync(join(root, "node_modules/dependency/index.js"), "export const value = 41;\n");
    writeFileSync(join(root, "node_modules/dependency/index.d.ts"), "export const value: number;\n");
    writeFileSync(join(root, "src/main.ts"), 'import { value } from "dependency"; export const answer = value + 1;\n');
    writeFileSync(join(root, "src/obsolete.ts"), "export const obsolete = true;\n");
    const build = () => {
      const result = spawnSync(
        process.execPath,
        [join(repository, "examples/languages/typescript/scripts/build.mjs")],
        {
          cwd: root,
          env: { ...process.env, WORKBENCH_BUILD_DIR: output },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    };
    build();
    const stage = join(output, "typescript");
    const run = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", 'import { answer } from "fixture"; console.log(answer)'],
      { cwd: stage, encoding: "utf8" },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe("42\n");
    expect(existsSync(join(root, "build"))).toBe(false);
    expect(existsSync(join(stage, "build/src/obsolete.js"))).toBe(true);
    rmSync(join(root, "src/obsolete.ts"));
    build();
    expect(existsSync(join(stage, "build/src/obsolete.js"))).toBe(false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
