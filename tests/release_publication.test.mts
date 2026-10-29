import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, test } from "vitest";

test.skipIf(process.platform === "win32")(
  "release promotion preserves the exact tested bytes, is repeatable, and rejects changed published assets",
  () => {
    const root = mkdtempSync(join(tmpdir(), "workbench-release-promotion-"));
    try {
      const repository = "owner/project";
      const source = join(root, "source");
      mkdirSync(source);
      const release = "1.2.3";
      writeFileSync(join(source, "package.json"), JSON.stringify({ version: release }));
      const git = (...args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8" });
      git("init", "--quiet");
      git("add", "package.json");
      git(
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      );
      const revision = git("rev-parse", "HEAD").trim();
      const fixture = join(root, "fixture"),
        commands = join(root, "bin");
      mkdirSync(fixture);
      mkdirSync(commands);
      cpSync(resolve(import.meta.dirname, "fixtures/release-gh.mjs"), join(commands, "gh"));
      chmodSync(join(commands, "gh"), 0o755);
      const artifact = "workbench-candidate-123-1",
        candidate = join(fixture, artifact);
      const bytes = Buffer.from("exact tested archive; this content is never executed");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      mkdirSync(join(candidate, "workbench-artifacts"), { recursive: true });
      writeFileSync(join(candidate, "workbench-artifacts/workbench.tar.gz"), bytes);
      writeFileSync(join(candidate, "workbench-artifacts/SHA256SUMS"), `${sha256}  workbench.tar.gz\n`);
      const metadata = { version: 1, repository, revision, release, sha256 };
      writeFileSync(join(candidate, "candidate.json"), JSON.stringify(metadata));
      const proof = join(fixture, "release-ready-123-2");
      mkdirSync(proof);
      writeFileSync(
        join(proof, "release-ready.json"),
        JSON.stringify({ ...metadata, artifact, run: "123", attempt: "2" }),
      );
      writeFileSync(
        join(fixture, "run.json"),
        JSON.stringify({
          id: 123,
          status: "completed",
          conclusion: "success",
          head_branch: "main",
          event: "push",
          path: ".github/workflows/checks.yml",
          repository: { full_name: repository },
          head_repository: { full_name: repository },
          head_sha: revision,
          run_attempt: 2,
        }),
      );
      const env = {
        ...process.env,
        PATH: commands + delimiter + (process.env.PATH ?? ""),
        RELEASE_FIXTURE: fixture,
        RUNNER_TEMP: root,
        GITHUB_REF: "refs/heads/main",
        GITHUB_REPOSITORY: repository,
      };
      const promote = () =>
        spawnSync(process.execPath, [resolve(import.meta.dirname, "../scripts/publish-release.mts"), "123"], {
          cwd: source,
          env,
          encoding: "utf8",
        });
      writeFileSync(join(fixture, "outages.json"), JSON.stringify({ metadata: 1, download: 1 }));
      const first = promote();
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(readFileSync(join(fixture, "assets/workbench.tar.gz"))).toEqual(bytes);
      const state = () => JSON.parse(readFileSync(join(fixture, "state.json"), "utf8")) as { draft: boolean };
      expect(state().draft).toBe(false);
      const retry = promote();
      expect(retry.status, retry.stdout + retry.stderr).toBe(0);
      const events = readFileSync(join(fixture, "events"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(events.filter((args) => args[0] === "release" && args[1] === "upload")).toHaveLength(2);
      expect(events.filter((args) => args[0] === "release" && args[1] === "create")).toHaveLength(1);
      // A partial owned draft resumes only its missing asset, then verifies and publishes the same bytes.
      const draft = JSON.parse(readFileSync(join(fixture, "state.json"), "utf8")) as {
        draft: boolean;
        assets: { name: string }[];
      };
      draft.draft = true;
      draft.assets = draft.assets.filter((asset) => asset.name !== "SHA256SUMS");
      rmSync(join(fixture, "assets/SHA256SUMS"));
      writeFileSync(join(fixture, "state.json"), JSON.stringify(draft));
      const resumed = promote();
      expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
      expect(state().draft).toBe(false);
      expect(readFileSync(join(fixture, "assets/workbench.tar.gz"))).toEqual(bytes);
      writeFileSync(join(fixture, "assets/workbench.tar.gz"), "changed published asset");
      const rejected = promote();
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("differs from the tested archive");
      expect(readFileSync(join(fixture, "assets/workbench.tar.gz"), "utf8")).toBe("changed published asset");
      expect(state().draft).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
