import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { cacheProjectFixture } from "./fixtures/cache-project.mjs";
import { maintenanceMain } from "../scripts/maintenance/main.mjs";

afterEach(() => {
  vi.unstubAllGlobals();
});

test.each([true, false])(
  "development updates request safe cleanup only when automatic pruning is enabled: %s",
  async (enabled) => {
    const f = cacheProjectFixture();
    try {
      const root = f.project("maintenance");
      mkdirSync(join(root, "scripts"));
      for (const name of ["native-assets.json", "llvm-assets.json"]) writeFileSync(join(root, "scripts", name), "{}\n");
      writeFileSync(
        join(root, "workbench/projects.toml"),
        '[[project]]\nid="maintenance"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="."\n',
      );
      const distribution = resolve(import.meta.dirname, "..");
      const packageManager = (
        JSON.parse(readFileSync(join(distribution, "package.json"), "utf8")) as { packageManager: string }
      ).packageManager;
      writeFileSync(join(root, ".node-version"), readFileSync(join(distribution, ".node-version")));
      writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager, dependencies: { library: "1.0.0" } }));
      mkdirSync(join(f.base, "config"), { recursive: true });
      writeFileSync(join(f.base, "config/config.toml"), `[cache]\nauto_prune=${String(enabled)}\n`);
      const old = f.install("4.0.1"),
        replacement = f.install("4.0.2");
      f.working(root, old);
      const previous = f.result(root, old);
      f.working(root, replacement);
      vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({ versions: { "2.0.0": {} } }))));
      const run = (command: { command: string; arguments: string[]; cwd: string }) => {
        const result = spawnSync(command.command, command.arguments, {
          cwd: command.cwd,
          env: process.env,
          encoding: "utf8",
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        return Promise.resolve(result.stdout);
      };
      const plan = join(f.base, "plan.json");
      await maintenanceMain(["plan", "--kind", "dependencies", "--output", plan], root, run);
      expect(existsSync(previous.directory)).toBe(true);
      await maintenanceMain(["apply", plan], root, run);
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies: { library: string };
      };
      expect(manifest.dependencies.library).toBe("2.0.0");
      expect(existsSync(previous.directory)).toBe(!enabled);
      expect(existsSync(replacement.directory)).toBe(true);
    } finally {
      f.close();
    }
  },
);
