import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { collectToolingArtifacts } from "../scripts/build-tooling.mts";

test("relocated managed-input helpers share their parser runtime without source or development dependencies", () => {
  const distribution = resolve(import.meta.dirname, ".."),
    root = mkdtempSync(join(tmpdir(), "workbench-runtime-helpers-"));
  try {
    for (const artifact of collectToolingArtifacts(distribution)) {
      if (artifact.category !== "runtime" || !artifact.output) continue;
      const target = join(root, artifact.output);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(distribution, artifact.output), target);
    }
    writeFileSync(
      join(root, "Cargo.lock"),
      `version = 4\n[[package]]\nname = "fixture"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${"a".repeat(64)}"\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import {pnpmPackages} from './scripts/pnpm-lock.mjs';
      import {rustInputs} from './scripts/managed-inputs.mjs';
      import './scripts/managed-check-inputs.mjs';
      import './scripts/pnpm-metadata.mjs';
      assert.deepEqual(Object.keys(pnpmPackages('lockfileVersion: "9.0"\\npackages:\\n  fixture@1.0.0: {}\\n')), ['fixture@1.0.0']);
      assert.match(rustInputs(process.cwd()), /rust-fixture-1.0.0/);
    `,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
