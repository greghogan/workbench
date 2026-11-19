import { createHash } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { combineFailures } from "../diagnostics/diagnostic-errors.mjs";
import { readBoundedFile } from "../runtime/file-reads.js";
import { writeNew } from "../runtime/file-publication.mjs";
import { captureOwnedChild } from "../runtime/owned-child.mjs";
import { isRecord } from "../runtime/values.mjs";
import { withCacheLock } from "../storage/cache-lock.js";
import { archiveInstallationEnvironment, readDistributionSource } from "./distribution-identity.js";
import { installedServiceLauncher, windowsStableHelper, type ReleaseActivation } from "./installed-release.js";
import { recoverReleaseLock, type ReleaseServiceRegistration } from "./release-transition.js";
import { windowsMainService, windowsNativeHelper } from "./windows-service-paths.mjs";

export { windowsMainService };

type WindowsServiceState = "unregistered" | "starting" | "running" | "stopping" | "stopped";
type Operation = "register" | "unregister" | "inspect" | "start" | "stop";
const receiptName = "windows-service.json";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface Registration {
  version: 1;
  node: string;
  port: number;
  helper: string;
}

export function windowsServiceHelper(distribution: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const helper = join(distribution, windowsNativeHelper);
  const entry = lstatSync(helper, { throwIfNoEntry: false });
  if (!entry) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error("The Workbench Windows service helper is not a regular release file");
  return helper;
}

export function requestWindowsService(helper: string, args: string[], signal = new AbortController().signal) {
  return captureOwnedChild(helper, args, { cwd: dirname(helper), env: process.env, signal }, 4096);
}

export async function queryWindowsService(helper: string, signal?: AbortSignal) {
  const result = await requestWindowsService(helper, ["status", windowsMainService], signal);
  if (result.error || result.status !== 0)
    throw new Error("Could not inspect the Workbench Windows service", { cause: result.error ?? result.stderr });
  const info: unknown = JSON.parse(result.stdout);
  const states: readonly WindowsServiceState[] = ["unregistered", "starting", "running", "stopping", "stopped"];
  if (
    !isRecord(info) ||
    typeof info.state !== "string" ||
    !states.some((state) => state === info.state) ||
    typeof info.pid !== "number" ||
    !Number.isSafeInteger(info.pid) ||
    info.pid < 0 ||
    (info.state === "running" && !info.pid)
  )
    throw new Error("Invalid Workbench Windows service state");
  return { state: info.state as WindowsServiceState, pid: info.pid };
}

function installation(launcher: string) {
  const directory = join(dirname(launcher), ".workbench-installation");
  return { launcher, helper: join(directory, windowsStableHelper), receipt: join(directory, receiptName) };
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}

function readRegistration(launcher: string) {
  const paths = installation(launcher);
  if (!lstatSync(paths.receipt, { throwIfNoEntry: false })) return undefined;
  const bytes = readBoundedFile(paths.receipt, 4096, "Windows service registration");
  const stored: unknown = JSON.parse(bytes.toString());
  if (
    !isRecord(stored) ||
    stored.version !== 1 ||
    typeof stored.node !== "string" ||
    !isAbsolute(stored.node) ||
    !validPort(stored.port) ||
    typeof stored.helper !== "string" ||
    stored.helper !== digest(readBoundedFile(paths.helper, 4 * 1024 * 1024, "stable Windows service helper"))
  )
    throw new Error("Invalid Workbench Windows service registration");
  const record: Registration = { version: 1, node: stored.node, port: stored.port, helper: stored.helper };
  return { ...paths, record, digest: digest(bytes) };
}

type Service = NonNullable<ReturnType<typeof readRegistration>>;

async function nativeOperation(service: Service, command: Operation) {
  const result = await requestWindowsService(service.helper, [
    command,
    windowsMainService,
    service.record.node,
    service.launcher,
    String(service.record.port),
  ]);
  if (result.error || result.status !== 0)
    throw new Error(`Windows service ${command} failed. Run this operation from an administrator terminal.`, {
      cause: result.error ?? result.stderr,
    });
}

export async function installWindowsService(distribution: string, port: number) {
  if (!validPort(port)) throw new Error("Select a fixed Windows system service port from 1 through 65535");
  if (!process.env[archiveInstallationEnvironment] || !readDistributionSource(distribution))
    throw new Error("Install a verified system Workbench release before registering its Windows service");
  const packaged = windowsServiceHelper(distribution);
  if (!packaged) throw new Error("This Workbench release has no qualified Windows service helper");
  const launcher = installedServiceLauncher(distribution);
  const paths = installation(launcher);
  return withCacheLock(paths.receipt, async () => {
    const existing = readRegistration(launcher);
    if (existing) {
      if (existing.record.port !== port || existing.record.node !== process.execPath)
        throw new Error("Preserving the existing Workbench Windows service settings");
      await nativeOperation(existing, "register");
      return windowsMainService;
    }
    const helper = readBoundedFile(packaged, 4 * 1024 * 1024, "verified Windows service helper");
    const record: Registration = { version: 1, node: process.execPath, port, helper: digest(helper) };
    const contents = Buffer.from(JSON.stringify(record) + "\n");
    if (lstatSync(paths.helper, { throwIfNoEntry: false })) {
      if (!readBoundedFile(paths.helper, 4 * 1024 * 1024, "stable Windows service helper").equals(helper))
        throw new Error("Preserving an existing Windows service launcher");
    } else {
      writeNew(paths.helper, helper, 0o755);
    }
    writeNew(paths.receipt, contents, 0o600);
    await nativeOperation({ ...paths, record, digest: digest(contents) }, "register");
    return windowsMainService;
  });
}

export async function removeWindowsService(distribution: string): Promise<string | undefined> {
  const launcher = installedServiceLauncher(distribution);
  return withCacheLock(installation(launcher).receipt, async () => {
    const registered = readRegistration(launcher);
    if (!registered) return undefined;
    await nativeOperation(registered, "unregister");
    unlinkSync(registered.receipt);
    return windowsMainService;
  });
}

async function waitForState(service: Service, state: "running" | "stopped", previous?: number): Promise<void> {
  for (;;) {
    const observed = await queryWindowsService(service.helper);
    if (observed.state === state && observed.pid !== previous) return;
    if (observed.state === "unregistered" || (state === "running" && observed.state === "stopped"))
      throw new Error("The Windows service did not start the selected Workbench release");
    if (state === "running" && observed.state === "running" && observed.pid === previous)
      throw new Error("The Windows service did not replace its previous process");
    await delay(250);
  }
}

async function restart(service: Service, previous?: number): Promise<void> {
  await nativeOperation(service, "start");
  await waitForState(service, "running", previous);
}

export async function activateWindowsRelease(
  transition: ReleaseActivation,
  assertIdle: (exceptPid?: number) => void,
): Promise<void> {
  const { receipt } = installation(transition.launcher);
  await withCacheLock(receipt, async () => {
    const registered = readRegistration(transition.launcher);
    if (!registered) {
      assertIdle();
      transition.select();
      return;
    }
    await nativeOperation(registered, "inspect");
    const observed = await queryWindowsService(registered.helper);
    if (observed.state === "stopped") {
      assertIdle();
      transition.select();
      return;
    }
    if (observed.state !== "running") throw new Error("The Windows service is changing state. Wait and try again.");
    assertIdle(observed.pid);
    transition.begin({ manager: "scm", scope: "system", path: receipt, digest: registered.digest });
    try {
      await nativeOperation(registered, "stop");
      await waitForState(registered, "stopped");
      assertIdle();
      transition.select();
      await restart(registered, observed.pid);
    } catch (failure) {
      try {
        await nativeOperation(registered, "stop");
        await waitForState(registered, "stopped");
        transition.restore();
        await restart(registered);
        transition.finishRestoration();
      } catch (restoration) {
        throw combineFailures(failure, restoration, "Could not restore the previous Workbench Windows service");
      }
      throw failure;
    }
  });
}

export async function recoverWindowsRelease(
  launcher: string,
  restore: () => void,
  service: ReleaseServiceRegistration | undefined,
  assertIdle: (exceptPid?: number) => void,
): Promise<void> {
  const { receipt } = installation(launcher);
  if (service && (service.manager !== "scm" || service.scope !== "system" || service.path !== receipt))
    throw new Error("Recover the release with the original Windows service registration");
  recoverReleaseLock(receipt);
  await withCacheLock(receipt, async () => {
    if (!service) {
      assertIdle();
      restore();
      return;
    }
    const registered = readRegistration(launcher);
    if (registered?.digest !== service.digest)
      throw new Error("The Workbench Windows service registration changed. Preserve the recovery receipt.");
    await nativeOperation(registered, "inspect");
    await nativeOperation(registered, "stop");
    await waitForState(registered, "stopped");
    assertIdle();
    restore();
    await restart(registered);
  });
}
