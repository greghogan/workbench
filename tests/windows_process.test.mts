import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import {
  decodeWindowsProcessOutcome,
  spawnWindowsProcess,
  windowsProcessCommand,
  windowsProcessEnvironment,
  windowsProcessExecutable,
  type WindowsProcess,
} from "../scripts/windows-process.mts";
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform !== "win32")(
  "a supervisor stalled before connecting cannot hang cancellation or launch its target",
  async () => {
    const root = fixture(),
      marker = join(root, "must-not-execute");
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementationOnce((_command, _args, settings) =>
      actual.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], settings),
    );
    const owned = await spawnWindowsProcess(
      process.execPath,
      ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
      { cwd: root, env: process.env, stdin: "ignore" },
    );
    capture(owned);
    const closed = once(owned.child, "close");
    owned.cancel();
    const result = await owned.completion;
    expect(result).toMatchObject({ pid: 0, status: null, jobEmpty: false });
    expect(result.error?.message).toMatch(/uncertain|startup cancellation/);
    expect(existsSync(marker)).toBe(false);
    await expect(owned.dispose()).rejects.toThrow(/uncertain/);
    await closed;
    // The injected sleeper has no descendants; its real exit is independent cleanup evidence for this fixture.
    rmSync(owned.directory, { recursive: true, force: true });
  },
);
test("Windows executable lookup shares environment precedence and resolves relative PATH entries under the selected cwd", () => {
  expect(
    windowsProcessExecutable(
      "tool",
      {
        cwd: "C:\\workspace",
        env: { Path: "C:\\ignored", PATH: "tools" },
      },
      (path) => path === "C:\\workspace\\tools\\tool.exe" || path === "C:\\ignored\\tool.exe",
    ),
  ).toBe("C:\\workspace\\tools\\tool.exe");
});
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "workbench-windows-job-")));
  roots.push(root);
  return root;
}
test("Windows requests retain literal arguments and select a single original environment value", () => {
  const source = { Path: "later", PATH: "selected", EMPTY: "", VALUE: "value=with equality 文", OMITTED: undefined };
  expect(windowsProcessEnvironment(source)).toBe("EMPTY=\0PATH=selected\0VALUE=value=with equality 文\0\0");
  expect(source.Path).toBe("later");
  expect(
    windowsProcessEnvironment({ ZOO: "last", apple: "first", APPLE: undefined, A: "before A1", A1: "after A" }),
  ).toBe("A=before A1\0A1=after A\0apple=first\0ZOO=last\0\0");
  expect(windowsProcessCommand("C:\\program space\\app.exe", ["", 'a"b', "C:\\trailing space\\", "&|%!"])).toBe(
    '"C:\\program space\\app.exe" "" "a\\"b" "C:\\trailing space\\\\" "&|%!"',
  );
  expect(windowsProcessCommand("cmd.exe", ["/d", "/s", "/c", '"echo literal"'], true)).toBe(
    '"cmd.exe" /d /s /c "echo literal"',
  );
  expect(() => windowsProcessEnvironment({ VALUE: "invalid\0value" })).toThrow(/environment/);
  expect(() => windowsProcessCommand("node", ["invalid\0argument"])).toThrow(/null byte/);
});
test("Windows executable absence exposes the same missing-tool code as native spawn", () => {
  let failure: unknown;
  try {
    windowsProcessExecutable("absent", { cwd: "C:\\fixture", env: {} }, () => false);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "ENOENT", message: "Cannot resolve Windows executable: absent" });
});
const valid = { version: 1, token: "fixture-token", pid: 32, status: 0xffffffff, jobEmpty: true, error: null };
test("completion proofs distinguish original uint32 exit status, empty jobs, and failed startup", () => {
  expect(decodeWindowsProcessOutcome(valid, valid.token)).toEqual({ pid: 32, status: 0xffffffff, jobEmpty: true });
  const failed = decodeWindowsProcessOutcome({ ...valid, pid: 0, status: null, error: "Cannot launch" }, valid.token);
  expect(failed).toMatchObject({ pid: 0, status: null, jobEmpty: true });
  expect(failed.error?.message).toBe("Cannot launch");
});
test.each([
  { ...valid, token: "unrelated invocation" },
  { ...valid, version: 2 },
  { ...valid, unknown: true },
  { ...valid, pid: -1 },
  { ...valid, pid: 0 },
  { ...valid, status: -1 },
  { ...valid, status: 0x100000000 },
  { ...valid, status: null },
  { ...valid, jobEmpty: "true" },
  { ...valid, error: {} },
])("invalid completion proof never establishes ownership release: %#", (input) => {
  expect(() => decodeWindowsProcessOutcome(input, valid.token)).toThrow(/completion proof/);
});

function capture(owned: WindowsProcess) {
  if (!owned.child.stdout || !owned.child.stderr) throw new Error("Capture requires piped helper output");
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  owned.child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
  });
  owned.child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
  });
  return {
    stdout: owned.child.stdout,
    output: () => Buffer.concat(stdout),
    errors: () => Buffer.concat(stderr).toString("utf8"),
  };
}
async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error("Windows fixture process did not terminate");
    await delay(10);
  }
}
test.skipIf(process.platform !== "win32")(
  "creation-time jobs preserve streams, cwd, environment, arguments, and root status",
  async () => {
    const root = fixture(),
      marker = join(root, "started"),
      script = join(root, "literal arguments 文.mjs");
    const args = ["", 'embedded " quote', "C:\\trailing space\\", "文", "&|%!^()"];
    writeFileSync(
      script,
      `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker)},'started');
const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk);
process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.WORKBENCH_FIXTURE_VALUE,request:process.env.WORKBENCH_PROCESS_REQUEST}));
process.stdout.write(Buffer.concat(chunks)); process.stderr.write('diagnostic 文'); process.exitCode=23;
`,
    );
    const original = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"));
    const owned = await spawnWindowsProcess(basename(process.execPath), [script, ...args], {
      cwd: root,
      env: {
        ...original,
        Path: join(root, "unselected tools"),
        PATH: dirname(process.execPath),
        WORKBENCH_FIXTURE_VALUE: "original value 文",
      },
      stdin: "pipe",
    });
    const captured = capture(owned);
    try {
      await owned.ready;
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(owned.directory, "request.json"))).toBe(false);
      await owned.admit();
      const bytes = Buffer.from([0, 10, 13, 128, 255]);
      owned.child.stdin?.end(bytes);
      const result = await owned.completion;
      expect(result.error, captured.errors()).toBeUndefined();
      expect(result).toMatchObject({ status: 23, jobEmpty: true });
      expect(result.pid).not.toBe(owned.child.pid);
      const output = captured.output();
      expect(output.subarray(-bytes.length)).toEqual(bytes);
      expect(JSON.parse(output.subarray(0, -bytes.length).toString("utf8"))).toEqual({
        args,
        cwd: root,
        value: "original value 文",
      });
      expect(captured.errors()).toBe("diagnostic 文");
    } finally {
      owned.cancel();
      await owned.dispose();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "an exited parent cannot release detached descendants; cancellation empties the retained job",
  async () => {
    const root = fixture(),
      marker = join(root, "descendant.pid"),
      rootMarker = join(root, "root.pid"),
      script = join(root, "parent.mjs");
    writeFileSync(
      script,
      `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(rootMarker)},String(process.pid));
const child=spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)); process.send('ready'); setInterval(()=>{},1000);`)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
child.once('message',()=>{child.disconnect();child.unref();console.log('root exiting');process.exit(7)});
`,
    );
    const owned = await spawnWindowsProcess(process.execPath, [script], {
      cwd: root,
      env: process.env,
      stdin: "ignore",
    });
    const captured = capture(owned);
    try {
      await owned.admit();
      let settled = false;
      void owned.completion.then(() => {
        settled = true;
      });
      while (!captured.output().includes("root exiting")) await once(captured.stdout, "data");
      await waitGone(Number(readFileSync(rootMarker, "utf8")));
      expect(settled).toBe(false);
      const descendant = Number(readFileSync(marker, "utf8"));
      expect(() => process.kill(descendant, 0)).not.toThrow();
      owned.cancel();
      const result = await owned.completion;
      expect(result.error, captured.errors()).toBeUndefined();
      expect(result).toMatchObject({ status: 7, jobEmpty: true });
      expect(() => process.kill(descendant, 0)).toThrow();
    } finally {
      owned.cancel();
      await owned.dispose();
    }
  },
);

test.skipIf(process.platform !== "win32")("canceling before admission never launches the target", async () => {
  const root = fixture(),
    marker = join(root, "must-not-exist");
  const owned = await spawnWindowsProcess(
    process.execPath,
    ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
    { cwd: root, env: process.env, stdin: "ignore" },
  );
  capture(owned);
  try {
    await owned.ready;
    owned.cancel();
    await owned.admit();
    expect(await owned.completion).toMatchObject({ pid: 0, status: null, jobEmpty: true });
    expect(existsSync(marker)).toBe(false);
  } finally {
    await owned.dispose();
  }
});

test.skipIf(process.platform !== "win32")(
  "inherited standard handles preserve interactive caller streams",
  async () => {
    const root = fixture(),
      launcher = join(root, "inherited-console.mjs");
    writeFileSync(
      launcher,
      `import assert from 'node:assert/strict';
import {spawnWindowsProcess} from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../scripts/windows-process.mjs")).href)};
const owned=await spawnWindowsProcess(process.execPath,['-e',${JSON.stringify("(async()=>{const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);process.stdout.write(Buffer.concat(chunks));process.stderr.write('inherited diagnostic 文')})().catch(error=>{console.error(error);process.exitCode=1})")}],{cwd:${JSON.stringify(root)},env:process.env,stdin:'inherit',output:'inherit'});
assert.equal(owned.child.stdin,null);assert.equal(owned.child.stdout,null);assert.equal(owned.child.stderr,null);
try {await owned.admit();const result=await owned.completion;assert.equal(result.error,undefined);assert.equal(result.jobEmpty,true);assert.equal(result.status,0)}
finally {owned.cancel();await owned.dispose()}
`,
    );
    const caller = spawn(process.execPath, [launcher], { stdio: ["pipe", "pipe", "pipe"], windowsHide: false });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    caller.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    caller.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    const closed = once(caller, "close");
    const bytes = Buffer.from([0, 10, 13, 127, 128, 255]);
    caller.stdin.end(bytes);
    await closed;
    expect(caller.exitCode, Buffer.concat(stderr).toString("utf8")).toBe(0);
    expect(Buffer.concat(stdout)).toEqual(bytes);
    expect(Buffer.concat(stderr).toString("utf8")).toBe("inherited diagnostic 文");
  },
);

test.skipIf(process.platform !== "win32")(
  "coordinator loss cancels its job without relying on the original root PID",
  async () => {
    const root = fixture(),
      launcher = join(root, "coordinator.mjs"),
      marker = join(root, "root.pid");
    writeFileSync(
      launcher,
      `import {spawnWindowsProcess} from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../scripts/windows-process.mjs")).href)};
const owned=await spawnWindowsProcess(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)); console.log('root-ready'); setInterval(()=>{},1000)`)}],{cwd:${JSON.stringify(root)},env:process.env,stdin:'ignore'});
owned.child.stdout.pipe(process.stdout);owned.child.stderr.pipe(process.stderr);
await owned.admit();console.log('supervisor '+owned.child.pid+' '+JSON.stringify(owned.directory));await owned.completion;
`,
    );
    const coordinator = spawn(process.execPath, [launcher], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const closed = once(coordinator, "close");
    let output = "",
      errors = "";
    coordinator.stdout.on("data", (bytes: Buffer) => {
      output += bytes.toString("utf8");
    });
    coordinator.stderr.on("data", (bytes: Buffer) => {
      errors += bytes.toString("utf8");
    });
    let directory: string | undefined;
    try {
      while (!output.includes("root-ready") || !output.includes("supervisor "))
        await once(coordinator.stdout, "data", { signal: AbortSignal.timeout(30000) });
      const supervisor = /supervisor (\d+) ("[^\n]+")/.exec(output);
      expect(supervisor, errors).not.toBeNull();
      if (!supervisor?.[1] || !supervisor[2]) throw new Error("Missing Windows supervisor identity");
      const parsed: unknown = JSON.parse(supervisor[2]);
      if (typeof parsed !== "string") throw new Error("Invalid supervisor directory");
      directory = parsed;
      coordinator.kill();
      await closed;
      await waitGone(Number(readFileSync(marker, "utf8")));
      await waitGone(Number(supervisor[1]));
      const proof: unknown = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
      expect(proof).toMatchObject({ jobEmpty: true });
    } finally {
      if (coordinator.exitCode === null && coordinator.signalCode === null) coordinator.kill();
      await closed;
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  },
);
