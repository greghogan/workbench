import { required } from "../../src/core/runtime/invariants.ts";
import { approveReview } from "../../src/core/review/review-approval.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { consumer, provider, distribution } from "./adoption.mjs";
import { setConfiguration } from "../../src/core/configuration/config-command.ts";
import { configureGitHooks } from "../../src/core/projects/projects.ts";
import { validate } from "../../src/core/records/validation.ts";

export function collectionWorkflowFixtures() {
  const temporary: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function prepare() {
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = await consumer(),
      scratch = mkdtempSync(join(tmpdir(), "workbench-collection-workflow-"));
    temporary.push(root, scratch);
    setConfiguration(root, "checks.allow_empty", "true");
    const source = provider(root, "company", "1", ["First rule.\n\nMiddle rule.\n\nLast rule."]);
    const environment = { ...process.env, PATH: [join(distribution, "bin"), process.env.PATH ?? ""].join(delimiter) };
    const invoke = (cwd: string, command: string, args: readonly string[]) =>
      spawnSync(command, args, { cwd, env: environment, encoding: "utf8" });
    const cli = (cwd: string, ...args: string[]) => {
      const result = invoke(cwd, process.execPath, [join(distribution, "bin/workbench.mjs"), ...args]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.stdout;
    };
    const approve = (cwd: string) => {
      const digest = /Review digest: ([a-f0-9]{64})/.exec(cli(cwd, "review"))?.[1];
      expect(digest).toBeTruthy();
      approveReview(cwd, required(digest, "Fixture value digest"), true);
    };
    const gate = (cwd: string) => invoke(cwd, "git", ["hook", "run", "pre-commit"]);
    configureGitHooks(root, distribution);
    cli(root, "collection", "install", source.directory, "--commit", source.commit, "--sha256", source.pin.sha256);
    await validate(root);
    return { root, scratch, source, cli, approve, gate };
  }

  return { prepare, temporary };
}
