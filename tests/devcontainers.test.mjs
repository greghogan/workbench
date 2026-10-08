import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { containerStartup } from "../src/devcontainers.ts";

test.skipIf(process.platform === "win32")(
  "container startup cleans up attached clients on success and failure without waiting for their output pipes",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "workbench-container-processes-"));
    const script = join(root, "startup.cjs");
    const receipt = join(root, "stopped");
    // The attached client inherits output pipes and deliberately outlives its parent, like docker run -a.
    writeFileSync(
      script,
      `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => { require("node:fs").writeFileSync(process.argv[1], "stopped"); process.exit(0); }); process.stdout.write("ready\\\\n"); setInterval(() => {}, 1000);', process.argv[2]], {stdio: ['ignore', 'pipe', 'inherit']});
child.stdout.once('data', () => { process.stdout.write(JSON.stringify({outcome: 'success'})); process.exit(Number(process.argv[3])); });
`,
    );
    try {
      expect(JSON.parse(await containerStartup(process.execPath, [script, receipt, "0"], process.env))).toEqual({
        outcome: "success",
      });
      expect(readFileSync(receipt, "utf8")).toBe("stopped");
      rmSync(receipt);
      await expect(containerStartup(process.execPath, [script, receipt, "9"], process.env)).rejects.toThrow(
        /startup failed: 9/,
      );
      expect(readFileSync(receipt, "utf8")).toBe("stopped");
      await expect(containerStartup(join(root, "missing"), [], process.env)).rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
