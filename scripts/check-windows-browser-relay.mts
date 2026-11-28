import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { listenUnix } from "../app/src/server/http/http-listener.ts";
import { createWindowsBrowserRelay } from "../app/src/server/http/windows-browser-relay.ts";

if (process.platform !== "win32" || process.argv.length !== 3)
  throw new Error(
    "Run with administrator authority on a disposable Windows host and supply the compiled relay fixture",
  );

const binary = resolve(process.argv[2] ?? "");
const pipe = "\\\\.\\pipe\\Workbench-Browser-" + randomBytes(16).toString("hex");
const key = randomBytes(32);
const available = createTcpServer();
available.listen(0, "127.0.0.1");
await once(available, "listening");
const address = available.address();
assert.ok(address && typeof address !== "string");
await new Promise<void>((resolve) => {
  available.close(() => {
    resolve();
  });
});
const port = String(address.port);
const origin = "http://127.0.0.1:" + port;

function configure(operation: "reserve" | "release") {
  const result = spawnSync(binary, [operation, port], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
}

async function bridge(pid: number, exercise: () => Promise<void>) {
  const owned = spawn(binary, ["relay", port, pipe, String(pid)], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stopped = once(owned, "close");
  void stopped.catch(() => undefined);
  let diagnostic = "";
  owned.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(diagnostic) < 2048) diagnostic += chunk.subarray(0, 2048).toString();
  });
  owned.stdin.on("error", () => undefined);
  const lines = createInterface({ input: owned.stdout });
  try {
    const ready = once(lines, "line", { signal: AbortSignal.timeout(10_000) });
    owned.stdin.write(key);
    const response = await Promise.race([
      ready,
      stopped.then(() => {
        throw new Error("The relay stopped before listening. " + diagnostic);
      }),
    ]);
    assert.deepEqual(response, ["ready"]);
    await exercise();
  } finally {
    owned.stdin.end();
    lines.close();
    const timeout = setTimeout(() => owned.kill(), 10_000);
    try {
      assert.deepEqual(await stopped, [0, null], diagnostic);
    } finally {
      clearTimeout(timeout);
    }
  }
}

let reached = 0;
let releaseStream!: () => void;
const drained = new Promise<void>((resolve) => {
  releaseStream = resolve;
});
const http = createHttpServer((request, response) => {
  reached++;
  response.setHeader("Content-Type", "text/plain");
  response.write("first");
  if (request.url === "/stream") {
    response.once("close", releaseStream);
  } else {
    response.end("second");
  }
});
http.maxConnections = 4;
const relay = createWindowsBrowserRelay(http, key);
let reserved = false;
try {
  configure("reserve");
  reserved = true;
  await listenUnix(relay, pipe);
  await bridge(process.pid + 1, async () => {
    await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(5000) }));
    assert.equal(reached, 0);
  });
  await bridge(process.pid, async () => {
    const finite = await fetch(origin, { signal: AbortSignal.timeout(5000) });
    assert.equal(await finite.text(), "firstsecond");
    const stream = await fetch(origin + "/stream", { signal: AbortSignal.timeout(15_000) });
    assert.ok(stream.body);
    const initial = await stream.body.getReader().read();
    assert.equal(Buffer.from(initial.value ?? []).toString(), "first");
  });
  await Promise.race([
    drained,
    once(AbortSignal.timeout(5000), "abort").then(() => assert.fail("Relay left a stream open")),
  ]);
  assert.equal(reached, 2);
  console.log("Windows reserved loopback relay verified controller identity, response streaming and shutdown.");
} finally {
  http.closeAllConnections();
  try {
    if (relay.listening)
      await new Promise<void>((resolve) => {
        relay.close(() => {
          resolve();
        });
      });
  } finally {
    if (reserved) configure("release");
  }
}
