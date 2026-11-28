import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const deadline = AbortSignal.timeout(90000);

async function waitFor(condition: () => boolean, subject: string) {
  try {
    while (!condition()) await delay(25, undefined, { signal: deadline });
  } catch (cause) {
    throw new Error(`Waiting for ${subject} exceeded the native jobserver fixture deadline`, { cause });
  }
}

if (process.argv[2] === "command") {
  const [, , , started, finish, network] = process.argv;
  assert(started && finish);
  if (network === "offline") {
    const interfaces = Object.values(networkInterfaces()).flat();
    assert(interfaces.length && interfaces.every((address) => address?.internal), "check must have only loopback");
  }
  writeFileSync(started, "", { flag: "wx" });
  await waitFor(() => existsSync(finish), "the owned test command to finish");
} else {
  const [, , runtime, launcher, firstHome, firstUid, firstGid, secondHome, secondUid, secondGid] = process.argv;
  assert(runtime && launcher && firstHome && firstUid && firstGid && secondHome && secondUid && secondGid);
  const socket = lstatSync(join(runtime, "jobs.sock"), { bigint: true });
  const endpoint = `${String(socket.dev)}:${String(socket.ino)}`;
  const receipts = join(runtime, "job-leases");
  const markers = join(runtime, "test-job-markers");
  mkdirSync(markers, { mode: 0o700 });
  chmodSync(markers, 0o1777);
  const clients: ReturnType<typeof spawn>[] = [];
  const launch = (label: string, key: string, home: string, uid: string, gid: string, gate = false) => {
    const started = join(markers, `${label}.started`);
    const finish = join(markers, `${label}.finish`);
    const options = {
      uid: Number(uid),
      gid: Number(gid),
      cwd: home,
      env: { HOME: home, PATH: "/usr/bin:/bin", WORKBENCH_SYSTEM_RUNTIME_DIRECTORY: runtime },
    };
    const command = [process.execPath, import.meta.filename, "command", started, finish];
    let args = ["admitted-check", endpoint, key.repeat(64), "--", ...command];
    if (gate) {
      const project = join(home, "offline-project");
      const records = join(project, "workbench");
      for (const path of [project, records]) {
        mkdirSync(path, { mode: 0o755 });
        chownSync(path, options.uid, options.gid);
      }
      const configuration = `schema_version = 1
[markdown]
wrap_width = 120
[compatibility]
required = false

[[check]]
name = "Offline check"
role = "test"
command = ${JSON.stringify([...command, "offline"])}
`;
      for (const [name, contents] of [
        ["projects.toml", '[[project]]\nid="offline"\npath="."\n'],
        ["config.toml", configuration],
      ] as const) {
        const path = join(records, name);
        writeFileSync(path, contents, { mode: 0o600 });
        chownSync(path, options.uid, options.gid);
      }
      options.cwd = project;
      const registered = spawnSync(process.execPath, [launcher, "project", "add", project], {
        ...options,
        encoding: "utf8",
        timeout: 15000,
      });
      assert.equal(registered.status, 0, registered.stderr);
      args = [
        "check",
        "--plain",
        "--verbose",
        "--environment",
        "native",
        "--stage",
        "commit",
        "--role",
        "test",
        "--no-cache",
      ];
    }
    const child = spawn(process.execPath, [launcher, ...args], { ...options, stdio: ["ignore", "pipe", "pipe"] });
    clients.push(child);
    const closed = once(child, "close");
    let diagnostics = "";
    for (const stream of [child.stdout, child.stderr])
      stream.setEncoding("utf8").on("data", (text: string) => {
        diagnostics = (diagnostics + text).slice(-8192);
      });
    const wait = (condition: () => boolean, subject: string) =>
      Promise.race([
        waitFor(condition, subject),
        closed.then(([code, signal]) => {
          throw new Error(
            `${label} launcher exited before ${subject} (status ${String(code ?? signal)}): ${diagnostics}`,
          );
        }),
      ]);
    return { child, closed, started, finish, wait, diagnostics: () => diagnostics };
  };

  try {
    const first = launch("first", "a", firstHome, firstUid, firstGid);
    await first.wait(() => existsSync(first.started), "the first account to start a check");
    assert.equal(lstatSync(first.started).uid, Number(firstUid));
    const second = launch("second", "b", secondHome, secondUid, secondGid, true);
    await second.wait(() => second.diagnostics().includes("job limit"), "the second account to wait on the shared cap");
    assert.equal(existsSync(second.started), false);
    assert.equal(readdirSync(receipts).length, 1);
    first.child.kill("SIGKILL");
    assert.deepEqual(await first.closed, [null, "SIGKILL"]);
    assert.equal(existsSync(second.started), false);
    assert.equal(readdirSync(receipts).length, 1);
    writeFileSync(first.finish, "");
    await second.wait(() => existsSync(second.started), "the second account to acquire the recovered slot");
    assert.equal(lstatSync(second.started).uid, Number(secondUid));
    writeFileSync(second.finish, "");
    assert.deepEqual(await second.closed, [0, null], second.diagnostics());
    await waitFor(() => readdirSync(receipts).length === 0, "the service to release both leases");
    console.log(
      "Verified offline check admission across two accounts and lease recovery after a launcher exits abruptly.",
    );
  } finally {
    for (const label of ["first", "second"]) writeFileSync(join(markers, `${label}.finish`), "");
    for (const child of clients) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}
