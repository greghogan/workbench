import { registerProject } from "../src/project-registry.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { planCI } from "../scripts/ci-plan.mts";

const repository = resolve(import.meta.dirname, "..");

test.skipIf(process.platform !== "linux").each([true, false])(
  "CI registration state stays separate from guest reports (container: %s)",
  (container) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-ci-state-"));
    try {
      const reports = join(root, "reports"),
        temporary = join(root, "temporary");
      mkdirSync(reports);
      mkdirSync(temporary);
      mkdirSync(join(root, "bin"));
      writeFileSync(
        join(root, "bin/workbench.mjs"),
        `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
mkdirSync(process.env.WORKBENCH_STATE_HOME, {recursive:true,mode:0o700});
writeFileSync(join(process.env.WORKBENCH_STATE_HOME,'registration'), 'private registration');
`,
      );
      const result = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "native-install"], {
        cwd: root,
        env: {
          ...process.env,
          CHECK_ROOTS: '["."]',
          WORKBENCH_DISTRIBUTION_ROOT: root,
          WORKBENCH_CI_TARGET: "fixture",
          WORKBENCH_DEVCONTAINER: container ? "1" : "",
          RUNNER_TEMP: reports,
          GITHUB_OUTPUT: join(root, "output"),
          TMPDIR: temporary,
        },
        encoding: "utf8",
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(join(container ? temporary : reports, "workbench-state/registration"), "utf8")).toBe(
        "private registration",
      );
      if (container) expect(existsSync(join(reports, "workbench-state"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test
  .skipIf(process.platform !== "linux")
  .each(["nix", "guix"].flatMap((builder) => [true, false].map((available) => [builder, available])))(
  "hosted %s checks require a registry image (available: %s)",
  (builder, available) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-hosted-managed-"));
    try {
      mkdirSync(join(root, "bin"));
      writeFileSync(
        join(root, "catalog.json"),
        JSON.stringify([
          {
            kind: "environment",
            id: "managed",
            path: ".",
            environment: builder,
            release: false,
            os: "linux",
            architecture: "x64",
            phases: ["environment"],
            checks: [],
          },
        ]),
      );
      writeFileSync(
        join(root, "bin/workbench.mjs"),
        `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const args=process.argv.slice(2);
appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');
if(args[0]==='project' && args[1]==='add') {}
else if(args[0]==='check') console.log(readFileSync('catalog.json','utf8'));
else if(args[0]==='config') console.log(JSON.stringify({${String(builder)}:'managed'}));
else if(args[0]==='tools') {}
else if(args[0]==='development' && args[1]==='images') {
  if(!args.includes('--require')) throw new Error('Hosted image preflight must require registry availability');
  if(process.env.IMAGE_AVAILABLE!=='true') process.exitCode=1;
}
else if(args[0]==='ci-image-acquire') {
  if(args.includes('--allow-build')) throw new Error('Managed CI must never build');
  if(process.env.IMAGE_AVAILABLE!=='true') process.exitCode=1;
  else writeFileSync(args[args.indexOf('--output')+1],JSON.stringify({version:1,profile:args[1],platform:'linux-x64',inputs:'c'.repeat(64),reference:'ghcr.io/owner/image:inputs',image:'sha256:'+'a'.repeat(64),published:'ghcr.io/owner/image@sha256:'+'b'.repeat(64)}));
} else if(args[0]==='ci-image-exec') writeFileSync('executed','verified');
else throw new Error('unexpected operation');
`,
      );
      const result = spawnSync(process.execPath, [join(repository, "scripts/ci-hosted.mts"), "environment"], {
        cwd: root,
        env: {
          ...process.env,
          CI_MATRIX: JSON.stringify({ paths: ["."], environment: builder }),
          RUNNER_TEMP: root,
          IMAGE_AVAILABLE: String(available),
        },
        encoding: "utf8",
      });
      expect(result.status === 0, result.stdout + result.stderr).toBe(available);
      expect(existsSync(join(root, "executed"))).toBe(available);
      const calls = readFileSync(join(root, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const preflight = calls.findIndex((args) => args[0] === "development" && args[1] === "images");
      const setup = calls.findIndex((args) => args[0] === "tools");
      expect(preflight).toBeGreaterThan(-1);
      if (available) expect(preflight).toBeLessThan(setup);
      else expect(setup).toBe(-1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test("the hosted planner emits executable configuration and retained matrix evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-hosted-plan-"));
  try {
    const output = join(root, "output"),
      summary = join(root, "summary");
    registerProject(repository, "workbench");
    const matrix = planCI(
      { ...process.env, RUNNER_TEMP: root, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      repository,
    );
    expect(JSON.parse(readFileSync(join(root, "workbench-ci-plan.json"), "utf8"))).toEqual(matrix);
    expect(readFileSync(output, "utf8")).toBe(
      `matrix=${JSON.stringify(matrix)}\nartifact=ci-plan-${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}\n`,
    );
    expect(readFileSync(summary, "utf8")).toContain("Every configured root is checked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "hosted checks select their targets and execute the prepared image without publishing",
  () => {
    const root = mkdtempSync(join(tmpdir(), "workbench-hosted-gate-"));
    try {
      mkdirSync(join(root, "bin"));
      const targets = [
        { kind: "native", id: "linux", path: ".", os: "linux", architecture: "x64" },
        { kind: "native", id: "windows", path: ".", os: "windows", architecture: "x64" },
        { kind: "compatibility", id: "minimum", path: ".", runtime: "node", version: "22.23.3", architecture: "x64" },
        { kind: "compatibility", id: "foreign", path: ".", runtime: "node", version: "22.23.3", architecture: "arm64" },
      ];
      writeFileSync(
        join(root, "catalog.json"),
        JSON.stringify(
          targets.map((target) => ({
            release: false,
            os: "linux",
            environment: "native",
            checks: [],
            roles: ["test"],
            ...target,
            phases: target.kind === "native" ? ["native-install", "native-check"] : ["compatibility"],
          })),
        ),
      );
      writeFileSync(
        join(root, "bin/workbench.mjs"),
        `import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2);
appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');
if(args[0]==='project' && args[1]==='add') {}
else if(args[0]==='check') console.log(readFileSync('catalog.json','utf8'));
else if(args[0]==='config') console.log(JSON.stringify({native:'offline'}));
else if(args[0]==='tools') {}
else if(args[0]==='ci-image-acquire') { writeFileSync('prepared','verified'); writeFileSync(args[args.indexOf('--output')+1],JSON.stringify({version:1,profile:args[1],platform:'linux-x64',inputs:'c'.repeat(64),reference:'ghcr.io/owner/image:inputs',image:'sha256:'+'a'.repeat(64),published:'ghcr.io/owner/image@sha256:'+'b'.repeat(64)})); }
else if(args[0]==='ci-image-exec' && existsSync('prepared')) writeFileSync('executed','complete');
else throw new Error('unexpected or unauthorized operation');
`,
      );
      const result = spawnSync(process.execPath, [join(repository, "scripts/ci-hosted.mts"), "native"], {
        cwd: root,
        env: {
          ...process.env,
          CI_MATRIX: JSON.stringify({ paths: ["."], os: "linux", architecture: "x64" }),
          RUNNER_TEMP: root,
          WORKBENCH_PUBLISH_IMAGES: "true",
        },
        encoding: "utf8",
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(join(root, "executed"), "utf8")).toBe("complete");
      expect(
        (JSON.parse(readFileSync(join(root, "workbench-reports/targets.json"), "utf8")) as { id: string }[]).map(
          ({ id }) => id,
        ),
      ).toEqual(["linux", "minimum"]);
      const calls = readFileSync(join(root, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.some((args) => args[0] === "development" && args[1] === "publish")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
