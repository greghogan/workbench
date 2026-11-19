import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, lstatSync, mkdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import { processCancellation } from "../../core/runtime/owned-child.mjs";
import { errorFrom } from "../../core/runtime/values.mjs";
import { settleCleanup } from "../../core/diagnostics/diagnostic-errors.mjs";
import { startProjectHub } from "../projects/project-hub.js";
import { WebError } from "./errors.js";

const workerToken = "WORKBENCH_ACCOUNT_WORKER_TOKEN";
const workerReady = "account worker ready";
const immediateConnectionHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface LinuxAccount {
  uid: number;
  gid: number;
  name: string;
  home: string;
}

type AccountIdentity = Pick<LinuxAccount, "uid" | "name" | "home">;

function sameAccount(account: LinuxAccount, identity: AccountIdentity): boolean {
  return account.uid === identity.uid && account.name === identity.name && account.home === identity.home;
}

export function linuxAccount(uid: number): LinuxAccount | undefined {
  if (!Number.isSafeInteger(uid) || uid <= 0) return undefined;
  let record: string;
  try {
    record = execFileSync("/usr/bin/getent", ["passwd", String(uid)], {
      encoding: "utf8",
      maxBuffer: 8192,
      timeout: 5000,
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
  const [name, , user, group, , home] = record.trimEnd().split(":");
  if (
    !name ||
    /[\r\n]/.test(record.trimEnd()) ||
    Number(user) !== uid ||
    !group ||
    !/^\d+$/.test(group) ||
    !Number.isSafeInteger(Number(group)) ||
    !home ||
    !isAbsolute(home)
  )
    return undefined;
  return { uid, gid: Number(group), name, home };
}

/** The worker starts after OS privilege reduction and only accepts the supervisor's Unix transport. */
export async function serveAccountWorker(distribution: string, socket: string): Promise<void> {
  const token = process.env[workerToken];
  Reflect.deleteProperty(process.env, workerToken);
  if (
    process.getuid?.() === undefined ||
    process.geteuid?.() === 0 ||
    !process.connected ||
    !process.send ||
    !token ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    !isAbsolute(socket)
  ) {
    throw new Error("Missing authorized Workbench worker launch");
  }
  const cancellation = processCancellation();
  const stop = () => {
    process.kill(process.pid, "SIGTERM");
  };
  process.once("disconnect", stop);
  try {
    const hub = await startProjectHub(distribution, { worker: { socket, token } });
    try {
      cancellation.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        cancellation.signal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
        hub.server.once("error", reject);
        process.send?.(workerReady, (error: Error | null) => {
          if (error) reject(error);
        });
      });
    } finally {
      await hub.close();
    }
  } finally {
    process.off("disconnect", stop);
    cancellation.close();
  }
}

function forwardingHeaders(headers: IncomingMessage["headers"]) {
  const remove = new Set([
    ...immediateConnectionHeaders,
    ...(headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase()),
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !remove.has(name)));
}

function forward(socket: string, token: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers = {
      ...forwardingHeaders(request.headers),
      host: request.headers.host,
      authorization: `Bearer ${token}`,
    };
    const outgoing = httpRequest(
      { socketPath: socket, path: request.url ?? "/", method: request.method, headers },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, forwardingHeaders(incoming.headers));
        incoming.pipe(response);
        incoming.once("error", reject);
      },
    );
    outgoing.once("error", reject);
    request.once("aborted", () => {
      outgoing.destroy();
    });
    response.once("close", () => {
      outgoing.destroy();
      resolve();
    });
    request.pipe(outgoing);
  });
}

async function openWorker(distribution: string, directory: string, account: LinuxAccount, signal: AbortSignal) {
  const nonce = randomBytes(12).toString("hex");
  const staging = join(directory, nonce);
  const source = join(staging, "hub.sock");
  const destination = join(directory, "ready", nonce);
  const token = randomBytes(32).toString("base64url");
  if (Buffer.byteLength(source) > 103)
    throw new Error("The Workbench service runtime directory is too long for a worker socket");
  mkdirSync(staging, { mode: 0o700 });
  chownSync(staging, account.uid, account.gid);
  const child = spawn(process.execPath, [join(distribution, "bundle/main.cjs"), "web-account", source], {
    uid: account.uid,
    gid: account.gid,
    cwd: account.home,
    env: {
      HOME: account.home,
      USER: account.name,
      LOGNAME: account.name,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      WORKBENCH_DISTRIBUTION_ROOT: distribution,
      [workerToken]: token,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    signal,
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("close", () => {
      try {
        if (lstatSync(destination, { throwIfNoEntry: false })) unlinkSync(destination);
        const socket = lstatSync(source, { throwIfNoEntry: false });
        if (socket?.isSocket() && socket.uid === account.uid) unlinkSync(source);
        removeEmptyDirectory(staging);
        resolve();
      } catch (error) {
        reject(errorFrom(error));
      }
    });
  });
  void exited.catch(() => undefined);
  const close = async () => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => {
        reject(new Error("The Workbench account worker stopped before startup"));
      });
      child.once("message", (message: unknown) => {
        if (message === workerReady) resolve();
        else reject(new Error("The Workbench account worker returned an invalid startup response"));
      });
    });
    renameSync(source, destination);
    const listener = lstatSync(destination);
    if (!listener.isSocket() || listener.uid !== account.uid)
      throw new Error("The Workbench account worker did not publish an authorized socket");
    return {
      forward: (request: IncomingMessage, response: ServerResponse) => forward(destination, token, request, response),
      close,
      exited,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

interface WorkerUse {
  worker: ReturnType<typeof openWorker>;
  account: LinuxAccount;
  cancellation: AbortController;
  requests: number;
  idle?: ReturnType<typeof setTimeout>;
  retiring?: Promise<void>;
}

function removeEmptyDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

export class AccountWorkers {
  private readonly workers = new Map<number, WorkerUse>();
  private closed = false;

  constructor(
    readonly distribution: string,
    readonly directory: string,
    readonly idleMilliseconds: number,
  ) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o711);
    mkdirSync(join(directory, "ready"), { mode: 0o700 });
  }

  async request(identity: AccountIdentity, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closed) throw new WebError(503, "Workbench service is stopping");
    let use = this.workers.get(identity.uid);
    if (use?.retiring) {
      await use.retiring;
      return this.request(identity, request, response);
    }
    if (!use || !sameAccount(use.account, identity)) {
      // Revalidate persistent browser sign-ins before starting a worker with OS authority.
      const account = linuxAccount(identity.uid);
      if (!account || !sameAccount(account, identity))
        throw new WebError(403, "The Workbench sign-in account is unavailable");
      if (use) {
        clearTimeout(use.idle);
        use.retiring = this.retire(use);
        await use.retiring;
        return this.request(identity, request, response);
      }
      const cancellation = new AbortController();
      const worker = openWorker(this.distribution, this.directory, account, cancellation.signal);
      const started: WorkerUse = { worker, account, cancellation, requests: 0 };
      this.workers.set(account.uid, started);
      const retire = () => {
        clearTimeout(started.idle);
        if (this.workers.get(account.uid) === started) this.workers.delete(account.uid);
      };
      void worker.then((value) => {
        void value.exited.then(retire, retire);
      }, retire);
      use = started;
    }
    clearTimeout(use.idle);
    use.requests++;
    try {
      const worker = await use.worker;
      if (!response.destroyed) await worker.forward(request, response);
    } catch (error) {
      throw new WebError(503, "The Workbench account worker is unavailable", { cause: errorFrom(error) });
    } finally {
      use.requests--;
      this.scheduleIdle(use);
    }
  }

  private scheduleIdle(use: WorkerUse): void {
    if (this.closed || !this.idleMilliseconds || use.requests !== 0 || use.retiring) return;
    use.idle = setTimeout(() => {
      use.retiring = this.retire(use);
    }, this.idleMilliseconds);
    use.idle.unref();
  }

  private async retire(use: WorkerUse): Promise<void> {
    await use.worker.then((worker) => worker.close()).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    await settleCleanup([
      async () => {
        await Promise.all(
          [...this.workers.values()].map(async ({ worker, idle, cancellation }) => {
            clearTimeout(idle);
            cancellation.abort();
            await worker.then(
              (value) => value.close(),
              () => undefined,
            );
          }),
        );
      },
      () => {
        removeEmptyDirectory(join(this.directory, "ready"));
      },
      () => {
        removeEmptyDirectory(this.directory);
      },
    ]);
  }
}
