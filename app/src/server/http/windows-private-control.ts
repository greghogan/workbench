import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  queryWindowsService,
  requestWindowsService,
  windowsMainService,
} from "../../core/distribution/windows-service.js";
import { windowsExecutableArgument } from "../../core/runtime/windows-arguments.mjs";
import { listenUnix } from "./http-listener.js";

export const maximumWindowsPrivateReply = 1024;
const execFileAsync = promisify(execFile);

export async function openWindowsPrivateAdmission() {
  const marker = createServer({ pauseOnConnect: true }, (socket) => socket.destroy());
  await listenUnix(marker, `\\\\.\\pipe\\Workbench-Private-Admission-${String(process.pid)}`);
  return () =>
    new Promise<void>((resolve, reject) => {
      marker.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
}

export async function windowsSystemInUse(helper: string | undefined, signal: AbortSignal): Promise<boolean> {
  if (helper) {
    const { state } = await queryWindowsService(helper, signal);
    return state !== "stopped" && state !== "unregistered";
  }
  // A source checkout may run an ordinary foreground server without a packaged native helper.
  const root = process.env.SystemRoot;
  if (!root || !isAbsolute(root)) throw new Error("Cannot inspect the Windows Workbench service without SystemRoot");
  const powerShell = join(root, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const script = `
$ErrorActionPreference = 'Stop'
$service = New-Object System.ServiceProcess.ServiceController '${windowsMainService}'
try { [int] $service.Status }
catch {
    $problem = $_.Exception
    while ($problem.InnerException) { $problem = $problem.InnerException }
    if ($problem -is [ComponentModel.Win32Exception] -and $problem.NativeErrorCode -eq 1060) { 1 }
    else { throw }
} finally { $service.Dispose() }
`;
  const { stdout } = await execFileAsync(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    maxBuffer: 4096,
    timeout: 10_000,
    windowsHide: true,
    signal,
  });
  const state = stdout.trim();
  if (!/^[1-7]$/.test(state)) throw new Error("Invalid Windows Workbench service status");
  return state !== "1";
}

export function windowsPrivateInstance(lease: string): string {
  return createHash("sha256")
    .update(realpathSync.native(dirname(lease)))
    .digest("hex")
    .slice(0, 32);
}

export async function readWindowsPrivateControl(helper: string, instance: string, signal: AbortSignal) {
  const result = await requestWindowsService(helper, ["private-read", instance], signal);
  if (!result.error && (result.status === 2 || result.status === 231)) return undefined;
  if (result.error || result.status !== 0)
    throw new Error("Could not verify the Windows private Workbench listener", {
      cause: result.error ?? result.stderr,
    });
  return Buffer.from(result.stdout, "utf8");
}

/** Keep the actual process handle through readiness without passing the CLI's handles to the server. */
export async function launchWindowsPrivateDaemon(
  helper: string,
  directory: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  const node = process.execPath;
  const command = [node, ...args].map(windowsExecutableArgument).join(" ");
  const child = spawn(helper, ["private-launch", node, directory, command], {
    cwd: dirname(helper),
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });
  const failed = new Promise<never>((_resolve, reject) => {
    child.once("error", reject);
    child.stdin.once("error", reject);
  });
  const exited = Promise.race([closed, failed]).then((status) => {
    throw new Error(`Windows private Workbench exited before discovery (${String(status)}). Inspect 'workbench logs'.`);
  });
  void exited.catch(() => undefined);
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const finish = async (keep: boolean) => {
    child.stdin.end(keep ? "1" : "0");
    const status = await closed;
    if (keep && status !== 0) throw new Error("Windows private Workbench did not complete startup");
  };
  try {
    const started: Promise<unknown[]> = once(lines, "line", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    const [reported] = await Promise.race([started, exited]);
    const pid = Number(reported);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff)
      throw new Error("Invalid Windows private Workbench process identity");
    return { pid, exited, finish };
  } catch (error) {
    await finish(false);
    throw error;
  } finally {
    lines.close();
  }
}

/** The small native listener retains a reply in memory and exits with its owning Node process. */
export async function openWindowsPrivateControl(helper: string, instance: string, reply: string, signal: AbortSignal) {
  if (Buffer.byteLength(reply) > maximumWindowsPrivateReply)
    throw new Error("Windows private Workbench sign-in exceeds the local control limit");
  const child = spawn(helper, ["private-listen", instance, String(process.pid)], {
    cwd: dirname(helper),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });
  const failed = new Promise<never>((_resolve, reject) => {
    child.once("error", reject);
    child.stdin.once("error", reject);
  });
  const exited = closed.then(() => {
    throw new Error(`Windows private Workbench control exited with status ${String(child.exitCode)}`);
  });
  void exited.catch(() => undefined);
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  };
  try {
    const ready: Promise<unknown[]> = once(lines, "line", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    child.stdin.end(reply + "\n");
    const [message] = await Promise.race([ready, failed, exited]);
    if (message !== "ready") throw new Error("Invalid Windows private Workbench control readiness");
    return { exited, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    lines.close();
  }
}
