import { createHash } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { combineFailures } from "../diagnostics/diagnostic-errors.mjs";
import { readBoundedFile } from "../runtime/file-reads.js";
import { writeNew } from "../runtime/file-publication.mjs";
import { captureOwnedChild, processCancellation } from "../runtime/owned-child.mjs";
import { isRecord } from "../runtime/values.mjs";
import { windowsExecutableArgument } from "../runtime/windows-arguments.mjs";
import { withCacheLock } from "../storage/cache-lock.js";
import { archiveInstallationEnvironment, readDistributionSource } from "./distribution-identity.js";
import {
  assertInstalledWindowsTaskLauncher,
  installedServiceLauncher,
  windowsTaskStartupReceipt,
  type ReleaseActivation,
} from "./installed-release.js";
import { recoverReleaseLock, type ReleaseServiceRegistration } from "./release-transition.js";
import { windowsServiceHelper } from "./windows-service.js";

const schedulerScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$owner = $identity.User.Value
$name = 'Workbench.Private.' + $owner
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$existing = @($folder.GetTasks(1) | Where-Object { $_.Name -eq $name })

function Account-Sid([string] $Id) {
    if ($Id -match '^S-1-[0-9-]+$') { return $Id }
    return [Security.Principal.NTAccount]::new($Id).Translate([Security.Principal.SecurityIdentifier]).Value
}

function Check-Owned($Task) {
    $definition = $Task.Definition
    $principal = $definition.Principal
    if ((Account-Sid $principal.UserId) -ne $owner -or $principal.LogonType -ne 3 -or
        $principal.RunLevel -ne 0 -or $definition.Actions.Count -ne 1 -or $definition.Triggers.Count -ne 1) {
        throw 'Preserving a different Windows task registration.'
    }
    $action = $definition.Actions.Item(1)
    $trigger = $definition.Triggers.Item(1)
    if ($action.Type -ne 0 -or $action.Path -ne $request.node -or
        $action.Arguments -cne $request.arguments -or $action.WorkingDirectory -ne $request.directory -or
        $trigger.Type -ne 9 -or (Account-Sid $trigger.UserId) -ne $owner -or -not $trigger.Enabled -or
        -not $definition.Settings.Enabled -or $definition.Settings.MultipleInstances -ne 2) {
        throw 'Preserving a modified Windows task registration.'
    }
}

if ($existing.Count -gt 1) { throw 'Windows returned ambiguous Workbench task registrations.' }
$registered = if ($existing.Count -eq 1) { $existing[0] }
if ($registered) { Check-Owned $registered }
if ($request.operation -in 'inspect', 'start' -and -not $registered) {
    throw 'The expected Workbench task registration is missing.'
}
if ($request.operation -eq 'register' -and $existing.Count -eq 0) {
    $definition = $scheduler.NewTask(0)
    $definition.RegistrationInfo.Description = 'Workbench private browser server'
    $definition.Principal.UserId = $owner
    $definition.Principal.LogonType = 3
    $definition.Principal.RunLevel = 0
    $definition.Settings.ExecutionTimeLimit = 'PT0S'
    $definition.Settings.MultipleInstances = 2
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $trigger = $definition.Triggers.Create(9)
    $trigger.UserId = $owner
    $action = $definition.Actions.Create(0)
    $action.Path = $request.node
    $action.Arguments = $request.arguments
    $action.WorkingDirectory = $request.directory
    $registered = $folder.RegisterTaskDefinition($name, $definition, 2, $owner, $null, 3, $null)
    Check-Owned $registered
} elseif ($request.operation -eq 'remove' -and $existing.Count -eq 1) {
    if ($existing[0].State -in 2, 4) { throw 'Stop the Workbench task before removing its registration.' }
    $folder.DeleteTask($name, 0)
    $registered = $null
} elseif ($request.operation -eq 'start') {
    $null = $registered.Run($null)
}
$state = 'stopped'
$processId = 0
if ($registered -and $request.operation -in 'inspect', 'start') {
    $instances = $registered.GetInstances(0)
    if ($instances.Count -gt 1) { throw 'Windows returned ambiguous running Workbench tasks.' }
    if ($instances.Count -eq 1) { $processId = [int]$instances.Item(1).EnginePID }
    if ($processId -gt 0) { $state = 'running' }
    elseif ($registered.State -in 2, 4 -or $request.operation -eq 'start') { $state = 'starting' }
}
@{ name = $name; state = $state; pid = $processId } | ConvertTo-Json -Compress
`;

interface Registration {
  version: 1;
  node: string;
  port: number;
}

function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 0 && port <= 65_535;
}

function readRegistration(receipt: string): { record: Registration; digest: string } | undefined {
  if (!lstatSync(receipt, { throwIfNoEntry: false })) return undefined;
  const bytes = readBoundedFile(receipt, 4096, "Windows Workbench user task");
  const input: unknown = JSON.parse(bytes.toString());
  if (
    !isRecord(input) ||
    input.version !== 1 ||
    typeof input.node !== "string" ||
    !isAbsolute(input.node) ||
    !validPort(input.port)
  )
    throw new Error("Invalid Workbench Windows user-service registration");
  return {
    record: { version: 1, node: input.node, port: input.port },
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function installation(launcher: string) {
  const directory = dirname(launcher);
  return { launcher, directory, receipt: join(directory, ".workbench-installation/windows-user-service.json") };
}

async function taskOperation(
  operation: "register" | "remove" | "inspect" | "start",
  { launcher, directory }: ReturnType<typeof installation>,
  { node, port }: Registration,
  signal?: AbortSignal,
) {
  const system = process.env.SystemRoot;
  if (process.platform !== "win32" || !system || !isAbsolute(system))
    throw new Error("Workbench user-service registration requires Windows Task Scheduler");
  const request = JSON.stringify({
    operation,
    node,
    directory,
    arguments: `${windowsExecutableArgument(launcher)} serve --service --port ${String(port)}`,
  });
  const powershell = join(system, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const cancellation = processCancellation();
  try {
    const result = await captureOwnedChild(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(schedulerScript, "utf16le").toString("base64"),
      ],
      { cwd: directory, env: process.env, input: request, signal: signal ?? cancellation.signal },
      8192,
    );
    if (result.error || result.status !== 0)
      throw new Error("Windows Task Scheduler " + operation + " failed", { cause: result.error ?? result.stderr });
    const reply: unknown = JSON.parse(result.stdout);
    if (
      !isRecord(reply) ||
      typeof reply.name !== "string" ||
      !/^Workbench\.Private\.S-1-[\d-]+$/.test(reply.name) ||
      (reply.state !== "stopped" && reply.state !== "starting" && reply.state !== "running") ||
      typeof reply.pid !== "number" ||
      !Number.isSafeInteger(reply.pid) ||
      (reply.state === "running" ? reply.pid <= 0 : reply.pid !== 0)
    )
      throw new Error("Invalid Workbench Windows task response");
    return { name: reply.name, state: reply.state, pid: reply.pid };
  } finally {
    cancellation.close();
  }
}

export async function installWindowsUserService(distribution: string, port: number): Promise<string> {
  if (!validPort(port)) throw new Error("Select a Windows private service port from 0 through 65535");
  if (
    !process.env[archiveInstallationEnvironment] ||
    !readDistributionSource(distribution) ||
    !windowsServiceHelper(distribution)
  )
    throw new Error("Install a verified Workbench archive with the Windows private service helper first");
  const paths = installation(installedServiceLauncher(distribution));
  return withCacheLock(paths.receipt, async () => {
    const existing = readRegistration(paths.receipt);
    const selected: Registration = { version: 1, node: process.execPath, port };
    if (existing && (existing.record.node !== selected.node || existing.record.port !== port))
      throw new Error("Preserving the existing Workbench Windows user-service settings");
    if (!existing) writeNew(paths.receipt, JSON.stringify(selected) + "\n", 0o600);
    return (await taskOperation("register", paths, selected)).name;
  });
}

export async function removeWindowsUserService(distribution: string): Promise<string | undefined> {
  const paths = installation(installedServiceLauncher(distribution));
  return withCacheLock(paths.receipt, async () => {
    const existing = readRegistration(paths.receipt);
    if (!existing) return undefined;
    const { name } = await taskOperation("remove", paths, existing.record);
    unlinkSync(paths.receipt);
    return name;
  });
}

export async function verifyWindowsTaskStartup(distribution: string, signal: AbortSignal): Promise<boolean> {
  const expected = windowsTaskStartupReceipt();
  if (!expected) return false;
  const paths = installation(installedServiceLauncher(distribution));
  const observed = readRegistration(paths.receipt);
  if (expected.path !== paths.receipt || observed?.digest !== expected.digest)
    throw new Error("The Windows Workbench task registration changed during the installed release switch");
  const task = await taskOperation("inspect", paths, observed.record, signal);
  if (task.pid !== process.pid)
    throw new Error("Only the registered Workbench task can start during its release update");
  return true;
}

type ListenerAction = (distribution: string, pid: number, stateHome: string, signal: AbortSignal) => Promise<void>;
type ListenerReadiness = (
  distribution: string,
  pid: number,
  stateHome: string,
  signal: AbortSignal,
) => Promise<boolean>;
type IdleCheck = (exceptPid?: number, managedState?: string) => void;

interface UserListenerLifecycle {
  assertIdle: IdleCheck;
  ready: ListenerReadiness;
  drain: ListenerAction;
}

function managedUserTask(
  paths: ReturnType<typeof installation>,
  record: Registration,
  lifecycle: UserListenerLifecycle,
) {
  const local = process.env.LOCALAPPDATA;
  if (!local || !isAbsolute(local)) throw new Error("LOCALAPPDATA must identify the user's local data folder");
  const stateHome = join(local, "workbench/state");
  const inspect = (signal: AbortSignal) => taskOperation("inspect", paths, record, signal);
  return {
    inspect,
    assertIdle(exceptPid?: number) {
      lifecycle.assertIdle(exceptPid, stateHome);
    },
    canDrain(distribution: string, pid: number, signal: AbortSignal) {
      return lifecycle.ready(distribution, pid, stateHome, signal);
    },
    async drain(distribution: string, signal: AbortSignal) {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      let pid: number | undefined;
      let acknowledged = false;
      let requestFailure: unknown;
      try {
        for (;;) {
          const status = await inspect(deadline);
          if (status.state === "stopped") return;
          if (status.state === "running") {
            if (pid !== undefined && status.pid !== pid)
              throw new Error("The registered Windows Workbench task changed while draining");
            pid = status.pid;
            if (!acknowledged) {
              try {
                await lifecycle.drain(distribution, pid, stateHome, deadline);
                acknowledged = true;
              } catch (failure) {
                requestFailure = failure;
              }
            }
          }
          await delay(250, undefined, { signal: deadline });
        }
      } catch (failure) {
        if (requestFailure)
          throw combineFailures(requestFailure, failure, "The registered Windows Workbench task did not drain");
        throw failure;
      }
    },
    async restart(distribution: string, signal: AbortSignal) {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      await taskOperation("start", paths, record, deadline);
      for (;;) {
        const ready = await inspect(deadline);
        if (ready.state === "stopped") throw new Error("The registered Windows Workbench task exited before readiness");
        if (
          ready.state === "running" &&
          (await lifecycle.ready(distribution, ready.pid, stateHome, deadline)) &&
          (await inspect(deadline)).pid === ready.pid
        )
          return;
        await delay(250, undefined, { signal: deadline });
      }
    },
  };
}

export async function activateWindowsUserRelease(
  transition: ReleaseActivation,
  lifecycle: UserListenerLifecycle,
): Promise<boolean> {
  const paths = installation(transition.launcher);
  if (!lstatSync(paths.receipt, { throwIfNoEntry: false })) return false;
  const cancellation = processCancellation();
  try {
    return await withCacheLock(
      paths.receipt,
      async () => {
        const registration = readRegistration(paths.receipt);
        if (!registration) return false;
        const managed = managedUserTask(paths, registration.record, lifecycle);
        const observed = await managed.inspect(cancellation.signal);
        if (observed.state === "stopped") return false;
        if (
          observed.state !== "running" ||
          !(await managed.canDrain(transition.previous, observed.pid, cancellation.signal))
        )
          throw new Error(
            "The registered Windows Workbench logon task is still starting. Retry when its listener is ready.",
          );
        managed.assertIdle(observed.pid);
        assertInstalledWindowsTaskLauncher(transition.launcher);
        transition.begin({
          manager: "task-scheduler",
          scope: "user",
          path: paths.receipt,
          digest: registration.digest,
        });
        try {
          await managed.drain(transition.previous, cancellation.signal);
          managed.assertIdle();
          transition.select();
          transition.permitManagedServiceStart(true);
          await managed.restart(transition.replacement, cancellation.signal);
        } catch (failure) {
          if (cancellation.signal.aborted) throw failure;
          try {
            transition.permitManagedServiceStart(false);
            await managed.drain(transition.previous, cancellation.signal);
            transition.restore();
            transition.permitManagedServiceStart(true);
            await managed.restart(transition.previous, cancellation.signal);
            transition.finishRestoration();
          } catch (restoration) {
            throw combineFailures(
              failure,
              restoration,
              "Windows task recovery is pending. Run 'workbench update --recover'.",
            );
          }
          throw new Error("The Workbench update failed. The previous Windows Workbench task is running.", {
            cause: failure,
          });
        }
        return true;
      },
      30_000,
      cancellation.signal,
    );
  } finally {
    cancellation.close();
  }
}

export async function recoverWindowsUserRelease(
  launcher: string,
  restore: () => void,
  service: ReleaseServiceRegistration,
  previous: string,
  permitStart: (allowed: boolean) => void,
  lifecycle: UserListenerLifecycle,
): Promise<void> {
  const paths = installation(launcher);
  if (service.manager !== "task-scheduler" || service.scope !== "user" || service.path !== paths.receipt)
    throw new Error("Recover the release from the original Windows Workbench task installation");
  recoverReleaseLock(paths.receipt);
  const cancellation = processCancellation();
  try {
    await withCacheLock(
      paths.receipt,
      async () => {
        const registration = readRegistration(paths.receipt);
        if (registration?.digest !== service.digest)
          throw new Error("The Windows Workbench task registration changed. Preserve the recovery receipt.");
        const managed = managedUserTask(paths, registration.record, lifecycle);
        permitStart(false);
        await managed.drain(previous, cancellation.signal);
        managed.assertIdle();
        restore();
        permitStart(true);
        await managed.restart(previous, cancellation.signal);
      },
      30_000,
      cancellation.signal,
    );
  } finally {
    cancellation.close();
  }
}
