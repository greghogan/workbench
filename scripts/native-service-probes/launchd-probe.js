import assert from "node:assert/strict";
import console from "node:console";
import { readFileSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import process from "node:process";

function binding(host, port, ipv6Only = false) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen({ host, port, ipv6Only, exclusive: true }, () => resolve(server));
  });
}

const [mode, ...args] = process.argv.slice(2);
switch (mode) {
  case "bind-check": {
    const [port, expectedUid] = args.map(Number);
    assert.equal(process.getuid(), expectedUid);
    const results = {};
    for (const [name, host, ipv6Only] of [
      ["loopback4", "127.0.0.1", false],
      ["wildcard4", "0.0.0.0", false],
      ["loopback6", "::1", true],
      ["wildcard6", "::", true],
      ["dualStack", "::", false],
    ]) {
      try {
        const server = await binding(host, port, ipv6Only);
        await new Promise((resolve) => {
          server.close(resolve);
        });
        results[name] = "listened";
      } catch (error) {
        results[name] = error.code;
      }
    }
    console.log(JSON.stringify(results));
    break;
  }
  case "serve": {
    assert.equal(process.getuid(), 0);
    const server = await binding("127.0.0.1", Number(args[0]));
    process.once("SIGTERM", () => server.close());
    break;
  }
  case "connect": {
    const socket = createConnection({ host: "127.0.0.1", port: Number(args[0]) });
    socket.setTimeout(2000, () => socket.destroy(new Error("listener check timed out")));
    await new Promise((resolve, reject) => {
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
    });
    break;
  }
  case "activation-pid": {
    const [port, host] = args;
    const socket = createConnection({ host, port: Number(port) });
    socket.setTimeout(12000, () => socket.destroy(new Error("launchd activation timed out")));
    socket.setEncoding("ascii");
    let response = "";
    for await (const data of socket) {
      response += data;
      assert(response.length < 64);
    }
    const match = /^workbench-activation:([1-9][0-9]*)\n$/.exec(response);
    assert(match, "The listener did not return a probe process identity");
    console.log(match[1]);
    break;
  }
  case "worker": {
    const [home, other, owner, proof] = args;
    assert.equal(process.getuid(), Number(owner));
    assert.equal(readFileSync(home, "utf8"), "own fixture\n");
    assert.throws(() => readFileSync(other), { code: "EACCES" });
    writeFileSync(proof, String(owner) + "\n", { mode: 0o600, flag: "wx" });
    break;
  }
  default:
    throw new Error("Select a launchd probe mode");
}
