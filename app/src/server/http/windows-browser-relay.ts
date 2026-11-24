import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { createConnection, createServer, type Server, type Socket } from "node:net";

const keyBytes = 32;
const admissionTimeout = 5000;

function readProof(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(closed, admissionTimeout);
    deadline.unref();

    function cleanup() {
      clearTimeout(deadline);
      socket.off("readable", receive);
      socket.off("end", closed);
      socket.off("error", failed);
      socket.off("close", closed);
    }

    function failed(error: Error) {
      cleanup();
      reject(error);
    }

    function closed() {
      failed(new Error("Windows transport proof is unavailable"));
    }

    function receive() {
      const proof: unknown = socket.read(keyBytes);
      if (proof === null) return;
      cleanup();
      if (!Buffer.isBuffer(proof) || proof.length !== keyBytes) closed();
      else resolve(proof);
    }

    socket.on("readable", receive);
    socket.once("end", closed);
    socket.once("error", failed);
    socket.once("close", closed);
  });
}

function writeProof(socket: Socket, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function privateTransport(http: HttpServer, verify: (socket: Socket) => Promise<void>): Server {
  const listener = createServer({ pauseOnConnect: true }, (socket) => {
    const failed = () => {
      socket.destroy();
    };
    socket.on("error", failed);
    void verify(socket).then(() => {
      socket.off("error", failed);
      http.emit("connection", socket);
      socket.resume();
    }, failed);
  });
  listener.maxConnections = http.maxConnections;
  return listener;
}

/** Only the native broker's private connection enters the existing HTTP parser. */
export function createWindowsBrowserRelay(http: HttpServer, key: Uint8Array): Server {
  if (key.byteLength !== keyBytes) throw new Error("Invalid Windows browser relay key");
  const expected = Buffer.from(key);
  return privateTransport(http, async (socket) => {
    if (!timingSafeEqual(await readProof(socket), expected)) throw new Error("Unexpected browser relay proof");
  });
}

export function createWindowsAccountStop(key: string, stop: () => void): Server {
  const expected = Buffer.from(key, "hex");
  const listener = createServer({ pauseOnConnect: true }, (socket) => {
    void readProof(socket).then(
      (proof) => {
        if (timingSafeEqual(proof, expected)) {
          socket.end(Buffer.from([1]));
          stop();
        } else socket.destroy();
      },
      () => {
        socket.destroy();
      },
    );
  });
  listener.maxConnections = 4;
  return listener;
}

function accountProof(key: string, challenge: Buffer): Buffer {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update("workbench-windows-account-v1")
    .update(challenge)
    .digest();
}

export function createWindowsAccountTransport(http: HttpServer, key: string): Server {
  return privateTransport(http, async (socket) => {
    await writeProof(socket, accountProof(key, await readProof(socket)));
  });
}

/** Authenticate this connection before forwarding any browser headers, body, or worker credential. */
export async function windowsAccountConnection(path: string, key: string): Promise<Socket> {
  const socket = createConnection({ path });
  socket.on("error", () => {
    socket.destroy();
  });
  const challenge = randomBytes(keyBytes);
  const response = readProof(socket);
  void response.catch(() => undefined);
  try {
    await writeProof(socket, challenge);
    if (!timingSafeEqual(await response, accountProof(key, challenge)))
      throw new Error("Unexpected account worker proof");
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
