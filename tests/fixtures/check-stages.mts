import type { CheckDefinition, Config } from "../../src/core.ts";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "smol-toml";
import { afterEach, vi } from "vitest";

const distribution = resolve(import.meta.dirname, "../..");

export function stageFixtures() {
  const temporary: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of temporary.splice(0)) rmSync(root, { force: true, recursive: true });
  });
  function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-stages-")));
    temporary.push(root);
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    mkdirSync(join(root, "workbench"));
    const paths = [".", "service", "service/worker", "web"];
    const projects = paths.map((path, index) => ({ id: ["demo", "service", "worker", "web"][index], path }));
    writeFileSync(
      join(root, "workbench/projects.toml"),
      stringify({
        project: projects,
        language_root: paths.map((path) => ({ path, language: "typescript" })),
      }),
    );
    const config: Omit<Config, "check"> & {
      check: (Omit<CheckDefinition, "coverage" | "online" | "requires_setup" | "stages"> & {
        coverage?: Record<string, unknown>;
        online?: unknown;
        requires_setup?: unknown;
        stages?: unknown;
      })[];
    } = {
      schema_version: 1,
      markdown: { wrap_width: 120 },
      compatibility: { required: false },
      check: [],
      ci: { operating_systems: ["linux", "macos"], environments: [] },
    };
    for (const path of paths) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(
        join(root, path, "step.cjs"),
        `
const fs = require('node:fs');
const mode = process.argv[2];
if (mode === 'setup') fs.writeFileSync('dependency', 'ready');
else if (fs.readFileSync('dependency', 'utf8') !== 'ready') process.exit(9);
fs.appendFileSync('events', mode + '\\n');
if (mode === 'coverage' && fs.existsSync('emit-coverage')) {
  fs.mkdirSync('coverage', {recursive: true});
  const metric = {total: 2, covered: 1, skipped: 0, pct: 50};
  fs.writeFileSync('coverage/coverage-summary.json', JSON.stringify({total: {lines: metric}, 'value.ts': {lines: metric}}));
}
if (mode === 'coverage' && fs.existsSync('fail-coverage')) process.exit(31);
`,
      );
      const command = (mode: string) => [process.execPath, "step.cjs", mode];
      config.check.push(
        { name: `${path} setup`, role: "setup", path, command: command("setup") },
        {
          name: `${path} test`,
          role: "test",
          path,
          command: command("test"),
          warn_seconds: 2,
          coverage: {
            command: command("coverage"),
            stages: ["ci"],
            operating_systems: ["linux"],
            environments: ["native"],
          },
        },
        { name: `${path} build`, role: "build", path, command: command("build"), stages: [] },
      );
    }
    const save = () => {
      writeFileSync(join(root, "workbench/config.toml"), stringify(config));
    };
    save();
    const events = (path = ".") =>
      readFileSync(join(root, path, "events"), "utf8")
        .trim()
        .split("\n");
    const clear = () => {
      for (const path of paths)
        for (const file of ["events", "dependency"]) rmSync(join(root, path, file), { force: true });
    };
    return { root, config, save, events, clear };
  }
  return fixture;
}
