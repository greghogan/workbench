import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { splitPreparedInputs } from "../scripts/split-prepared-inputs.mjs";

test("native layer partition preserves the complete layout and isolates tool bytes from download changes", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-prepared-layers-"));
  try {
    const files = {
      "cache/toolchains/node/bin/node": "node binary",
      "cache/ci/rustup/toolchains/rust/bin/rustc": "rust binary",
      "cache/ci/cargo/bin/cargo": "cargo proxy",
      "cache/ci/cargo/registry/cache/crate": "crate archive",
      "cache/downloads/composer/archive.zip": "composer archive",
      "state/receipt": "retained metadata",
    };
    for (const iteration of [1, 2]) {
      const source = join(root, `source-${String(iteration)}`),
        tools = join(root, `tools-${String(iteration)}`),
        dependencies = join(root, `dependencies-${String(iteration)}`),
        merged = join(root, `merged-${String(iteration)}`);
      for (const [file, data] of Object.entries(files)) {
        mkdirSync(dirname(join(source, file)), { recursive: true });
        writeFileSync(join(source, file), data);
      }
      writeFileSync(join(source, "cache/downloads/composer/archive.zip"), `archive ${String(iteration)}`);
      splitPreparedInputs(source, tools, dependencies);
      expect(existsSync(source)).toBe(false);
      expect(existsSync(join(dependencies, "cache/toolchains"))).toBe(false);
      expect(existsSync(join(tools, "cache/downloads"))).toBe(false);
      cpSync(tools, merged, { recursive: true });
      cpSync(dependencies, merged, { recursive: true });
      for (const [file, data] of Object.entries(files))
        expect(readFileSync(join(merged, file), "utf8")).toBe(
          file.includes("archive.zip") ? `archive ${String(iteration)}` : data,
        );
    }
    expect(readFileSync(join(root, "tools-1/cache/toolchains/node/bin/node"))).toEqual(
      readFileSync(join(root, "tools-2/cache/toolchains/node/bin/node")),
    );
    expect(() => {
      splitPreparedInputs(root, join(root, "nested"), join(root, "more"));
    }).toThrow(/distinct/);
    expect(() => {
      splitPreparedInputs(join(root, "missing"), join(root, "tools-1"), join(root, "new"));
    }).toThrow(/already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
