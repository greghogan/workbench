import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { nativeCIJobs, CIOperation } from "../scripts/ci-operations.mjs";
import { readCITargets } from "../scripts/ci-contract.mjs";

const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
const repository = resolve(import.meta.dirname, "..");
test.each([CIOperation.Integration, CIOperation.Release])(
  "%s jobs acquire tools, preserve independent failures, and reject undeclared work",
  (operation) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-ci-platform-"));
    try {
      const temporary = join(root, "temporary"),
        candidate = join(root, "candidate");
      for (const directory of ["bin", "scripts", "temporary", "candidate/workbench-artifacts"])
        mkdirSync(join(root, directory), { recursive: true });
      const targets = readCITargets(
        [".", "library"].map((path) => ({
          id: path,
          path,
          kind: "native",
          os,
          architecture: process.arch,
          environment: "native",
          checks: [],
          release: true,
          integration: true,
          phases: ["native-install", "native-check", "integration", "release"],
        })),
      );
      writeFileSync(join(root, "targets.json"), JSON.stringify(targets));
      writeFileSync(
        join(root, "bin/workbench.mjs"),
        `import {readFileSync} from 'node:fs';
const [command]=process.argv.slice(2);
if(command==='project') {}
else if(command==='check') console.log(readFileSync('targets.json','utf8'));
else if(command==='config') console.log('<unset>');
else throw new Error('Unexpected CLI operation');`,
      );
      writeFileSync(
        join(root, "scripts/ci-run.mjs"),
        `import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
const phase=process.argv[2], root=JSON.parse(process.env.CHECK_ROOTS)[0], installed='.tools-'+encodeURIComponent(root);
appendFileSync('events', JSON.stringify({phase,root})+'\\n');
if(phase==='native-install') writeFileSync(installed,'verified fixture tools');
else if(!existsSync(installed)) throw new Error('Required tools were not acquired');
if(phase!=='native-install' && process.env.WORKBENCH_CI_TARGET==='.' && process.env.FAIL_TARGET==='1') process.exitCode=2;`,
      );
      const revision = "a".repeat(40);
      writeCandidate(candidate, revision);
      const job = nativeCIJobs(targets, os, process.arch).find((entry) => entry.operation === operation);
      if (!job) throw new Error("Missing configured operation");
      const env = {
        ...process.env,
        CI_MATRIX: JSON.stringify({ os, architecture: process.arch }),
        CI_OPERATION: job.artifact,
        RUNNER_TEMP: temporary,
        WORKBENCH_CI_CANDIDATE: candidate,
        GITHUB_REPOSITORY: "owner/project",
        GITHUB_SHA: revision,
        FAIL_TARGET: "1",
      };
      const run = (extra: NodeJS.ProcessEnv = {}) =>
        spawnSync(process.execPath, [join(repository, "scripts/ci-platform.mts"), "run"], {
          cwd: root,
          env: { ...env, ...extra },
          encoding: "utf8",
        });
      const failure = run();
      expect(failure.status, failure.stdout + failure.stderr).toBe(1);
      expect(
        readFileSync(join(root, "events"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as unknown),
      ).toEqual([
        { phase: "native-install", root: "." },
        { phase: operation, root: "." },
        { phase: "native-install", root: "library" },
        { phase: operation, root: "library" },
      ]);
      const report = JSON.parse(readFileSync(join(temporary, "workbench-reports/results.json"), "utf8")) as {
        targets: { id: string; success: boolean; finished: string }[];
      };
      expect(report.targets.map(({ id, success }) => ({ id, success }))).toEqual([
        { id: ".", success: false },
        { id: "library", success: true },
      ]);
      expect(report.targets.every((result) => Number.isFinite(Date.parse(result.finished)))).toBe(true);
      writeFileSync(join(root, "events"), "");
      const rejected = run({ CI_OPERATION: "unconfigured" });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("Operation is not configured");
      expect(readFileSync(join(root, "events"), "utf8")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

function writeCandidate(candidate: string, revision: string) {
  mkdirSync(join(candidate, "workbench-artifacts"), { recursive: true });
  const bytes = Buffer.from("candidate"),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(candidate, "workbench-artifacts/workbench.tar.gz"), bytes);
  writeFileSync(join(candidate, "workbench-artifacts/SHA256SUMS"), `${sha256}  workbench.tar.gz\n`);
  writeFileSync(
    join(candidate, "candidate.json"),
    JSON.stringify({ version: 1, repository: "owner/project", revision, release: "1.2.3", sha256 }),
  );
}

test.skipIf(process.platform !== "linux")(
  "a prepared-image worker establishes its host runtime after a fresh job handoff",
  () => {
    const root = mkdtempSync(join(tmpdir(), "workbench-ci-image-handoff-"));
    try {
      const temporary = join(root, "temporary"),
        candidate = join(root, "candidate"),
        revision = "a".repeat(40);
      for (const directory of ["bin", "temporary/platform-inputs"])
        mkdirSync(join(root, directory), { recursive: true });
      const targets = readCITargets([
        {
          id: ".",
          path: ".",
          kind: "native",
          os: "linux",
          architecture: process.arch,
          environment: "native",
          checks: [],
          release: true,
          integration: true,
          phases: ["native-install", "native-check", "integration", "release"],
        },
      ]);
      writeFileSync(join(root, "targets.json"), JSON.stringify(targets));
      writeCandidate(candidate, revision);
      const image = "sha256:" + "b".repeat(64);
      writeFileSync(
        join(temporary, "platform-inputs/image.json"),
        JSON.stringify({
          version: 1,
          profile: "fixture",
          platform: "linux-" + process.arch,
          inputs: "a".repeat(64),
          reference: "registry.example/project:fixture",
          image,
          published: "registry.example/project@sha256:" + "c".repeat(64),
        }),
      );
      writeFileSync(
        join(root, "bin/workbench.mjs"),
        `
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='project') {}
else if(args[0]==='check') console.log(readFileSync('targets.json','utf8'));
else if(args[0]==='config') console.log(JSON.stringify({native:'fixture'}));
else if(args[0]==='tools' && args.includes('--devcontainer')) writeFileSync('host-runtime','verified');
else if(args[0]==='ci-image-exec') {
 if(!existsSync('host-runtime')) throw Error('Worker has no verified host container runtime');
 writeFileSync('executed.json',args[args.indexOf('--env-json')+1]);
} else throw Error('Unexpected CLI operation');
`,
      );
      const docker = join(root, "bin/docker");
      writeFileSync(
        docker,
        `#!/usr/bin/env node
if(process.argv[2]==='image' && process.argv[3]==='inspect') console.log(${JSON.stringify(image)});
else if(process.argv[2]!=='pull') throw Error('Unexpected Docker operation');
`,
      );
      chmodSync(docker, 0o755);
      const job = nativeCIJobs(targets, "linux", process.arch).find((job) => job.operation === CIOperation.Integration);
      if (!job) throw Error("Missing integration operation");
      const result = spawnSync(process.execPath, [join(repository, "scripts/ci-platform.mts"), "run"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: [join(root, "bin"), dirname(process.execPath), process.env.PATH].join(":"),
          CI_MATRIX: JSON.stringify({ os: "linux", architecture: process.arch }),
          CI_OPERATION: job.artifact,
          RUNNER_TEMP: temporary,
          WORKBENCH_CI_CANDIDATE: candidate,
          GITHUB_REPOSITORY: "owner/project",
          GITHUB_SHA: revision,
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const executed = JSON.parse(readFileSync(join(root, "executed.json"), "utf8")) as Record<string, string>;
      expect(executed.WORKBENCH_CI_OPERATION).toBe(CIOperation.Integration);
      expect(readFileSync(join(root, "host-runtime"), "utf8")).toBe("verified");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
