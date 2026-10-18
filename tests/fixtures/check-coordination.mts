import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { stringify } from "smol-toml";
import { setupProject } from "../../src/projects.ts";
import { synchronize } from "../../src/sync.ts";
import { waitForCondition } from "./coordination.mjs";

const distribution = resolve(import.meta.dirname, "../..");

export function coordinationFixtures() {
  const temporary: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const base of temporary.splice(0)) rmSync(base, { recursive: true, force: true });
  });
  async function fixture() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "workbench-gate-coordination-")));
    temporary.push(base);
    const root = join(base, "project"),
      control = join(base, "control");
    mkdirSync(root);
    mkdirSync(control);
    for (const [name, value] of Object.entries({
      WORKBENCH_DISTRIBUTION_ROOT: distribution,
      WORKBENCH_PROJECT_ROOT: root,
      WORKBENCH_CONFIG_HOME: join(base, "config"),
      WORKBENCH_CACHE_HOME: join(base, "cache"),
      WORKBENCH_DATA_HOME: join(base, "data"),
      WORKBENCH_STATE_HOME: join(base, "state"),
      WORKBENCH_LOCAL_CONFIG_ROOT: undefined,
      WORKBENCH_EPHEMERAL_CHECKOUT: undefined,
      WORKBENCH_STORAGE_EXTERNAL: "false",
      WORKBENCH_STORAGE_ROOT: undefined,
      WORKBENCH_CPUS: "1",
      CI: undefined,
      GITHUB_ACTIONS: undefined,
      GITLAB_CI: undefined,
    }))
      vi.stubEnv(name, value);
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    git("init", "-q");
    await setupProject(root, "fixture");
    copyFileSync(join(import.meta.dirname, "records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    const config = {
      schema_version: 1,
      markdown: { wrap_width: 120 },
      compatibility: { required: false },
      citations: { library_dir: "citations" },
      check: ["setup", "test", "secret"].map((role) => ({
        name: role,
        role,
        command: [process.execPath, "step.mjs", control, role],
      })),
    };
    const save = () => {
      writeFileSync(join(root, "workbench/config.toml"), stringify(config));
    };
    save();
    writeFileSync(
      join(root, "step.mjs"),
      `import {appendFileSync,existsSync,renameSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
const [control,role]=process.argv.slice(2);
const mark=name=>appendFileSync(join(control,name),'event\\n');
process.on('SIGINT',()=>{mark('cancelled');process.exit(130)});
mark(role);
if(role==='test') {
 const ready=join(control,'running-'+process.pid);
 writeFileSync(ready,String(process.pid));
 renameSync(ready,join(control,'running'));
 while(!existsSync(join(control,'release'))) await new Promise(resolve=>setTimeout(resolve,10));
 if(existsSync(join(control,'fail-once'))) {unlinkSync(join(control,'fail-once'));process.exit(29)}
}
`,
    );
    synchronize(root);
    git("add", ".");
    const runs: { child: ReturnType<typeof spawn>; closed: Promise<number | null>; output: () => string }[] = [];
    const start = (cwd = root, extra: NodeJS.ProcessEnv = {}, args: string[] = []) => {
      const child = spawn(
        process.execPath,
        [join(distribution, "bin/workbench.mjs"), "--plain", "pre-commit", ...args],
        {
          cwd,
          env: { ...process.env, WORKBENCH_PROJECT_ROOT: cwd, ...extra },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      const run = { child, closed, output: () => output };
      runs.push(run);
      return run;
    };
    const count = (role: string) =>
      existsSync(join(control, role))
        ? readFileSync(join(control, role), "utf8")
            .split("\n")
            .filter((line) => line === "event").length
        : 0;
    const release = () => {
      writeFileSync(join(control, "release"), "release");
    };
    const cleanup = async () => {
      release();
      for (const run of runs)
        if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGTERM");
      await Promise.allSettled(runs.map((run) => run.closed));
    };
    return { base, root, control, config, save, git, start, count, release, cleanup };
  }
  type Run = ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>;
  async function until(run: Run, predicate: () => boolean, label: string) {
    await waitForCondition(
      predicate,
      run.closed.then(() => {
        throw new Error(run.output());
      }),
      label,
    );
  }
  async function waiting(run: Run) {
    await until(run, () => run.output().includes("Waiting for another check gate"), "gate waiting acknowledgment");
  }
  return { fixture, until, waiting };
}
