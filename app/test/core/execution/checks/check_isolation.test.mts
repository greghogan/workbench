import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { parse, stringify } from "smol-toml";
import { synchronize } from "../../../../src/core/records/sync.ts";
import { fileDigest, type CheckSourceEntry } from "../../../../src/core/execution/checks/check-inputs.ts";
import {
  checkBackendName,
  linuxCheckBackend,
  linuxCheckInvocation,
  nativeCheckBackend,
} from "../../../../src/core/execution/checks/check-isolation.ts";
import { materializeCheckSource, stagedCheckMounts } from "../../../../src/core/execution/checks/check-source-view.ts";
import { materializeAcquisitionSource } from "../../../../src/core/execution/checks/check-acquisition.ts";
import { readLog } from "../../../../src/core/storage/logs/log-reader.ts";
import type { CheckRunResult } from "../../../../src/core/execution/checks/check-report.ts";
import { consumer, distribution, git } from "../../../fixtures/adoption.mjs";

const scratch: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "workbench-check-isolation-"));
  scratch.push(directory);
  const project = join(directory, "project");
  const source = join(directory, "source");
  for (const path of [project, source, join(source, "coverage")]) mkdirSync(path, { recursive: true });
  const input = join(project, "input.txt");
  writeFileSync(input, "declared");
  writeFileSync(join(project, "omitted.txt"), "undeclared");
  return { directory, project, source, input };
}

test("the source view rejects bytes that differ from the captured fingerprint", async () => {
  const { project, source, input } = workspace();
  const digest = fileDigest(input);
  writeFileSync(input, "edited after capture");
  await expect(materializeCheckSource(project, source, [["input.txt", "file", digest]])).rejects.toThrow(
    /Scoped input changed during capture: input\.txt/,
  );
});

test("overlapping read-only check views share the captured bytes after a checkout edit", async () => {
  const { directory, project, source, input } = workspace();
  const second = join(directory, "second");
  mkdirSync(second);
  const entries: CheckSourceEntry[] = [["input.txt", "file", fileDigest(input)]];
  const captured = new Map<string, string>();
  await materializeCheckSource(project, source, entries, captured);
  writeFileSync(input, "edited after first materialization");
  await materializeCheckSource(project, second, entries, captured);
  expect(readFileSync(join(second, "input.txt"), "utf8")).toBe("declared");
  expect(readFileSync(input, "utf8")).toBe("edited after first materialization");
});

test.skipIf(process.platform === "win32")(
  "acquisition uses the selected tree's input scopes and copies complete source for undeclared inputs",
  () => {
    const { directory, project, source } = workspace();
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    mkdirSync(join(project, "workbench"));
    writeFileSync(join(project, "workbench/projects.toml"), '[[project]]\nid="fixture"\npath="."\n');
    writeFileSync(join(project, "workbench/CHARTER.md"), "# Charter\n\nExact policy.\n");
    const config = join(project, "workbench/config.toml");
    const policy = {
      schema_version: 1,
      markdown: { wrap_width: 120 },
      compatibility: { required: false },
      input_groups: { dependencies: { paths: ["input.txt"] } },
      check: [{ name: "Prepare", role: "acquire", stages: [], command: ["node", "--version"] }],
    };
    git(project, "init", "-q");
    writeFileSync(
      config,
      stringify({
        ...policy,
        check: policy.check.map((entry) => ({ ...entry, input_groups: ["dependencies"] })),
      }),
    );
    git(project, "add", ".");
    git(project, "commit", "-qm", "Scoped acquisition");
    const tree = git(project, "rev-parse", "HEAD^{tree}");
    writeFileSync(config, stringify(policy));
    materializeAcquisitionSource(project, tree, source, { environment: "native" });
    expect(readFileSync(join(source, "input.txt"), "utf8")).toBe("declared");
    expect(readFileSync(join(source, "workbench/CHARTER.md"), "utf8")).toContain("Exact policy");
    expect(existsSync(join(source, "omitted.txt"))).toBe(false);
    git(project, "add", ".");
    git(project, "commit", "-qm", "Undeclared acquisition");
    const complete = join(directory, "complete");
    mkdirSync(complete);
    materializeAcquisitionSource(project, git(project, "rev-parse", "HEAD^{tree}"), complete, {
      environment: "native",
    });
    expect(readFileSync(join(complete, "omitted.txt"), "utf8")).toBe("undeclared");
  },
);

const backend = linuxCheckBackend();
test.skipIf(!backend)("a scoped check can use its worker FIFO without seeing adjacent files", () => {
  const { project, source } = workspace();
  const pipeDirectory = mkdtempSync("/tmp/workbench-check-fifo-");
  scratch.push(pipeDirectory);
  const fifo = join(pipeDirectory, "workers.fifo");
  expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0);
  writeFileSync(fifo + ".other", "keep outside the scope");
  const [launcher, ...args] = linuxCheckInvocation(
    backend?.executable ?? "bwrap",
    { project, directory: project, source, runtime: [], outputs: [] },
    [
      "/bin/sh",
      "-ec",
      'fifo=$WORKBENCH_JOBSERVER_FIFO; test -p "$fifo"; test ! -e "$fifo.other"; exec 4<>"$fifo"; printf "slot\\n" >&4; read -r token <&4; test "$token" = slot',
    ],
    true,
  );
  if (!launcher) throw new Error("Scoped sandbox launcher missing");
  const result = spawnSync(launcher, args, {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, WORKBENCH_JOBSERVER_FIFO: fifo },
    timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
});

test.skipIf(!backend)("the staged view mounts the exact inputs and leaves outputs writable", async () => {
  const { directory, project, source, input } = workspace();
  mkdirSync(join(project, "selected"));
  const nested = join(project, "selected", "only");
  writeFileSync(nested, "nested");
  const output = join(directory, "output");
  mkdirSync(output);
  const logical = join(directory, "logical");
  const outputPath = join(logical, "selected", "logs");
  mkdirSync(logical);
  const generated = join(logical, "generated");
  writeFileSync(generated, "from preparation");
  const mounts = await stagedCheckMounts(
    project,
    logical,
    source,
    [
      ["input.txt", "file", fileDigest(input)],
      ["generated", "file", fileDigest(generated)],
      ["selected/only", "file", fileDigest(nested)],
    ],
    [outputPath],
  );
  const sourceMounts = join(directory, "mounts");
  writeFileSync(sourceMounts, mounts.join("\0") + "\0");
  const [launcher, ...args] = linuxCheckInvocation(
    backend?.executable ?? "bwrap",
    {
      project: logical,
      directory: logical,
      source,
      sourceMounts,
      runtime: [],
      outputs: [{ source: output, destination: outputPath }],
    },
    [
      "/bin/sh",
      "-ec",
      'test "$(cat input.txt selected/only)" = declarednested; test "$(cat generated)" = "from preparation"; test ! -e omitted.txt; ! touch unexpected; echo private > selected/logs/status',
    ],
  );
  if (!launcher) throw new Error("Staged sandbox launcher missing");
  const result = spawnSync(launcher, args, { cwd: project, encoding: "utf8", timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(output, "status"), "utf8")).toBe("private\n");
  expect(existsSync(join(source, "input.txt"))).toBe(false);
  expect(readFileSync(join(source, "generated"), "utf8")).toBe("from preparation");
});

test.skipIf(!backend)("cache changes in a scoped overlay stay private", (context) => {
  const { directory, project, source } = workspace();
  const executable = backend?.executable ?? "bwrap";
  const seed = join(directory, "prepared");
  mkdirSync(seed);
  writeFileSync(join(seed, "package"), "verified");
  const capability = spawnSync(executable, [
    "--unshare-user",
    "--dev-bind",
    "/",
    "/",
    "--overlay-src",
    seed,
    "--tmp-overlay",
    seed,
    "--",
    "/usr/bin/true",
  ]);
  if (capability.status !== 0) {
    context.skip("Bubblewrap overlay mounts are unavailable");
    return;
  }
  const destination = "/run/workbench/prepared";
  const [, ...args] = linuxCheckInvocation(
    executable,
    {
      project,
      directory: project,
      source,
      runtime: [],
      outputs: [],
      tools: [{ source: seed, destination, overlay: true }],
    },
    [
      "/bin/sh",
      "-eu",
      "-c",
      'test "$(cat "$1/package")" = verified; echo local > "$1/package"; touch "$1/lock"',
      "check",
      destination,
    ],
  );
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(seed, "package"), "utf8")).toBe("verified");
  expect(existsSync(join(seed, "lock"))).toBe(false);
});

test.skipIf(process.platform !== "linux")("a runtime alias cannot mount omitted project files", () => {
  const { directory, project, source } = workspace();
  const privateDirectory = join(project, "private");
  mkdirSync(privateDirectory);
  const alias = join(directory, "runtime");
  symlinkSync(privateDirectory, alias, "dir");
  expect(() =>
    linuxCheckInvocation("bwrap", { project, directory: project, source, runtime: [alias], outputs: [] }, [
      "/bin/true",
    ]),
  ).toThrow(/runtime overlaps the scoped project/);
});

test.skipIf(process.platform !== "linux")("a staged check rejects a runtime mount of the working checkout", () => {
  const { project, directory, source } = workspace();
  const snapshot = join(directory, "staged");
  mkdirSync(snapshot);
  vi.stubEnv("WORKBENCH_EPHEMERAL_CHECKOUT", "1");
  vi.stubEnv("WORKBENCH_LOCAL_CONFIG_ROOT", project);
  expect(() =>
    linuxCheckInvocation("bwrap", { project: snapshot, directory: snapshot, source, runtime: [project], outputs: [] }, [
      "/bin/true",
    ]),
  ).toThrow(/runtime overlaps the scoped project/);
});

test.skipIf(!backend)("native scope hides undeclared project files and keeps outputs private", async () => {
  const { directory, project, source, input } = workspace();
  await materializeCheckSource(project, source, [["input.txt", "file", fileDigest(input)]]);
  expect(existsSync(join(source, "omitted.txt"))).toBe(false);
  const output = join(directory, "output");
  mkdirSync(output);
  const [command, ...args] = linuxCheckInvocation(
    backend?.executable ?? "bwrap",
    {
      project,
      directory: project,
      source,
      runtime: [],
      outputs: [{ source: output, destination: join(project, "coverage") }],
    },
    [
      "/bin/sh",
      "-ec",
      [
        'test "$(cat input.txt)" = declared',
        "! cat omitted.txt",
        '! /bin/sh -c \'cat "$1"\' child "$PWD/omitted.txt"',
        "! /bin/sh -c 'echo changed >> input.txt'",
        "printf report > coverage/staged && mv coverage/staged coverage/report",
      ].join("\n"),
    ],
  );
  if (!command) throw new Error("Sandbox command missing");
  const result = spawnSync(command, args, { cwd: project, encoding: "utf8", timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(input, "utf8")).toBe("declared");
  expect(readFileSync(join(output, "report"), "utf8")).toBe("report");
  expect(existsSync(join(project, "coverage"))).toBe(false);
});

const native = nativeCheckBackend();
test.runIf(process.platform === "darwin" && process.env.GITHUB_ACTIONS === "true")(
  "the hosted macOS runner provides a working App Sandbox",
  () => {
    expect(native?.kind).toBe("macos");
  },
);
test.runIf(backend !== undefined || process.platform !== "linux")(
  "offline check gates enforce their platform contract",
  async () => {
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    const root = await consumer();
    scratch.push(root);
    const configPath = join(root, "workbench/config.toml");
    const config = parse(readFileSync(configPath, "utf8"));
    config.check = [
      { name: "Local test", role: "test", input_groups: ["offline"], command: [process.execPath, "offline.cjs"] },
      {
        name: "Live advisory",
        role: "advisory",
        stages: ["commit"],
        online: true,
        command: [process.execPath, "-e", "process.exit(92)"],
      },
    ];
    writeFileSync(configPath, stringify(config));
    writeFileSync(
      join(root, "workbench/automation.toml"),
      stringify({ input_groups: { offline: { paths: ["offline.cjs"] } } }),
    );
    writeFileSync(
      join(root, "offline.cjs"),
      `
    const assert = require("node:assert/strict");
    const net = require("node:net");
    const os = require("node:os");
    const { spawnSync } = require("node:child_process");
    assert.equal(process.env.WORKBENCH_OFFLINE, "1");
    assert.equal(process.env.GOPROXY, "off");
    if (process.platform === "linux") {
      const interfaces = Object.values(os.networkInterfaces()).flat();
      assert(interfaces.length && interfaces.every(({ internal }) => internal));
      const child = spawnSync(process.execPath, ["-e", \`
        const socket = require("node:net").connect(80, "192.0.2.1");
        socket.on("error", (e) => { if (e.code !== "ENETUNREACH") throw e; });
        socket.on("connect", () => process.exit(9));
      \`], { timeout: 3000, encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);
    }
    const server = net.createServer(socket => socket.end("loopback"));
    server.listen(0, "127.0.0.1", () => {
      const client = net.connect(server.address().port, "127.0.0.1");
      let received = "";
      client.on("data", data => { received += data; });
      client.on("end", () => {
        assert.equal(received, "loopback");
        server.close();
      });
    });
    `,
    );
    const report = join(root, "offline-report.json");
    const invoke = (...args: string[]) =>
      spawnSync(process.execPath, [join(distribution, "bin/workbench.mjs"), ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 20000,
        env: { ...process.env, ...(process.platform === "linux" ? {} : { WORKBENCH_OFFLINE: "1" }) },
      });
    const result = invoke("check", "--no-cache", "--report", report, "--role", "test");
    if (process.platform === "win32") {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Offline check execution is unavailable on Windows");
    } else {
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout + result.stderr).toContain("Local test");
      if (native) {
        const { runs } = JSON.parse(readFileSync(report, "utf8")) as { runs: CheckRunResult[] };
        expect(runs[0]?.cache?.groups).toMatchObject([
          { backend: checkBackendName(native), inputScope: { mode: "scoped" } },
        ]);
      }
      const commit = invoke("pre-commit");
      expect(commit.status).not.toBe(0);
      expect(commit.stderr).toContain("The configured commit gate requires online checks");
    }
  },
);

test.skipIf(!native)("the CLI stores scoped results only after enforcing the source view", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const trust = join(workspace().directory, "certificates.pem");
  writeFileSync(trust, "configured trust bundle");
  vi.stubEnv("SSL_CERT_FILE", trust);
  const root = await consumer();
  scratch.push(root);
  const configPath = join(root, "workbench/config.toml");
  const config = parse(readFileSync(configPath, "utf8"));
  delete config.check;
  writeFileSync(configPath, stringify(config));
  writeFileSync(join(root, ".gitignore"), "/build/\n/.reports/\n");
  const omitted = join(root, "omitted.txt");
  writeFileSync(omitted, "outside the declared scope");
  writeFileSync(join(root, "input.txt"), "declared");
  const coverage = (covered: number) => JSON.stringify({ "coverage.cjs": { lines: { total: 4, covered } } });
  const summary = join(root, "coverage/coverage-summary.json");
  mkdirSync(join(root, "coverage"));
  writeFileSync(summary, coverage(2));
  writeFileSync(
    join(root, "coverage.cjs"),
    `
    require("./verify.cjs");
    const fs = require("node:fs");
    fs.writeFileSync("coverage/output.json", ${JSON.stringify(coverage(3))});
    fs.renameSync("coverage/output.json", "coverage/coverage-summary.json");
  `,
  );
  writeFileSync(
    join(root, "verify.cjs"),
    `
    const a = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    a.equal(fs.readFileSync("input.txt", "utf8"), "declared");
    a.equal(fs.readFileSync(process.env.SSL_CERT_FILE, "utf8"), "configured trust bundle");
    a.throws(() => fs.readFileSync(path.join(process.cwd(), "omitted.txt")), { code: "ENOENT" });
    fs.writeFileSync("generated/fixture", "scoped output");
    const cached = fs.mkdtempSync(path.join(os.tmpdir(), "readonly-dependency-"));
    fs.writeFileSync(path.join(cached, "module"), "prepared");
    fs.chmodSync(cached, 0o500);
  `,
  );
  writeFileSync(
    join(root, "workbench/automation.toml"),
    stringify({
      input_groups: { source: { paths: ["input.txt", "verify.cjs", "coverage.cjs"], outputs: ["generated"] } },
      check: [
        {
          name: "Test visible source",
          role: "test",
          input_groups: ["source"],
          command: [process.execPath, "verify.cjs"],
          coverage: { command: [process.execPath, "coverage.cjs"], stages: ["ci"] },
        },
      ],
    }),
  );
  synchronize(root);
  git(root, "add", ".");
  git(root, "commit", "-m", "Scoped check fixture");
  const run = async (name: string, args: string[] = ["--stage", "commit"], success = true) => {
    const report = join(root, ".reports", name + ".json");
    const result = spawnSync(
      process.execPath,
      [join(distribution, "bin/workbench.mjs"), "check", "--report", report, ...args],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CI: undefined, GITHUB_ACTIONS: undefined, GITLAB_CI: undefined },
      },
    );
    const runs = existsSync(report)
      ? (JSON.parse(readFileSync(report, "utf8")) as { runs: CheckRunResult[] }).runs
      : [];
    let diagnostics = result.stdout + result.stderr;
    if ((result.status === 0) !== success) {
      for (const check of runs.flatMap((item) => item.checks))
        for (const detail of check.details)
          if (detail.kind === "coverage-unavailable") diagnostics += `\n${detail.reason}`;
      const files = new Set(
        runs.flatMap((item) => [
          ...item.checks.filter((check) => check.status === "failed").map((check) => check.log),
          ...item.groups.flatMap(({ stdout, stderr }) => [stdout, stderr]),
        ]),
      );
      const group = /failed; read full output: workbench logs read '([^']+\.log)'/.exec(diagnostics)?.[1];
      if (group) files.add(group.replace(/\.log$/, ".stderr.log"));
      for (const failure of files) {
        if (!failure || ![failure, failure + ".gz", failure + ".zst"].some(existsSync)) continue;
        await readLog(
          failure,
          new Writable({
            write(chunk: Buffer, _encoding, done) {
              diagnostics += chunk.toString("utf8");
              done();
            },
          }),
        );
      }
    }
    expect(result.status === 0, `${name}\n${diagnostics}`).toBe(success);
    return runs;
  };
  if (!native) throw new Error("Native check isolation is unavailable");
  const scope = { backend: checkBackendName(native), inputScope: { mode: "scoped" } };
  expect((await run("fresh"))[0]?.cache?.groups).toMatchObject([scope]);
  expect(existsSync(join(root, "generated"))).toBe(false);
  writeFileSync(omitted, "changed and still outside the scope");
  expect((await run("reuse"))[0]?.reused).toBeDefined();
  expect((await run("forced", ["--stage", "commit", "--no-cache"]))[0]?.cache?.groups).toMatchObject([scope]);
  writeFileSync(summary, coverage(1));
  const [measured] = await run("coverage", ["--stage", "ci"]);
  expect(measured?.cache?.groups).toMatchObject([scope]);
  expect(measured?.checks[0]?.details).toContainEqual(
    expect.objectContaining({
      kind: "coverage",
      baseline: { lines: { total: 4, covered: 2, skipped: 0, pct: 50 } },
      current: { lines: { total: 4, covered: 3, skipped: 0, pct: 75 } },
    }),
  );
  expect(readFileSync(summary, "utf8")).toBe(coverage(1));
  writeFileSync(join(root, "verify.cjs"), 'require("node:fs").readFileSync("omitted.txt");\n');
  for (const name of ["denied", "denied-again"]) {
    const [report] = await run(name, [], false);
    expect(report?.status).toBe("failed");
    expect(report?.reused).toBeUndefined();
  }
});
