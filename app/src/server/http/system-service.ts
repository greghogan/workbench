import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { userConfigValues } from "../../core/configuration/user-config.js";
import { launchdSocketsActivated, launchdSystemDirectory } from "../../core/distribution/distribution-identity.js";
import { executableIdentity } from "../../core/distribution/executable-identity.js";
import {
  diagnostic,
  DiagnosticOperation,
  DiagnosticOutcome,
  LogLevel,
  settleCleanup,
} from "../../core/diagnostics/diagnostics.mjs";
import { readBoundedFile } from "../../core/runtime/file-reads.js";
import { writeAtomic } from "../../core/runtime/file-publication.mjs";
import { processCancellation } from "../../core/runtime/owned-child.mjs";
import { errorFrom, isRecord } from "../../core/runtime/values.mjs";
import {
  CacheLockState,
  inspectCacheMetadataLock,
  recoverCacheMetadataLock,
  withCacheLocksSync,
} from "../../core/storage/cache-lock.js";
import { demonstrationBase } from "../projects/project-mounts.js";
import { isBrowserUsername, localBrowserUsername, systemSignOutPath } from "./browser-auth.js";
import { WebError } from "./errors.js";
import {
  closeLocalServer,
  createLocalServer,
  listenInherited,
  listenLocal,
  listenUnix,
  localEndpoint,
} from "./http-listener.js";
import { requestOrigin, secureResponse, send } from "./http.js";
import { WebMetrics } from "./observability.js";
import { activePrivateListenerProcesses } from "./system-ownership.js";
import { checkInstalledServiceStart } from "../../core/distribution/installed-release.js";
import { notifySystemdServiceReady, systemdServiceProcess } from "../../core/distribution/systemd-service.js";
import { AccountWorkers, serviceAccount, type ServiceAccount } from "./system-workers.js";

const browserCredentialBytes = 32;
const browserCredentialPattern = /^[A-Za-z0-9_-]{43}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const maximumControlBytes = 1024;
const maximumAccountSessions = 32;
const maximumSessions = 2048;
const serviceReadinessQuery = "release-ready";

function browserCredentialDigest(credential: string): string {
  // The stored lookup key is for a generated 256-bit browser credential.
  return createHash("sha256").update(credential).digest("hex");
}

export function serviceRelease(distribution: string): string {
  const { repository, revision, directory } = executableIdentity(distribution);
  return createHash("sha256")
    .update(JSON.stringify(revision ? [repository, revision] : [directory]))
    .digest("hex");
}

function runtimePath(): string {
  return process.platform === "darwin"
    ? launchdSystemDirectory
    : (process.env.WORKBENCH_SYSTEM_RUNTIME_DIRECTORY ?? "/run/workbench");
}

function protectedPath(path: string): void {
  if (!isAbsolute(path)) throw new Error("System service paths must be absolute");
  const current = lstatSync(path);
  if (current.isSymbolicLink() || current.uid !== 0 || current.mode & 0o022)
    throw new Error(`${path}: system service requires administrator-owned, protected paths`);
  if (dirname(path) !== path) protectedPath(dirname(path));
}

function controlPaths(runtime: string) {
  return { control: join(runtime, "control.sock"), requests: join(runtime, "login") };
}

export function systemServicePending(): boolean {
  if (process.platform !== "linux" && process.platform !== "darwin") return false;
  const runtime = runtimePath();
  const lease = lstatSync(join(runtime, "system.lock"), { throwIfNoEntry: false });
  if (!lease) return false;
  protectedPath(runtime);
  return lease.isDirectory() && lease.uid === 0 && !(lease.mode & 0o077);
}

function privateProof(root: string, proof: string): number | undefined {
  if (!browserCredentialPattern.test(proof)) return undefined;
  const path = join(root, proof);
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry?.isDirectory() || entry.uid === 0 || (entry.mode & 0o777) !== 0o700) return undefined;
  try {
    rmdirSync(path);
    return entry.uid;
  } catch {
    return undefined;
  }
}

interface Session {
  uid: number;
  user: string;
  home: string;
  expires: number;
}

class BrowserSessions {
  private stored = new Map<string, Session>();

  constructor(
    readonly path: string | undefined,
    readonly origin: string,
    readonly lifetime: number,
  ) {
    if (path === undefined) return;
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (!existing) return;
    if (!existing.isFile() || existing.uid !== 0 || existing.mode & 0o077)
      throw new Error("System browser credentials require a protected administrator-owned file");
    const input: unknown = JSON.parse(readBoundedFile(path, 1024 * 1024, "system browser credentials").toString());
    if (!isRecord(input) || input.version !== 1 || !isRecord(input.sessions))
      throw new Error("Invalid system browser credentials");
    if (input.origin !== origin) {
      this.save();
      return;
    }
    for (const [digest, data] of Object.entries(input.sessions)) {
      if (
        !digestPattern.test(digest) ||
        !isRecord(data) ||
        typeof data.uid !== "number" ||
        !Number.isSafeInteger(data.uid) ||
        data.uid <= 0 ||
        !isBrowserUsername(data.user) ||
        typeof data.home !== "string" ||
        typeof data.expires !== "number" ||
        !Number.isSafeInteger(data.expires)
      )
        throw new Error("Invalid system browser credentials");
      if (data.expires > Date.now())
        this.stored.set(digest, { uid: data.uid, user: data.user, home: data.home, expires: data.expires });
    }
  }

  private save(sessions = this.stored): void {
    if (this.path === undefined) return;
    writeAtomic(
      this.path,
      JSON.stringify({ version: 1, origin: this.origin, sessions: Object.fromEntries(sessions) }),
      0o600,
    );
  }

  issue(account: ServiceAccount): string {
    if (!isBrowserUsername(account.name)) throw new Error("The OS account name cannot be used for browser sign-in");
    const credential = randomBytes(browserCredentialBytes).toString("base64url");
    const digest = browserCredentialDigest(credential);
    const now = Date.now();
    const next = new Map([...this.stored].filter(([, item]) => item.expires > now));
    const personal = [...next].filter(([, item]) => item.uid === account.uid);
    for (const [oldest] of personal.slice(0, Math.max(0, personal.length - maximumAccountSessions + 1)))
      next.delete(oldest);
    if (next.size >= maximumSessions) throw new Error("The Workbench system sign-in capacity is exhausted");
    next.set(digest, {
      uid: account.uid,
      user: account.name,
      home: account.home,
      expires: now + this.lifetime,
    });
    this.save(next);
    this.stored = next;
    return credential;
  }

  find(authorization: string | undefined): { digest: string; session: Session } | undefined {
    if (!authorization || authorization.length > 1024) return undefined;
    const encoded = /^Basic +([A-Za-z0-9+/]+={0,2})$/i.exec(authorization)?.[1];
    if (!encoded) return undefined;
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 1) return undefined;
    const user = decoded.slice(0, separator),
      credential = decoded.slice(separator + 1);
    if (!browserCredentialPattern.test(credential)) return undefined;
    const digest = browserCredentialDigest(credential);
    const session = this.stored.get(digest);
    return session?.user === user && session.expires > Date.now() ? { digest, session } : undefined;
  }

  revoke(digest: string): void {
    if (!this.stored.has(digest)) return;
    const next = new Map(this.stored);
    next.delete(digest);
    this.save(next);
    this.stored = next;
  }
}

function boundedControl(socket: Socket, complete: (payload: string) => void): void {
  const chunks: Buffer[] = [];
  let length = 0;
  socket.setTimeout(5000, () => {
    socket.destroy();
  });
  socket.on("error", () => {
    socket.destroy();
  });
  socket.on("data", (chunk: Buffer) => {
    length += chunk.length;
    if (length > maximumControlBytes) socket.destroy();
    else chunks.push(chunk);
  });
  socket.once("end", () => {
    complete(Buffer.concat(chunks).toString("utf8"));
  });
}

export async function startSystemService(distribution: string, options: { host?: "127.0.0.1" | "::1"; port?: number }) {
  const launchd = process.platform === "darwin";
  if ((!launchd && process.platform !== "linux") || process.getuid?.() !== 0 || process.geteuid?.() !== 0)
    throw new Error("System Workbench service startup requires a qualified administrator installation");
  const preferences = userConfigValues();
  const { host, port } = localEndpoint({ ...options, port: options.port ?? Number(preferences["daemon.system_port"]) });
  if (launchd) {
    if (process.env[launchdSocketsActivated] !== "1" || !port || host !== "127.0.0.1")
      throw new Error("Start the installed Workbench LaunchDaemon to acquire its protected endpoints");
    Reflect.deleteProperty(process.env, launchdSocketsActivated);
  } else {
    const firstUnprivileged = Number(readFileSync("/proc/sys/net/ipv4/ip_unprivileged_port_start", "utf8").trim());
    if (!Number.isSafeInteger(firstUnprivileged) || port === 0 || port >= firstUnprivileged)
      throw new Error("Choose a fixed Workbench system port that ordinary accounts cannot bind on this host");
  }
  protectedPath(distribution);
  protectedPath(join(distribution, "bundle/main.cjs"));
  protectedPath(process.execPath);
  const runtime = runtimePath();
  const state = process.env.WORKBENCH_SYSTEM_STATE_DIRECTORY ?? "/var/lib/workbench";
  protectedPath(runtime);
  if (!launchd) protectedPath(state);
  const { control, requests } = controlPaths(runtime);
  const origin = new URL(`http://${host === "::1" ? "[::1]" : host}:${String(port)}`).origin;
  const release = serviceRelease(distribution);
  const cancellation = processCancellation();
  const lease = join(runtime, "system");
  try {
    const previous = inspectCacheMetadataLock(lease);
    if (previous.state === CacheLockState.Abandoned) recoverCacheMetadataLock(lease, { expected: previous.digest });
    await withCacheLocksSync(
      [lease],
      async () => {
        const endpoint = lstatSync(control, { throwIfNoEntry: false });
        if (endpoint && (!endpoint.isSocket() || endpoint.uid !== 0))
          throw new Error("The system control path is already occupied");
        if (launchd) {
          if (!endpoint || (endpoint.mode & 0o777) !== 0o666)
            throw new Error("Launchd did not publish the administrator-owned Workbench control socket");
        } else {
          if (endpoint) unlinkSync(control);
          mkdirSync(requests, { recursive: true, mode: 0o700 });
        }
        const inbox = lstatSync(requests);
        if (!inbox.isDirectory() || inbox.uid !== 0 || (launchd && (inbox.mode & 0o7777) !== 0o1733))
          throw new Error("The system sign-in directory is not administrator-owned");
        if (!launchd) chmodSync(requests, 0o1733);
        const sessions = new BrowserSessions(
          launchd ? undefined : join(state, "browser-sessions.json"),
          origin,
          Number(preferences["daemon.session_seconds"]) * 1000,
        );
        const workers = new AccountWorkers(
          distribution,
          join(runtime, "workers-" + randomBytes(5).toString("hex")),
          Number(preferences["daemon.worker_idle_seconds"]) * 1000,
        );
        const handleBrowser = async (request: IncomingMessage, response: ServerResponse) => {
          secureResponse(response);
          try {
            if (requestOrigin(request) !== origin)
              throw new WebError(403, "Use the loopback address printed by workbench serve");
            const access = sessions.find(request.headers.authorization);
            if (!access) {
              response.setHeader("www-authenticate", 'Basic realm="Workbench", charset="UTF-8"');
              send(response, 401, "text/plain", "Enter the sign-in credential printed by workbench serve.\n");
              return;
            }
            const current = new URL(request.url ?? "/", "http://workbench.invalid");
            if (current.origin !== "http://workbench.invalid")
              throw new WebError(400, "Request URL is outside this service");
            if (current.pathname === systemSignOutPath && request.method === "POST") {
              if (!request.headers.origin) throw new WebError(403, "The sign-out request requires a same-origin form");
              sessions.revoke(access.digest);
              send(response, 200, "text/plain", "Signed out of Workbench. Run workbench serve to sign in again.\n");
              return;
            }
            const { uid, user, home } = access.session;
            await workers.request({ uid, name: user, home }, request, response);
          } catch (error) {
            if (response.destroyed) return;
            if (response.headersSent) response.destroy();
            else
              send(
                response,
                error instanceof WebError ? error.status : 500,
                "text/plain",
                error instanceof WebError ? error.message : "Workbench system request failed",
              );
          }
        };
        const browser = createLocalServer(handleBrowser, new WebMetrics());
        const additionalBrowser = launchd ? createLocalServer(handleBrowser, new WebMetrics()) : undefined;
        let listening = false;
        const controlClients = new Set<Socket>();
        const signIn = createServer({ allowHalfOpen: true }, (socket) => {
          controlClients.add(socket);
          socket.once("close", () => controlClients.delete(socket));
          boundedControl(socket, (payload) => {
            try {
              if (launchd && payload === serviceReadinessQuery + "\n" + release) {
                socket.end(JSON.stringify({ ready: listening, pid: process.pid }));
                return;
              }
              if (launchd && !listening) {
                socket.end(JSON.stringify({ waiting: true }));
                return;
              }
              const [claim, client] = payload.split("\n");
              if (!claim || release !== client) {
                socket.end(JSON.stringify({ error: "A different Workbench release owns the system service" }));
                return;
              }
              const uid = privateProof(requests, claim);
              const account = uid === undefined ? undefined : serviceAccount(uid);
              if (!account) {
                socket.end(JSON.stringify({ error: "Workbench could not verify the account requesting sign-in" }));
                return;
              }
              const password = sessions.issue(account);
              socket.end(JSON.stringify({ origin, username: account.name, password, pid: process.pid }));
            } catch {
              socket.end(JSON.stringify({ error: "Workbench system sign-in is unavailable" }));
            }
          });
        });
        signIn.maxConnections = 16;
        try {
          const signal = cancellation.signal;
          checkInstalledServiceStart(distribution, launchd || systemdServiceProcess());
          if (launchd) await listenInherited(signIn, 5);
          if (activePrivateListenerProcesses().length) {
            diagnostic(
              LogLevel.Info,
              DiagnosticOperation.WebService,
              DiagnosticOutcome.Waiting,
              {},
              undefined,
              "waiting for private Workbench listeners to stop",
            );
            while (activePrivateListenerProcesses().length) await delay(200, undefined, { signal });
          }
          signal.throwIfAborted();
          if (additionalBrowser) {
            await listenInherited(browser, 3);
            await listenInherited(additionalBrowser, 4);
          } else {
            await listenLocal(browser, host, port);
            await listenUnix(signIn, control);
            chmodSync(control, 0o666);
            notifySystemdServiceReady();
          }
          listening = true;
          console.log(`Workbench web UI: ${origin}`);
          if (!cancellation.signal.aborted)
            await new Promise<void>((resolve, reject) => {
              cancellation.signal.addEventListener(
                "abort",
                () => {
                  resolve();
                },
                { once: true },
              );
              browser.once("error", reject);
              additionalBrowser?.once("error", reject);
              signIn.once("error", reject);
            });
        } finally {
          listening = false;
          diagnostic(LogLevel.Info, DiagnosticOperation.WebService, DiagnosticOutcome.Stopping);
          await settleCleanup([
            async () => {
              for (const socket of controlClients) socket.destroy();
              await new Promise<void>((resolve, reject) => {
                if (!signIn.listening) {
                  resolve();
                  return;
                }
                signIn.close((error) => {
                  if (error) reject(error);
                  else resolve();
                });
              });
              diagnostic(LogLevel.Info, DiagnosticOperation.WebService, DiagnosticOutcome.Stopped, {
                component: "control listener",
              });
            },
            async () => {
              await workers.close();
              diagnostic(LogLevel.Info, DiagnosticOperation.WebService, DiagnosticOutcome.Stopped, {
                component: "account workers",
              });
            },
            () => closeLocalServer(browser),
            () => (additionalBrowser ? closeLocalServer(additionalBrowser) : undefined),
            () => {
              if (launchd) return;
              try {
                rmdirSync(requests);
              } catch (error) {
                if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
              }
            },
          ]);
          diagnostic(LogLevel.Info, DiagnosticOperation.WebService, DiagnosticOutcome.Stopped);
        }
      },
      { mutable: false },
    );
  } catch (error) {
    if (!cancellation.signal.aborted || !(error instanceof Error) || error.name !== "AbortError") throw error;
  } finally {
    cancellation.close();
  }
}

export async function launchDaemonReady(distribution: string, pid: number, signal: AbortSignal): Promise<boolean> {
  const runtime = runtimePath();
  protectedPath(runtime);
  const { control } = controlPaths(runtime);
  const endpoint = lstatSync(control, { throwIfNoEntry: false });
  if (!endpoint) return false;
  if (!endpoint.isSocket() || endpoint.uid !== 0)
    throw new Error("The Workbench LaunchDaemon control socket ownership changed during the update");
  const query = serviceReadinessQuery + "\n" + serviceRelease(distribution);
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ path: control, signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
    socket.once("error", () => {
      if (signal.aborted) reject(errorFrom(signal.reason));
      else resolve(false);
    });
    socket.once("connect", () => {
      socket.end(query);
    });
    boundedControl(socket, (reply) => {
      try {
        const value: unknown = JSON.parse(reply);
        resolve(isRecord(value) && value.ready === true && value.pid === pid);
      } catch {
        resolve(false);
      }
    });
    socket.once("close", () => {
      if (signal.aborted) reject(errorFrom(signal.reason));
      else resolve(false);
    });
  });
}

export async function discoverSystemService(distribution: string, demo: boolean, signal: AbortSignal) {
  if ((process.platform !== "linux" && process.platform !== "darwin") || process.getuid?.() === 0) return undefined;
  const runtime = runtimePath();
  const { control, requests } = controlPaths(runtime);
  const endpoint = lstatSync(control, { throwIfNoEntry: false });
  if (!endpoint) return undefined;
  if (!endpoint.isSocket() || endpoint.uid !== 0)
    throw new Error("The Workbench system control socket is not administrator-owned");
  protectedPath(runtime);
  if ((endpoint.mode & 0o222) !== 0o222) return undefined;
  const inbox = lstatSync(requests, { throwIfNoEntry: false });
  if (!inbox?.isDirectory() || inbox.uid !== 0 || (inbox.mode & 0o7777) !== 0o1733)
    throw new Error("The Workbench system sign-in directory is unavailable");
  const proof = randomBytes(32).toString("base64url");
  const path = join(requests, proof);
  mkdirSync(path, { mode: 0o700 });
  const retireProof = () => {
    try {
      rmdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        diagnostic(
          LogLevel.Warn,
          DiagnosticOperation.WebService,
          DiagnosticOutcome.Failed,
          {},
          undefined,
          "could not retire the system sign-in proof",
        );
    }
  };
  try {
    const release = serviceRelease(distribution);
    const payload = await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection({ path: control, signal });
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.end(`${proof}\n${release}`);
      });
      boundedControl(socket, (reply) => {
        try {
          resolve(JSON.parse(reply) as unknown);
        } catch {
          reject(new Error("Invalid Workbench system sign-in response"));
        }
      });
      socket.once("close", () => {
        reject(new Error("Workbench system sign-in connection closed"));
      });
    });
    if (process.platform === "darwin" && isRecord(payload) && payload.waiting === true) return undefined;
    if (isRecord(payload) && typeof payload.error === "string") throw new Error(payload.error);
    if (
      !isRecord(payload) ||
      typeof payload.origin !== "string" ||
      !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?$/.test(payload.origin) ||
      new URL(payload.origin).origin !== payload.origin ||
      payload.username !== localBrowserUsername() ||
      typeof payload.password !== "string" ||
      !browserCredentialPattern.test(payload.password) ||
      typeof payload.pid !== "number" ||
      !Number.isSafeInteger(payload.pid) ||
      payload.pid <= 0
    )
      throw new Error("Invalid Workbench system sign-in response");
    return {
      url: payload.origin + (demo ? demonstrationBase.replace(/\/$/, "") : ""),
      signIn: { username: payload.username, password: payload.password },
      pid: payload.pid,
      logs: undefined,
      shared: true,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "darwin" && (code === "ENOENT" || code === "ECONNREFUSED") && !systemServicePending())
      return undefined;
    throw error;
  } finally {
    retireProof();
  }
}
