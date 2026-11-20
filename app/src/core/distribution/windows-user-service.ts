import { lstatSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { readBoundedFile } from "../runtime/file-reads.js";
import { writeNew } from "../runtime/file-publication.mjs";
import { captureOwnedChild, processCancellation } from "../runtime/owned-child.mjs";
import { isRecord } from "../runtime/values.mjs";
import { windowsExecutableArgument } from "../runtime/windows-arguments.mjs";
import { withCacheLock } from "../storage/cache-lock.js";
import { archiveInstallationEnvironment, readDistributionSource } from "./distribution-identity.js";
import { installedServiceLauncher } from "./installed-release.js";
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
if ($existing.Count -eq 1) { Check-Owned $existing[0] }
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
}
@{ name = $name } | ConvertTo-Json -Compress
`;

interface Registration {
  version: 1;
  node: string;
  port: number;
}

function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 0 && port <= 65_535;
}

function readRegistration(receipt: string): Registration | undefined {
  if (!lstatSync(receipt, { throwIfNoEntry: false })) return undefined;
  const input: unknown = JSON.parse(readBoundedFile(receipt, 4096, "Windows Workbench user task").toString());
  if (
    !isRecord(input) ||
    input.version !== 1 ||
    typeof input.node !== "string" ||
    !isAbsolute(input.node) ||
    !validPort(input.port)
  )
    throw new Error("Invalid Workbench Windows user-service registration");
  return { version: 1, node: input.node, port: input.port };
}

function installation(distribution: string) {
  const launcher = installedServiceLauncher(distribution);
  const directory = dirname(launcher);
  return { launcher, directory, receipt: join(directory, ".workbench-installation/windows-user-service.json") };
}

async function taskOperation(
  operation: "register" | "remove",
  { launcher, directory }: ReturnType<typeof installation>,
  { node, port }: Registration,
): Promise<string> {
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
      { cwd: directory, env: process.env, input: request, signal: cancellation.signal },
      8192,
    );
    if (result.error || result.status !== 0)
      throw new Error("Windows Task Scheduler " + operation + " failed", { cause: result.error ?? result.stderr });
    const reply: unknown = JSON.parse(result.stdout);
    if (!isRecord(reply) || typeof reply.name !== "string" || !/^Workbench\.Private\.S-1-[\d-]+$/.test(reply.name))
      throw new Error("Invalid Workbench Windows task response");
    return reply.name;
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
  const paths = installation(distribution);
  return withCacheLock(paths.receipt, async () => {
    const existing = readRegistration(paths.receipt);
    const selected: Registration = { version: 1, node: process.execPath, port };
    if (existing && (existing.node !== selected.node || existing.port !== port))
      throw new Error("Preserving the existing Workbench Windows user-service settings");
    if (!existing) writeNew(paths.receipt, JSON.stringify(selected) + "\n", 0o600);
    return taskOperation("register", paths, selected);
  });
}

export async function removeWindowsUserService(distribution: string): Promise<string | undefined> {
  const paths = installation(distribution);
  return withCacheLock(paths.receipt, async () => {
    const existing = readRegistration(paths.receipt);
    if (!existing) return undefined;
    const name = await taskOperation("remove", paths, existing);
    unlinkSync(paths.receipt);
    return name;
  });
}
