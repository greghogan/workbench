import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";

const distribution = resolve(import.meta.dirname, "..");
const failures = [
  {
    file: "bt/detect_compiler/config-out.log",
    retained: "vcpkg_buildtrees/detect_compiler/config-out.log",
    message: "linker cannot find the selected Windows SDK",
  },
  {
    file: "bt/yyjson/config-x64-workbench-mvsc-windows-out.log",
    retained: "vcpkg_buildtrees/yyjson/config-x64-workbench-mvsc-windows-out.log",
    message: "dependency configure cannot execute its selected compiler",
  },
  {
    file: "vcpkg-manifest-install.log",
    retained: "vcpkg-manifest-install.log",
    message: "dependency installation failed after compiler detection",
  },
];

test
  .skipIf(process.platform === "win32")
  .each(
    ["c", "cpp"].flatMap((language) =>
      failures.flatMap((failure) => [false, true].map((blocked) => ({ language, failure, blocked }))),
    ),
  )(
  "$language preserves $failure.file when diagnostic collection is blocked: $blocked",
  ({ language, failure, blocked }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-cmake-diagnostics-")));
    try {
      for (const name of ["bin", "src", "include", "tests", "workbench"]) mkdirSync(join(root, name));
      writeFileSync(join(root, "workbench/quality.json"), "{}");
      writeFileSync(
        join(root, "bin/cmake"),
        `#!/bin/sh
mkdir -p "$WORKBENCH_BUILD_DIR/debug/${dirname(failure.file)}"
printf '${failure.message}\\n' > "$WORKBENCH_BUILD_DIR/debug/${failure.file}"
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
      expect(result.stderr).toMatch(/cmake failed \(pid=\d+, status=42, signal=null\)/);
      if (blocked) expect(result.stderr).toContain("Could not retain CMake failure logs");
      else {
        expect(result.stderr).toContain(failure.message);
        expect(readFileSync(join(root, "coverage/cmake/debug", failure.retained), "utf8")).toBe(failure.message + "\n");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
