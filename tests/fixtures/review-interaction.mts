import { promised } from "./promised.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { consumer, distribution, provider, git as fixtureGit } from "./adoption.mjs";
import { installSelectedCollections } from "../../src/collection-install.ts";
import { approveLocalPolicy, reviewLocalPolicy } from "../../src/local-policy.ts";
import { policyCompatibility } from "../../src/policy-compatibility.ts";
import type { Mock } from "vitest";

interface ReviewState {
  answers: string[];
  question: Mock<(prompt: string) => Promise<string>>;
  terminal: boolean;
  documents: string[];
}

export function reviewFixtures(state: ReviewState) {
  let root: string;
  let stdoutWrite: import("vitest").MockInstance<typeof process.stdout.write>;
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "workbench-review-terminal-"));
    mkdirSync(join(root, "workbench/decisions"), { recursive: true });
    writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# Reviewed decision\n");
    git("init", "-q");
    writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="test"\npath="."\n');
    git("add", ".");
    state.terminal = true;
    state.answers = [];
    state.documents = [];
    state.question.mockImplementation(() => promised(() => state.answers.shift() ?? ""));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  async function localFixture() {
    rmSync(root, { recursive: true, force: true });
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    root = await consumer("demo");
    for (const kind of ["CONFIG", "DATA", "CACHE", "STATE"])
      vi.stubEnv(`WORKBENCH_${kind}_HOME`, join(root, ".git", kind.toLowerCase()));
    const source = provider(root, "machine", "1", ["Use the installed scheduler for substantial work."]);
    installSelectedCollections(root, [{ source: source.directory, sha256: source.pin.sha256 }], { scope: "local" });
    const base = join(root, "workbench/.local-collections");
    approveLocalPolicy(base, "machine", reviewLocalPolicy(base, "machine").digest, true);
    fixtureGit(root, "add", ".");
    fixtureGit(root, "commit", "-qm", "Baseline");
    const decision = join(root, "workbench/decisions/ADR-00.md");
    mkdirSync(join(root, "workbench/decisions"), { recursive: true });
    writeFileSync(
      decision,
      "---\nsummary: Staged project policy.\n---\n\n# ADR-0: Project policy\n\nUse the scheduler.\n",
    );
    git("add", ".");
    return { base, decision, receipt: policyCompatibility(root).receipt };
  }
  return {
    get root() {
      return root;
    },
    get stdoutWrite() {
      return stdoutWrite;
    },
    git,
    localFixture,
  };
}
