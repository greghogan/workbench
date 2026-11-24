import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { listenUnix } from "../../../src/server/http/http-listener.ts";
import { createWindowsBrowserRelay } from "../../../src/server/http/windows-browser-relay.ts";

async function request(path: string, chunks: readonly Buffer[]) {
  const socket = createConnection({ path });
  try {
    const output: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => output.push(chunk));
    const closed = once(socket, "close");
    void closed.catch(() => undefined);
    await once(socket, "connect");
    for (const chunk of chunks) await write(socket, chunk);
    await closed;
    return Buffer.concat(output).toString();
  } finally {
    socket.destroy();
  }
}

function write(socket: Socket, chunk: Buffer) {
  return new Promise<void>((resolve, reject) => {
    socket.write(chunk, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test("the browser relay admits keyed HTTP and preserves buffered bytes across fragmented admission", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wb-relay-"));
  const path =
    process.platform === "win32" ? `\\\\.\\pipe\\Workbench-Relay-Test-${randomUUID()}` : join(directory, "relay.sock");
  const key = randomBytes(32);
  const seen: string[] = [];
  const http = createServer((incoming, reply) => {
    seen.push(incoming.url ?? "");
    reply.setHeader("Content-Type", "text/plain");
    reply.setHeader("Content-Length", "12");
    reply.write("first ");
    reply.end("second");
  });
  http.maxConnections = 2;
  const relay = createWindowsBrowserRelay(http, key);
  const browser = Buffer.from("GET /projects HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
  try {
    await listenUnix(relay, path);
    expect(await request(path, [Buffer.concat([randomBytes(32), browser])])).toBe("");
    expect(seen).toEqual([]);
    const response = await request(path, [key.subarray(0, 11), Buffer.concat([key.subarray(11), browser])]);
    expect(seen).toEqual(["/projects"]);
    expect(response).toMatch(/^HTTP\/1\.1 200/);
    expect(response.split("\r\n\r\n")[1]).toBe("first second");
  } finally {
    if (relay.listening)
      await new Promise<void>((resolve, reject) => {
        relay.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    rmSync(directory, { recursive: true, force: true });
  }
});
