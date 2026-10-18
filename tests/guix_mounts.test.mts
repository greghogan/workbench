import { required } from "../src/invariants.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runCommand } from "../src/checks.ts";

const state = vi.hoisted(() => ({ calls: [] as [string, readonly string[], { cwd?: string }][] }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: (...args: [string, readonly string[], { cwd?: string }]) => {
    state.calls.push(args);
    return { status: 0 };
  },
}));
let temporary: string;
afterEach(() => {
  vi.unstubAllEnvs();
  state.calls = [];
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});
test.skipIf(process.platform === "win32").each(["project", "nested", "external"])(
  "Guix exposes only external executable distributions as read-only (%s)",
  (location) => {
    temporary = realpathSync(mkdtempSync(join(tmpdir(), "workbench-guix-mounts-")));
    const project = join(temporary, "project");
    const runtime =
      location === "project" ? project : location === "nested" ? join(project, "runtime") : join(temporary, "runtime");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(runtime, "languages"), { recursive: true });
    writeFileSync(join(runtime, "languages/index.toml"), "");
    const directory = join(project, "app");
    mkdirSync(directory);
    writeFileSync(join(project, "channels.scm"), "root pin");
    writeFileSync(join(directory, "manifest.scm"), "");
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", runtime);
    vi.stubEnv("WORKBENCH_PREPARED", "0");
    vi.stubEnv("WORKBENCH_OFFLINE", "0");
    runCommand(directory, "fixture", ["node", "check.mjs"], "guix", project, undefined, false);
    expect(state.calls).toHaveLength(1);
    const [executable, args, options] = required(state.calls[0], "Expected Guix invocation");
    expect(executable).toBe("env");
    expect(options.cwd).toBe(directory);
    expect(args[args.indexOf("-C") + 1]).toBe(join(project, "channels.scm"));
    expect(args[args.indexOf("-m") + 1]).toBe("manifest.scm");
    writeFileSync(join(directory, "channels.scm"), "ignored nested pin");
    runCommand(directory, "fixture", ["node", "check.mjs"], "guix", project, undefined, false);
    expect(
      required(state.calls[1], "Expected fixture value: state.calls[1]")[1][
        required(state.calls[1], "Expected fixture value: state.calls[1]")[1].indexOf("-C") + 1
      ],
    ).toBe(join(directory, "channels.scm"));
    rmSync(join(project, "channels.scm"));
    expect(() => {
      runCommand(directory, "fixture", ["node", "check.mjs"], "guix", project, undefined, false);
    }).not.toThrow();
    rmSync(join(directory, "channels.scm"));
    expect(() => {
      runCommand(directory, "fixture", ["node", "check.mjs"], "guix", project, undefined, false);
    }).toThrow(/channels.scm/);
    expect(args).toContain("WORKBENCH_DISTRIBUTION_MATERIALIZED=1");
    expect(args.filter((value: string) => value.startsWith("--expose="))).toEqual(
      location === "external" ? [`--expose=${runtime}`] : [],
    );
    expect(args.slice(-2)).toEqual(["node", "check.mjs"]);
  },
);
