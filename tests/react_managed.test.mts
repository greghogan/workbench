import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

const repository = resolve(import.meta.dirname, "..");
test.skipIf(process.platform !== "linux")(
  "the managed React recipe transforms JSX without an unshipped TypeScript configuration",
  () => {
    const root = mkdtempSync(join(tmpdir(), "workbench-react-managed-"));
    const source = join(repository, "examples/frameworks/react");
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/main.tsx"), "globalThis.result = <h1>ready</h1>;");
      // A local JSX runtime fixture keeps this compiler regression independent of example installations and the network.
      mkdirSync(join(root, "node_modules/react"), { recursive: true });
      writeFileSync(
        join(root, "node_modules/react/jsx-runtime.js"),
        "export function jsx(type, props) { return { type, props }; }",
      );
      cpSync(join(source, "index.html"), join(root, "index.html"));
      const env = { ...process.env, PATH: [join(repository, "node_modules/.bin"), process.env.PATH].join(delimiter) };
      const build = spawnSync(process.execPath, [join(source, "scripts/build-managed.mjs")], {
        cwd: root,
        env,
        encoding: "utf8",
      });
      expect(build.status, build.stdout + build.stderr).toBe(0);
      const globals: { result?: unknown } = {};
      runInNewContext(readFileSync(join(root, "build/app.js"), "utf8"), globals);
      expect(globals.result).toEqual({ type: "h1", props: { children: "ready" } });
      expect(readFileSync(join(root, "build/index.html"))).toEqual(readFileSync(join(root, "index.html")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
