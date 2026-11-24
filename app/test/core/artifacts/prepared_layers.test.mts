import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { expect, test } from "vitest";
import { copyPreparedTools, splitPreparedInputs } from "../../../../scripts/split-prepared-inputs.mjs";

test("native layer partition preserves the complete layout and isolates tool bytes from download changes", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-prepared-layers-"));
  try {
    const files = {
      "cache/toolchains/node/bin/node": "node binary",
      "cache/toolchains/vcpkg/checkout/vcpkg": "prepared vcpkg",
      "cache/toolchains/xdebug/version/xdebug.so": "prepared Xdebug",
      "cache/package-managers/pnpm/version/.workbench-bootstrap": "verified package manager",
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
      chmodSync(join(source, "cache/toolchains/node/bin/node"), 0o755);
      if (process.platform !== "win32") symlinkSync("node", join(source, "cache/toolchains/node/bin/node-alias"));
      writeFileSync(join(source, "cache/downloads/composer/archive.zip"), `archive ${String(iteration)}`);
      for (const directory of ["cache/builds", "cache/dependencies"]) {
        mkdirSync(join(source, directory), { recursive: true });
        writeFileSync(join(source, directory, "disposable"), "not a release input");
      }
      linkSync(join(source, "cache/ci/cargo/bin/cargo"), join(source, "cache/ci/cargo/bin/rustc"));
      const suppliedPath = iteration === 1 ? (path: string) => path : (path: string) => relative(process.cwd(), path);
      splitPreparedInputs(suppliedPath(source), suppliedPath(tools), suppliedPath(dependencies));
      for (const [file, data] of Object.entries(files))
        expect(readFileSync(join(source, file), "utf8")).toBe(
          file.includes("archive.zip") ? `archive ${String(iteration)}` : data,
        );
      for (const directory of ["cache/builds", "cache/dependencies"]) {
        expect(existsSync(join(source, directory, "disposable"))).toBe(true);
        expect(existsSync(join(dependencies, directory))).toBe(false);
      }
      expect(existsSync(join(dependencies, "cache/toolchains/node"))).toBe(false);
      const toolchain = join(root, `toolchain-${String(iteration)}`);
      copyPreparedTools(source, toolchain);
      expect(statSync(join(toolchain, "cache/ci/cargo/bin/cargo"), { bigint: true }).ino).toBe(
        statSync(join(toolchain, "cache/ci/cargo/bin/rustc"), { bigint: true }).ino,
      );
      for (const path of [
        "cache/package-managers/pnpm/version/.workbench-bootstrap",
        "cache/toolchains/vcpkg/checkout/vcpkg",
        "cache/toolchains/xdebug/version/xdebug.so",
      ] as const) {
        expect(existsSync(join(tools, path))).toBe(false);
        expect(existsSync(join(toolchain, path))).toBe(false);
        expect(readFileSync(join(dependencies, path), "utf8")).toBe(files[path]);
      }
      expect(existsSync(join(tools, "cache/downloads"))).toBe(false);
      expect(statSync(join(tools, "cache/ci/cargo/bin/cargo"), { bigint: true }).ino).toBe(
        statSync(join(tools, "cache/ci/cargo/bin/rustc"), { bigint: true }).ino,
      );
      expect(readFileSync(join(tools, "cache/ci/cargo/bin/rustc"), "utf8")).toBe("cargo proxy");
      expect(statSync(join(tools, "cache/ci/cargo/bin/cargo"), { bigint: true }).ino).not.toBe(
        statSync(join(source, "cache/ci/cargo/bin/cargo"), { bigint: true }).ino,
      );
      expect(statSync(join(tools, "cache/toolchains/node/bin/node")).mode & 0o777).toBe(
        statSync(join(source, "cache/toolchains/node/bin/node")).mode & 0o777,
      );
      if (process.platform !== "win32")
        expect(readlinkSync(join(tools, "cache/toolchains/node/bin/node-alias"))).toBe("node");
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
    const file = join(root, "file"),
      newTools = join(root, "new-tools"),
      newDependencies = join(root, "new-dependencies");
    writeFileSync(file, "not a directory");
    expect(() => {
      splitPreparedInputs(file, newTools, newDependencies);
    }).toThrow(/directory/);
    if (process.platform !== "win32") {
      const alias = join(root, "source-link");
      symlinkSync(join(root, "source-1"), alias);
      expect(() => {
        splitPreparedInputs(alias, newTools, newDependencies);
      }).toThrow(/directory/);
    }
    expect(existsSync(newTools)).toBe(false);
    expect(existsSync(newDependencies)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
