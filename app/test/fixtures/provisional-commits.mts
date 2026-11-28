import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { consumer, distribution, git } from "./adoption.mjs";
import { configureGitHooks } from "../../src/core/projects/projects.ts";
import { synchronize } from "../../src/core/records/sync.ts";
import { checkDistribution } from "./check-distribution.mjs";
import {
  AgentReviewKind,
  proposedAgentReview,
  recordAgentReview,
  reviewIdentity,
} from "../../src/core/review/agent-review.ts";

export function provisionalFixtures() {
  const temporary: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  async function fixture() {
    const state = mkdtempSync(join(tmpdir(), "workbench-provisional-state-"));
    temporary.push(state);
    for (const kind of ["DATA", "CONFIG", "STATE", "CACHE"]) vi.stubEnv(`WORKBENCH_${kind}_HOME`, join(state, kind));
    const runtime = checkDistribution(state);
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", runtime);
    const root = await consumer("demo");
    temporary.push(root);
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.invalid");
    const env = {
      ...process.env,
      PATH: join(runtime, "bin") + delimiter + (process.env.PATH ?? ""),
      WORKBENCH_PROJECT_ROOT: root,
    };
    const invoke = (command: string, args: string[], input?: string) =>
      spawnSync(command, args, { cwd: root, env, encoding: "utf8", input });
    const cli = (...args: string[]) => invoke(process.execPath, [join(runtime, "bin/workbench.mjs"), ...args]);
    const run = (...args: string[]) => {
      const result = cli(...args);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.stdout;
    };
    const review = () => {
      const proposed = proposedAgentReview(root, AgentReviewKind.Changes, { staged: true });
      recordAgentReview(
        root,
        AgentReviewKind.Changes,
        { staged: true },
        {
          expected: reviewIdentity(proposed),
          summary: "Reviewed the test-owned changes",
          verification: "Fixture checks exercise the selected source",
        },
      );
    };
    return { root, state, runtime, invoke, cli, run, review };
  }

  async function project() {
    const f = await fixture();
    const config = join(f.root, "workbench/config.toml");
    writeFileSync(
      config,
      readFileSync(config, "utf8") +
        '\n[review]\nchanges=true\n\n[[check]]\nname="Source quality"\nrole="lint"\ncommand=["node","quality.cjs"]\n',
    );
    writeFileSync(join(f.root, "source.txt"), "good");
    writeFileSync(
      join(f.root, "quality.cjs"),
      "if(require('node:fs').readFileSync('source.txt','utf8')==='bad')process.exit(7);\n",
    );
    synchronize(f.root);
    configureGitHooks(f.root, distribution);
    git(f.root, "add", ".");
    git(f.root, "commit", "-qm", "baseline");
    const base = git(f.root, "rev-parse", "HEAD");
    git(f.root, "config", "trailer.separators", "=");
    const path = "workbench/decisions/ADR-00.md";
    mkdirSync(join(f.root, "workbench/decisions"), { recursive: true });
    const decision = (version: string) =>
      `---\nsummary: Fixture decision.\n---\n\n# ADR-0: Fixture policy\n\n${version}.\n`;
    const stage = (version: string) => {
      writeFileSync(join(f.root, path), decision(version));
      synchronize(f.root);
      git(f.root, "add", ".");
    };
    stage("First draft");
    return { f, base, stage, path };
  }
  return { fixture, project };
}
