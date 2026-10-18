import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, test } from "vitest";

const distribution = resolve(import.meta.dirname, "..");

test.skipIf(process.platform === "win32").each(
  ["c", "cpp"].flatMap((language) => [
    [language, false],
    [language, true],
  ]),
)("%s preserves the compiler failure when diagnostic collection is blocked: %s", (language, blocked) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-cmake-diagnostics-")));
  try {
    for (const name of ["bin", "src", "include", "tests", "workbench"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "workbench/quality.json"), "{}");
    writeFileSync(
      join(root, "bin/cmake"),
      `#!/bin/sh
mkdir -p "$WORKBENCH_BUILD_DIR/debug/vcpkg_buildtrees/detect_compiler"
printf 'linker cannot find the selected Windows SDK\\n' > "$WORKBENCH_BUILD_DIR/debug/vcpkg_buildtrees/detect_compiler/config-out.log"
exit 42
`,
      { mode: 0o755 },
    );
    if (blocked) writeFileSync(join(root, "coverage"), "blocked output");
    const result = spawnSync(
      process.execPath,
      [join(distribution, "examples/languages", language, "scripts/check.mjs"), "build", distribution],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: join(root, "bin") + delimiter + (process.env.PATH ?? ""),
          WORKBENCH_BUILD_DIR: join(root, "build"),
          WORKBENCH_MANAGED_COMPILER: "1",
        },
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cmake failed: 42");
    if (blocked) expect(result.stderr).toContain("Could not retain compiler detection logs");
    else {
      expect(result.stderr).toContain("linker cannot find the selected Windows SDK");
      expect(readFileSync(join(root, "coverage/cmake/debug/config-out.log"), "utf8")).toBe(
        "linker cannot find the selected Windows SDK\n",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
