import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, chownSync, closeSync, constants, copyFileSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync,
} from "node:fs";
import { join } from "node:path";

const [make, ninja, cmake, cargo, rustc, otherUid] = process.argv.slice(2);
assert(make && ninja && cmake && cargo && rustc, "Pass GNU Make, Ninja, CMake, Cargo and rustc paths");
const uid = Number(process.env.SUDO_UID);
const gid = Number(process.env.SUDO_GID);
assert(process.getuid?.() === 0 && uid > 0 && gid > 0, "Run with sudo from an ordinary account");
process.umask(0o022);
const root = mkdtempSync("/tmp/workbench-fifo-");
chmodSync(root, 0o755);
const worker = join(root, "worker.cjs");
const compiler = join(root, "observe-rustc.cjs");
const labels = Array.from({ length: 6 }, (_item, index) => `probe${index}`);
const toolsPath = [ninja.slice(0, ninja.lastIndexOf("/")), process.env.PATH].join(":");
const baseline = { ...process.env, PATH: toolsPath, RUSTC: rustc };
delete baseline.MAKEFLAGS;
delete baseline.CARGO_MAKEFLAGS;
delete baseline.CMAKE_BUILD_PARALLEL_LEVEL;
delete baseline.CARGO_BUILD_JOBS;
const started = `
const {appendFileSync, readFileSync} = require('node:fs');
function start(file, label) {
  appendFileSync(file, '+ ' + label + '\\n');
  const until = Date.now() + 30000;
  while (readFileSync(file, 'utf8').split('\\n').filter(line => line.startsWith('+ ')).length < 2) {
    if (Date.now() >= until) throw new Error('The FIFO did not admit a second worker');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
}
`;
writeFileSync(worker, started + `
const [, , file, label] = process.argv;
start(file, label);
appendFileSync(file, '- ' + label + '\\n');
`);
writeFileSync(compiler, `#!${process.execPath}\n` + started + `
const {spawnSync} = require('node:child_process');
const [exe, ...args] = process.argv.slice(2);
const file = process.env.PROBE_EVENTS;
const name = args[args.indexOf('--crate-name') + 1];
const tracked = name?.startsWith('probe') === true;
if (tracked) start(file, name);
const result = spawnSync(exe, args, {stdio: 'inherit'});
if (tracked) appendFileSync(file, '- ' + name + '\\n');
process.exitCode = result.status ?? 1;
`, { mode: 0o755 });

function setup(name, identity = { uid, gid }) {
  const directory = join(root, name);
  mkdirSync(directory);
  chownSync(directory, identity.uid, identity.gid);
  const events = join(directory, "events");
  writeFileSync(events, "");
  chownSync(events, identity.uid, identity.gid);
  return { directory, events };
}

function build(program, arguments_, directory, env, identity = { uid, gid }) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, arguments_, {
      cwd: directory, env, ...identity, stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(45_000),
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-8192);
    });
    child.on("error", error => {
      if (error.code !== "ABORT_ERR") reject(error);
    });
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${program} exited with ${code ?? signal}\n${output}`));
    });
  });
}

function openFifo(directory, identity = { uid, gid }) {
  const fifo = join(directory, "jobs.fifo");
  const mkfifo = spawnSync("/usr/bin/mkfifo", ["-m", "600", fifo], { stderr: "inherit" });
  assert.equal(mkfifo.status, 0);
  chownSync(fifo, identity.uid, identity.gid);
  const descriptor = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  return { fifo, descriptor, flags: `-j --jobserver-auth=fifo:${fifo}` };
}

async function verify(name, prepare) {
  const { directory, events } = setup(name);
  const { program, arguments_, environment = {} } = prepare(directory, events);
  const { descriptor, flags } = openFifo(directory);
  try {
    assert.equal(writeSync(descriptor, Buffer.from("+")), 1);
    await build(program, arguments_, directory, {
      ...baseline, HOME: directory, MAKEFLAGS: flags, CARGO_MAKEFLAGS: flags,
      ...environment,
    });
    const active = new Set();
    const seen = new Set();
    let peak = 0;
    for (const line of readFileSync(events, "utf8").trim().split("\n")) {
      const [kind, label] = line.split(" ");
      if (kind === "+") {
        assert(!seen.has(label), `Repeated worker ${label}`);
        active.add(label);
        seen.add(label);
        peak = Math.max(peak, active.size);
      } else {
        assert(kind === "-" && active.delete(label), `Unpaired worker ${line}`);
      }
    }
    assert.equal(active.size, 0);
    assert.equal(seen.size, labels.length);
    assert.equal(peak, 2, "One implicit slot and one lent token must allow exactly two workers");
    const token = Buffer.alloc(1);
    assert.equal(readSync(descriptor, token), 1);
    assert.equal(token.toString(), "+");
    assert.throws(() => readSync(descriptor, token), { code: "EAGAIN" });
    console.log(`PASS ${name}: ${seen.size} workers, peak ${peak}, borrowed token returned`);
  } finally {
    closeSync(descriptor);
  }
}

async function verifyAcrossAccounts(secondUid) {
  assert(Number.isSafeInteger(secondUid) && secondUid > 0 && secondUid !== uid);
  const tool = join(root, "node");
  copyFileSync(process.execPath, tool);
  chmodSync(tool, 0o555);
  const sharedLog = join(root, "shared-events");
  writeFileSync(sharedLog, "");
  chmodSync(sharedLog, 0o666);
  const sharedWorker = join(root, "shared-worker.cjs");
  writeFileSync(sharedWorker, `
const { appendFileSync, readFileSync } = require('node:fs');
const [file, label] = process.argv.slice(2);
const record = state => appendFileSync(file, state + ' ' + label + ' ' + process.getuid() + '\\n');
record('+');
const barrier = Date.now() + 30000;
while (readFileSync(file, 'utf8').split('\\n').filter(line => line.startsWith('+ ')).length < 3) {
  if (Date.now() >= barrier) throw new Error('The machine budget did not admit three workers');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
record('-');
`);
  const first = { uid, gid };
  const second = { uid: secondUid, gid };
  const { directory: firstRoot } = setup("account-a", first);
  const { directory: secondRoot } = setup("account-b", second);
  const left = openFifo(firstRoot, first);
  const right = openFifo(secondRoot, second);
  function denyGrant(identity, grant) {
    const attempt = spawnSync(tool, ["-e", `
const { constants, openSync } = require('node:fs');
try { openSync(process.argv[1], constants.O_RDONLY | constants.O_NONBLOCK); }
catch (error) { if (error.code === 'EACCES') process.exit(42); throw error; }
`, grant.fifo], { ...identity, encoding: "utf8" });
    assert.equal(attempt.status, 42, attempt.stderr);
  }
  try {
    denyGrant(first, right);
    denyGrant(second, left);
    const command = `${tool} ${sharedWorker} ${sharedLog}`;
    writeFileSync(join(firstRoot, "Makefile"),
      `.PHONY: all a1 a2\nall: a1 a2\na1:\n\t${command} a1\na2:\n\t${command} a2\n`);
    writeFileSync(join(secondRoot, "build.ninja"),
      `rule worker\n  command = ${command} $out\nbuild b1: worker\nbuild b2: worker\n`);
    // Two implicit workers leave one token in a three-slot machine budget.
    assert.equal(writeSync(left.descriptor, Buffer.from("+")), 1);
    await Promise.all([
      build(make, ["all"], firstRoot, { ...baseline, HOME: firstRoot, MAKEFLAGS: left.flags }, first),
      build(ninja, [], secondRoot, { ...baseline, HOME: secondRoot, MAKEFLAGS: right.flags }, second),
    ]);
    const events = readFileSync(sharedLog, "utf8").trim().split("\n");
    const firstWave = events.slice(0, 3).map(line => line.split(" ")[1]).sort();
    assert.deepEqual(firstWave.slice(0, 2), ["a1", "a2"]);
    assert.match(firstWave[2], /^b[12]$/u);
    const active = new Set();
    let peak = 0;
    for (const line of events) {
      const [mark, label, account] = line.split(" ");
      assert.equal(Number(account), label.startsWith("a") ? uid : secondUid);
      if (mark === "+") active.add(label);
      else assert(mark === "-" && active.delete(label));
      peak = Math.max(peak, active.size);
    }
    assert.equal(events.length, 8);
    assert.equal(active.size, 0);
    assert.equal(peak, 3);
    const token = Buffer.alloc(1);
    assert.equal(readSync(left.descriptor, token), 1);
    assert.equal(token.toString(), "+");
    assert.throws(() => readSync(left.descriptor, token), { code: "EAGAIN" });
    assert.throws(() => readSync(right.descriptor, token), { code: "EAGAIN" });
    console.log("PASS two accounts: private grants, three shared slots, and borrowed token returned");
  } finally {
    closeSync(right.descriptor);
    closeSync(left.descriptor);
  }
}

try {
  await verify("make", (directory, events) => {
    writeFileSync(join(directory, "Makefile"), `.PHONY: all ${labels.join(" ")}\nall: ${labels.join(" ")}\n` +
      labels.map(label => `${label}:\n\t"${process.execPath}" "${worker}" "${events}" ${label}\n`).join(""));
    return { program: make, arguments_: ["all"] };
  });
  await verify("ninja", (directory, events) => {
    writeFileSync(join(directory, "build.ninja"),
      `rule worker\n  command = "${process.execPath}" "${worker}" "${events}" $out\n` +
      labels.map(label => `build ${label}: worker\n`).join("") + `default ${labels.join(" ")}\n`);
    return { program: ninja, arguments_: [] };
  });
  await verify("cmake-ninja", (directory, events) => {
    writeFileSync(join(directory, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.25)\nproject(probe NONE)\n" +
      labels.map(label => `add_custom_target(${label} ALL COMMAND "${process.execPath}" "${worker}" "${events}" ${label})\n`).join(""));
    const configured = spawnSync(cmake, ["-GNinja", "-S", ".", "-B", "out"], {
      cwd: directory, uid, gid, env: { ...baseline, HOME: directory }, stdio: "inherit", timeout: 30_000,
    });
    assert.equal(configured.status, 0);
    return { program: cmake, arguments_: ["--build", "out"] };
  });
  await verify("cargo", (directory, events) => {
    writeFileSync(join(directory, "Cargo.toml"), `[workspace]\nresolver = "3"\nmembers = ${JSON.stringify(labels)}\n`);
    for (const label of labels) {
      const crate = join(directory, label);
      mkdirSync(join(crate, "src"), { recursive: true });
      writeFileSync(join(crate, "Cargo.toml"), `[package]\nname = "${label}"\nversion = "0.1.0"\nedition = "2024"\n`);
      writeFileSync(join(crate, "src/lib.rs"), "pub fn probe() {}\n");
    }
    return { program: cargo, arguments_: ["check", "--offline"], environment: { RUSTC_WRAPPER: compiler, PROBE_EVENTS: events } };
  });
  if (otherUid) await verifyAcrossAccounts(Number(otherUid));
} finally {
  rmSync(root, { recursive: true });
}
