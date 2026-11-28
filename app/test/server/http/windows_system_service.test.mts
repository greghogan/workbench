import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request, type IncomingMessage } from "node:http";
import { createServer as createNetServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { listenUnix } from "../../../src/server/http/http-listener.ts";
import { createWindowsAccountTransport } from "../../../src/server/http/windows-browser-relay.ts";
import { createWindowsSystemBrowser } from "../../../src/server/http/windows-system-service.ts";

test("Windows browser sessions stay isolated across forged and recreated account workers", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-windows-system-"));
  const socket = (name: string) =>
    process.platform === "win32" ? `\\\\.\\pipe\\Workbench-Test-${randomUUID()}` : join(root, name + ".sock");
  const origin = "http://127.0.0.1:38080";
  const entry = socket("entry");
  const servers = new Set<Server>();
  const actor = (index: number) => ({
    sid: `S-1-5-21-123-456-789-${String(index)}`,
    username: "same-name",
    socket: socket(`account-${String(index)}`),
    workerKey: randomBytes(32).toString("hex"),
  });
  const worker = (account: ReturnType<typeof actor>) =>
    createWindowsAccountTransport(
      createHttpServer((incoming, reply) => {
        if (incoming.headers.authorization !== `Bearer ${account.workerKey}`) {
          reply.writeHead(403).end();
          return;
        }
        reply.end(account.sid);
      }),
      account.workerKey,
    );
  let replacement: ReturnType<typeof actor> | undefined;
  const recreated: string[] = [];
  const browser = createWindowsSystemBrowser(origin, 60_000, {
    async resume(sid) {
      const next = replacement;
      if (next?.sid !== sid) throw new Error("Worker unavailable");
      recreated.push(sid);
      await start(worker(next), next.socket);
      return next;
    },
  });

  async function start(server: Server, path: string): Promise<void> {
    await listenUnix(server, path);
    servers.add(server);
  }

  async function close(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    servers.delete(server);
  }

  async function browse(password?: string, path = "/", method = "GET") {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const incoming = (response: IncomingMessage) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("error", reject);
        response.once("end", () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      };
      const outgoing = request(
        {
          socketPath: entry,
          path,
          method,
          headers: {
            host: new URL(origin).host,
            origin,
            connection: "close",
            ...(password ? { authorization: `Basic ${Buffer.from(`same-name:${password}`).toString("base64")}` } : {}),
          },
        },
        incoming,
      );
      outgoing.once("error", reject);
      outgoing.end();
    });
  }

  try {
    const first = actor(1201);
    const second = actor(1202);
    const firstWorker = worker(first);
    await start(firstWorker, first.socket);
    await start(worker(second), second.socket);
    await start(browser.server, entry);
    const firstPassword = browser.attach(first);
    const secondPassword = browser.attach(second);
    expect((await browse()).status).toBe(401);
    expect(await browse(firstPassword)).toEqual({ status: 200, body: first.sid });
    expect(await browse(secondPassword)).toEqual({ status: 200, body: second.sid });

    await close(firstWorker);
    const observed: Buffer[] = [];
    const forged = createNetServer((peer) => {
      peer.on("data", (bytes: Buffer) => {
        observed.push(bytes);
        peer.end(randomBytes(32));
      });
    });
    await start(forged, first.socket);
    expect((await browse(firstPassword)).status).toBe(503);
    expect(Buffer.concat(observed)).toHaveLength(32);
    await close(forged);
    replacement = actor(1201);
    expect(await Promise.all([browse(firstPassword), browse(firstPassword)])).toEqual([
      { status: 200, body: first.sid },
      { status: 200, body: first.sid },
    ]);
    expect(recreated).toEqual([first.sid]);
    expect(await browse(secondPassword)).toEqual({ status: 200, body: second.sid });
    expect((await browse(secondPassword, "/sign-out", "POST")).status).toBe(200);
    expect((await browse(secondPassword)).status).toBe(401);
  } finally {
    await Promise.all([...servers].map(close));
    rmSync(root, { recursive: true, force: true });
  }
});
