import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { containerStartup, validateContainerOwnership } from "../src/devcontainers.ts";

test("prebuilt workspaces require immutable images and managed builders reject inherited independent Features", () => {
  expect(() => validateContainerOwnership({ configuration: { image: "example:latest" } }, "native")).toThrow(/pinned/);
  const image = `example@sha256:${"a".repeat(64)}`;
  expect(() => validateContainerOwnership({ configuration: { image } }, "guix")).not.toThrow();
  for (const field of ["configuration", "mergedConfiguration"])
    expect(() => validateContainerOwnership({ [field]: { features: { "example/compiler": {} } } }, "nix")).toThrow(
      /Features/,
    );
  expect(() =>
    validateContainerOwnership({ configuration: { features: { "example/compiler": {} } } }, "native"),
  ).not.toThrow();
});

test.skipIf(process.platform === "win32")(
  "concurrent container startups own isolated scratch directories and remove them on success and failure",
  async () => {
    const script = `const fs = require('node:fs'); const os = require('node:os');
const path = os.tmpdir(); fs.writeFileSync(require('node:path').join(path, 'updateUID.Dockerfile'), 'owned');
process.stdout.write(JSON.stringify({path, TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP}));`;
    const results = await Promise.all(
      [0, 1].map(() => containerStartup(process.execPath, ["-e", script], process.env)),
    );
    const directories = results.map((result) => JSON.parse(result).path);
    expect(new Set(directories).size).toBe(2);
    for (const result of results) {
      const { path, ...variables } = JSON.parse(result);
      expect(variables).toEqual({ TMPDIR: path, TMP: path, TEMP: path });
      expect(existsSync(path)).toBe(false);
    }
    const root = mkdtempSync(join(tmpdir(), "workbench-container-scratch-"));
    const receipt = join(root, "directory");
    try {
      await expect(
        containerStartup(
          process.execPath,
          [
            "-e",
            'require("node:fs").writeFileSync(process.argv[1], require("node:os").tmpdir()); process.exit(9)',
            receipt,
          ],
          process.env,
        ),
      ).rejects.toThrow(/startup failed: 9/);
      expect(existsSync(readFileSync(receipt, "utf8"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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
