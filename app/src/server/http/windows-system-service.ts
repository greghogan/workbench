import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { userConfigValues } from "../../core/configuration/user-config.js";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../../core/diagnostics/diagnostics.mjs";
import {
  queryWindowsService,
  requestWindowsService,
  windowsMainService,
  windowsServiceHelper,
} from "../../core/distribution/windows-service.js";
import { processCancellation } from "../../core/runtime/owned-child.mjs";
import { isRecord } from "../../core/runtime/values.mjs";
import { startProjectHub } from "../projects/project-hub.js";
import { demonstrationBase } from "../projects/project-mounts.js";
import { isBrowserUsername, localBrowserUsername, systemSignOutPath } from "./browser-auth.js";
import { WebError } from "./errors.js";
import { createLocalServer, listenUnix } from "./http-listener.js";
import { requestOrigin, secureResponse, send } from "./http.js";
import { WebMetrics } from "./observability.js";
import { startWindowsJobserver } from "./windows-jobserver.js";
import { serviceRelease } from "./system-service.js";
import { forwardAccountRequest } from "./system-workers.js";
import {
  createWindowsAccountTransport,
  createWindowsAccountStop,
  createWindowsBrowserRelay,
  windowsAccountConnection,
} from "./windows-browser-relay.js";

const hexKey = /^[a-f0-9]{64}$/;
const noncePattern = /^[a-f0-9]{32}$/;
const windowsSid = /^S-1-(?:\d{1,10}-){1,15}\d{1,10}$/;
const passwordPattern = /^[A-Za-z0-9_-]{43}$/;
const maximumControlBytes = 2048;
const maximumReplyBytes = 1024;
const workerDraining = 170;
const execFileAsync = promisify(execFile);

export async function discoverWindowsSystem(distribution: string, demo: boolean, signal: AbortSignal) {
  const helper = windowsServiceHelper(distribution);
  if (!helper) return undefined;
  let announcedWait = false;
  for (;;) {
    const observed = await queryWindowsService(helper, signal);
    if (observed.state === "unregistered" || observed.state === "stopped") return undefined;
    if (observed.state !== "running") {
      if (!announcedWait) {
        diagnostic(
          LogLevel.Info,
          DiagnosticOperation.WebService,
          DiagnosticOutcome.Waiting,
          { state: observed.state },
          undefined,
          "waiting for the shared Windows Workbench listener",
        );
        announcedWait = true;
      }
      await delay(250, undefined, { signal });
      continue;
    }
    const result = await requestWindowsService(helper, ["launch", windowsMainService], signal);
    if (result.status === 1062 && !result.error) continue;
    if (result.status === workerDraining && !result.error) {
      await delay(250, undefined, { signal });
      continue;
    }
    if (result.error || result.status !== 0)
      throw new Error("Could not obtain sign-in from the Workbench Windows service", {
        cause: result.error ?? result.stderr,
      });
    let reply: unknown;
    try {
      reply = JSON.parse(result.stdout);
    } catch {
      throw new Error("Invalid Workbench Windows sign-in response");
    }
    if (!isRecord(reply) || reply.release !== serviceRelease(distribution))
      throw new Error("A different Workbench release owns the Windows service, or sign-in is unavailable");
    if (
      typeof reply.origin !== "string" ||
      !/^http:\/\/127\.0\.0\.1(?::[1-9]\d{0,4})?$/.test(reply.origin) ||
      new URL(reply.origin).origin !== reply.origin ||
      reply.username !== localBrowserUsername() ||
      typeof reply.password !== "string" ||
      !passwordPattern.test(reply.password) ||
      reply.pid !== observed.pid
    )
      throw new Error("Invalid Workbench Windows sign-in response");
    return {
      url: reply.origin + (demo ? demonstrationBase : ""),
      signIn: { username: reply.username, password: reply.password },
      pid: observed.pid,
      logs: undefined,
      shared: true,
    };
  }
}

function relayPipe(nonce: string): string {
  return "\\\\.\\pipe\\Workbench-Browser-" + nonce;
}

function accountPipe(nonce: string): string {
  return "\\\\.\\pipe\\Workbench-Account-" + nonce;
}

function accountStopPipe(nonce: string): string {
  return "\\\\.\\pipe\\Workbench-Account-Stop-" + nonce;
}

function number(text: string | undefined, maximum: number): number {
  const value = text && /^[1-9]\d*$/.test(text) ? Number(text) : 0;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
    throw new Error("Invalid Windows service control number");
  return value;
}

async function* frames(input: Readable): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (pending.length + end - start >= maximumControlBytes)
        throw new Error("Windows service control frame is too large");
      pending = Buffer.concat([pending, chunk.subarray(start, end)]);
      if (newline < 0) break;
      yield pending.toString("utf8").replace(/\r$/, "");
      pending = Buffer.alloc(0);
      start = newline + 1;
    }
  }
  if (pending.length) throw new Error("Incomplete Windows service control frame");
}

function emitFrame(output: Writable, value: unknown): Promise<void> {
  const frame = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(frame) >= maximumReplyBytes) throw new Error("Windows service reply is too large");
  return new Promise<void>((resolve, reject) => {
    output.write(frame, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

interface Account {
  sid: string;
  username: string;
  socket: string;
  workerKey: string;
}
type Worker = Pick<Account, "socket" | "workerKey">;
interface WorkerLifecycle {
  resume(sid: string): Promise<Worker>;
  idle?: { milliseconds: number; retire(sid: string): Promise<void> };
}
interface WorkerUse {
  requests: number;
  idle?: NodeJS.Timeout;
  retiring?: Promise<void>;
}

async function controlWindowsWorker(
  helper: string,
  operation: "resume" | "retire",
  sid: string,
  signal: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    // The coordinator's SCM job already owns this fixed native helper and its process lifetime.
    const result = await execFileAsync(helper, [operation, windowsMainService, sid], {
      cwd: dirname(helper),
      maxBuffer: 4096,
      timeout: Math.max(1, deadline - Date.now()),
      windowsHide: true,
      signal,
    }).then(
      ({ stdout }) => ({ stdout, status: 0 }),
      (error: unknown) => ({
        stdout: undefined,
        status: isRecord(error) && typeof error.code === "number" ? error.code : undefined,
      }),
    );
    if (result.stdout !== undefined) return result.stdout;
    if (result.status !== workerDraining || Date.now() >= deadline) {
      const detail = result.status === undefined ? "" : ` (Windows error ${String(result.status)})`;
      throw new Error(`Could not ${operation} the Windows account worker${detail}`);
    }
    await delay(250, undefined, { signal });
  }
}

async function resumeWindowsWorker(helper: string, sid: string, signal: AbortSignal): Promise<Worker> {
  const stdout = await controlWindowsWorker(helper, "resume", sid, signal);
  let reply: unknown;
  try {
    reply = JSON.parse(stdout);
  } catch {
    throw new Error("Invalid Windows account worker response");
  }
  if (
    !isRecord(reply) ||
    typeof reply.nonce !== "string" ||
    !noncePattern.test(reply.nonce) ||
    typeof reply.key !== "string" ||
    !hexKey.test(reply.key)
  )
    throw new Error("Invalid Windows account worker response");
  return { socket: accountPipe(reply.nonce), workerKey: reply.key };
}

function attachAccount(frame: string): Account {
  const [operation, sid, name, worker, workerKey, ...extra] = frame.split(" ");
  if (
    operation !== "attach" ||
    !sid ||
    !windowsSid.test(sid) ||
    !name ||
    !/^(?:[a-f0-9]{2})+$/.test(name) ||
    !worker ||
    !noncePattern.test(worker) ||
    !workerKey ||
    !hexKey.test(workerKey) ||
    extra.length
  )
    throw new Error("Invalid Windows account attachment");
  const bytes = Buffer.from(name, "hex");
  const username = bytes.toString("utf8");
  if (!Buffer.from(username).equals(bytes) || !isBrowserUsername(username))
    throw new Error("Invalid Windows browser username");
  return { sid, username, socket: accountPipe(worker), workerKey };
}

interface Session {
  identity: string;
  username: string;
  expires: number;
}

/** Windows caller authority is captured by the SCM host during local sign-in. */
export function createWindowsSystemBrowser(origin: string, lifetime: number, workers?: WorkerLifecycle) {
  const accounts = new Map<string, Account>();
  const sessions = new Map<string, Session>();
  const pending = new Map<string, Promise<Account>>();
  const use = new Map<string, WorkerUse>();
  let stopped = false;
  const sessionKey = randomBytes(32);
  const credentialId = (token: string) => createHmac("sha256", sessionKey).update(token).digest("hex");

  function workerUse(sid: string): WorkerUse {
    const state = use.get(sid);
    if (state) return state;
    const created = { requests: 0 };
    use.set(sid, created);
    return created;
  }

  function scheduleIdle(sid: string, state: WorkerUse): void {
    clearTimeout(state.idle);
    const idle = workers?.idle;
    if (stopped || !idle?.milliseconds || state.requests !== 0 || state.retiring || use.get(sid) !== state) return;
    state.idle = setTimeout(() => {
      state.retiring = idle
        .retire(sid)
        .catch((error: unknown) => {
          delete state.retiring;
          diagnostic(LogLevel.Warn, DiagnosticOperation.WorkspaceWorker, DiagnosticOutcome.Failed, {}, error);
        })
        .finally(() => {
          if (!accounts.has(sid) && state.requests === 0 && use.get(sid) === state) use.delete(sid);
        });
    }, idle.milliseconds);
    state.idle.unref();
  }

  async function connect(account: Account, retiring?: Promise<void>) {
    if (!retiring) {
      try {
        return { account, socket: await windowsAccountConnection(account.socket, account.workerKey) };
      } catch (error) {
        if (!workers) throw error;
      }
    }
    if (!workers) throw new Error("The Windows account worker is unavailable");
    await retiring;
    let opening = pending.get(account.sid);
    if (!opening) {
      const latest = accounts.get(account.sid);
      if (!latest) throw new Error("The Windows account session has expired");
      if (latest !== account && !retiring)
        return { account: latest, socket: await windowsAccountConnection(latest.socket, latest.workerKey) };
      opening = workers.resume(account.sid).then(
        (worker) => {
          const replacement = { ...latest, ...worker };
          if (accounts.get(account.sid) === latest) accounts.set(account.sid, replacement);
          return accounts.get(account.sid) ?? replacement;
        },
        (error: unknown) => {
          diagnostic(LogLevel.Warn, DiagnosticOperation.WorkspaceWorker, DiagnosticOutcome.Failed, {}, error);
          throw error;
        },
      );
      pending.set(account.sid, opening);
    }
    let current: Account;
    try {
      current = await opening;
    } finally {
      if (pending.get(account.sid) === opening) pending.delete(account.sid);
    }
    return { account: current, socket: await windowsAccountConnection(current.socket, current.workerKey) };
  }

  const server = createLocalServer(async (request, response) => {
    secureResponse(response);
    try {
      if (requestOrigin(request) !== origin)
        throw new WebError(403, "Use the loopback address printed by workbench serve");
      const header = request.headers.authorization;
      const encoded =
        header && header.length <= 1024 ? /^Basic +([A-Za-z0-9+/]+={0,2})$/i.exec(header)?.[1] : undefined;
      const authentication = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
      const split = authentication.indexOf(":");
      const credential = authentication.slice(split + 1);
      const key = split > 0 && passwordPattern.test(credential) ? credentialId(credential) : "";
      const session = sessions.get(key);
      const account = session && accounts.get(session.identity);
      if (
        !session ||
        !account ||
        session.expires <= Date.now() ||
        session.username !== authentication.slice(0, split)
      ) {
        response.setHeader("www-authenticate", 'Basic realm="Workbench", charset="UTF-8"');
        send(response, 401, "text/plain", "Enter the sign-in credential printed by workbench serve.\n");
        return;
      }
      const path = new URL(request.url ?? "/", origin);
      if (path.origin !== origin) throw new WebError(400, "Request URL is outside this service");
      if (path.pathname === systemSignOutPath && request.method === "POST") {
        if (!request.headers.origin) throw new WebError(403, "The sign-out request requires a same-origin form");
        sessions.delete(key);
        send(response, 200, "text/plain", "Signed out of Workbench. Run workbench serve to sign in again.\n");
        return;
      }
      const state = workerUse(account.sid);
      clearTimeout(state.idle);
      state.requests++;
      try {
        const { account: selected, socket: worker } = await connect(account, state.retiring);
        delete state.retiring;
        if (request.destroyed || response.destroyed) {
          worker.destroy();
          return;
        }
        await forwardAccountRequest(selected.socket, selected.workerKey, request, response, worker);
      } finally {
        state.requests--;
        scheduleIdle(account.sid, state);
      }
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else
        send(
          response,
          error instanceof WebError ? error.status : 503,
          "text/plain",
          error instanceof WebError
            ? error.message
            : "The Workbench account worker is unavailable. Run workbench serve again.",
        );
    }
  }, new WebMetrics());

  function attach(account: Account): string {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (session.expires <= now || (session.identity === account.sid && session.username !== account.username))
        sessions.delete(key);
    }
    const personal = [...sessions].filter(([, session]) => session.identity === account.sid);
    for (const [oldest] of personal.slice(0, Math.max(0, personal.length - 31))) sessions.delete(oldest);
    if (sessions.size >= 2048) throw new Error("The Workbench system sign-in capacity is exhausted");
    const active = new Set([...sessions.values()].map((session) => session.identity));
    for (const sid of accounts.keys()) {
      if (active.has(sid) || sid === account.sid) continue;
      accounts.delete(sid);
      const state = use.get(sid);
      if (state?.requests === 0 && (!workers?.idle?.milliseconds || state.retiring)) {
        clearTimeout(state.idle);
        use.delete(sid);
      }
    }
    const state = workerUse(account.sid);
    if (accounts.get(account.sid)?.socket !== account.socket) delete state.retiring;
    accounts.set(account.sid, account);
    const credential = randomBytes(32).toString("base64url");
    sessions.set(credentialId(credential), {
      identity: account.sid,
      username: account.username,
      expires: now + lifetime,
    });
    scheduleIdle(account.sid, state);
    return credential;
  }
  function stopIdle(): void {
    stopped = true;
    for (const state of use.values()) clearTimeout(state.idle);
  }
  return { server, attach, stopIdle };
}

/** The named pipe binds only after SCM gives this child its private relay key on inherited stdin. */
export async function serveWindowsSystem(distribution: string, input: Readable, output: Writable): Promise<void> {
  if (process.platform !== "win32" || process.env.WORKBENCH_WINDOWS_SCM !== "1")
    throw new Error("Windows system startup requires the Workbench SCM host");
  const resumeCapable = process.env.WORKBENCH_WINDOWS_WORKER_RESUME === "1";
  const idleCapable = process.env.WORKBENCH_WINDOWS_WORKER_IDLE === "1";
  Reflect.deleteProperty(process.env, "WORKBENCH_WINDOWS_SCM");
  Reflect.deleteProperty(process.env, "WORKBENCH_WINDOWS_WORKER_RESUME");
  Reflect.deleteProperty(process.env, "WORKBENCH_WINDOWS_WORKER_IDLE");
  const pending = frames(input);
  const startup = await pending.next();
  if (startup.done) throw new Error("Missing Windows service initialization");
  const [operation, configuredPort, processId, nonce, proof, ...extra] = startup.value.split(" ");
  if (operation !== "open" || !nonce || !noncePattern.test(nonce) || !proof || !hexKey.test(proof) || extra.length)
    throw new Error("Invalid Windows service initialization");
  const port = number(configuredPort, 65_535);
  const pid = number(processId, 0xffff_ffff);
  const origin = new URL(`http://127.0.0.1:${String(port)}`).origin;
  const shutdown = new AbortController();
  const helper = resumeCapable ? windowsServiceHelper(distribution) : undefined;
  if (resumeCapable && !helper) throw new Error("The Windows service helper is unavailable");
  const preferences = userConfigValues();
  const jobserver = helper ? startWindowsJobserver(helper, nonce, preferences) : undefined;
  const { server, attach, stopIdle } = createWindowsSystemBrowser(
    origin,
    Number(preferences["daemon.session_seconds"]) * 1000,
    helper
      ? {
          resume: (sid) => resumeWindowsWorker(helper, sid, shutdown.signal),
          ...(idleCapable
            ? {
                idle: {
                  milliseconds: Number(preferences["daemon.worker_idle_seconds"]) * 1000,
                  async retire(sid) {
                    await controlWindowsWorker(helper, "retire", sid, shutdown.signal);
                  },
                },
              }
            : {}),
        }
      : undefined,
  );
  const relay = createWindowsBrowserRelay(server, Buffer.from(proof, "hex"));
  const release = serviceRelease(distribution);
  try {
    await listenUnix(relay, relayPipe(nonce));
    diagnostic(LogLevel.Info, DiagnosticOperation.WebService, DiagnosticOutcome.Started, { port, pid });
    await emitFrame(output, { ready: true });
    for await (const frame of pending) {
      if (frame === "stop") break;
      let reply: unknown;
      try {
        if (frame.startsWith("jobs ")) {
          reply = jobserver
            ? await jobserver.request(frame)
            : { error: "The Windows machine jobserver is unavailable" };
        } else {
          const account = attachAccount(frame);
          const password = attach(account);
          reply = { origin, username: account.username, password, pid, release };
        }
      } catch (error) {
        if (frame.startsWith("jobs ")) {
          diagnostic(LogLevel.Warn, DiagnosticOperation.WebService, DiagnosticOutcome.Failed, {}, error);
          reply = { error: "Could not verify the Windows machine job request" };
        } else {
          reply = { error: "Could not attach a Windows account worker" };
        }
      }
      await emitFrame(output, reply);
    }
  } finally {
    stopIdle();
    shutdown.abort();
    await jobserver?.close();
    server.closeAllConnections();
    if (relay.listening)
      await new Promise<void>((resolve, reject) => {
        relay.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    diagnostic(LogLevel.Info, DiagnosticOperation.WebService, DiagnosticOutcome.Stopped, { port, pid });
  }
}

/** SCM starts this process under the caller's Windows token and owns its Windows job. */
export async function serveWindowsAccount(distribution: string): Promise<void> {
  const nonce = process.env.WORKBENCH_WINDOWS_ACCOUNT_PIPE;
  const token = process.env.WORKBENCH_WINDOWS_ACCOUNT_KEY;
  Reflect.deleteProperty(process.env, "WORKBENCH_WINDOWS_ACCOUNT_PIPE");
  Reflect.deleteProperty(process.env, "WORKBENCH_WINDOWS_ACCOUNT_KEY");
  if (process.platform !== "win32" || !nonce || !noncePattern.test(nonce) || !token || !hexKey.test(token))
    throw new Error("Missing authorized Windows account worker launch");
  const cancellation = processCancellation();
  const owned = new AbortController();
  const signal = AbortSignal.any([cancellation.signal, owned.signal]);
  try {
    const hub = await startProjectHub(distribution, {
      worker: {
        socket: accountPipe(nonce),
        token,
        transport: (server) => createWindowsAccountTransport(server, token),
      },
    });
    const control = createWindowsAccountStop(token, () => {
      owned.abort();
    });
    try {
      await listenUnix(control, accountStopPipe(nonce));
      if (!signal.aborted)
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
          hub.server.once("error", reject);
          control.once("error", reject);
        });
    } finally {
      try {
        if (control.listening)
          await new Promise<void>((resolve, reject) => {
            control.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          });
      } finally {
        await hub.close();
      }
    }
  } finally {
    cancellation.close();
  }
}
