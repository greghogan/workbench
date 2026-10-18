import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { developmentShell } from "../src/shell.ts";
import { runCommandAsync } from "../src/checks.ts";

vi.mock("../src/checks.js", () => ({
  runCommand: vi.fn<typeof import("../src/checks.js").runCommand>(),
  runCommandAsync: vi.fn<typeof import("../src/checks.js").runCommandAsync>(),
}));

test.skipIf(process.platform === "win32")(
  "container shells preserve the adapter's mounted runtime across different directory depths",
  async () => {
    const temporary = mkdtempSync(join(tmpdir(), "workbench-shell-runtime-"));
    const root = join(temporary, "consumer"),
      runtime = join(temporary, "runtime"),
      guest = join(temporary, "guest/workspace");
    try {
      for (const path of [join(root, "workbench"), join(runtime, "languages"), join(runtime, "bundle"), guest])
        mkdirSync(path, { recursive: true });
      writeFileSync(
        join(root, "workbench/config.toml"),
        "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
      );
      writeFileSync(
        join(root, "workbench/projects.toml"),
        '[[project]]\nid="consumer"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="."\n',
      );
      writeFileSync(join(runtime, "languages/index.toml"), "");
      writeFileSync(join(runtime, "bundle/main.cjs"), 'console.log("mounted runtime");\n');
      vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", runtime);
      await developmentShell(root, ".", "devcontainer", ["bash", "-c", "workbench"]);
      const command = required(
        vi.mocked(runCommandAsync).mock.calls.at(-1),
        "Expected fixture value: vi.mocked(runCommandAsync).mock.calls.at(-1)",
      )[3];
      const result = spawnSync(required(command[0], "Expected fixture value"), command.slice(1), {
        cwd: guest,
        env: { ...process.env, WORKBENCH_PROJECT_ROOT: guest, WORKBENCH_DISTRIBUTION_ROOT: runtime },
        encoding: "utf8",
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("mounted runtime");
    } finally {
      vi.unstubAllEnvs();
      vi.clearAllMocks();
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
