import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { userConfigValues } from "../configuration/user-config.js";
import { setTimeout as delay } from "node:timers/promises";
import { combineFailures } from "../diagnostics/diagnostic-errors.mjs";
import { writeNew } from "../runtime/file-publication.mjs";
import { readBoundedFile } from "../runtime/file-reads.js";
import { processCancellation } from "../runtime/owned-child.mjs";
import { ownedPath } from "../runtime/paths.js";
import { withCacheLocksSync } from "../storage/cache-lock.js";
import { macStateDirectory } from "../storage/storage.js";
import {
  archiveInstallationEnvironment,
  launchdNativeHelper,
  launchdServiceEnvironment,
  launchdSharedPort,
  launchdSystemDirectory,
  readDistributionSource,
} from "./distribution-identity.js";
import {
  assertInstalledLaunchdLauncher,
  installedServiceLauncher,
  type ReleaseActivation,
} from "./installed-release.js";
import { recoverReleaseLock, type ReleaseServiceRegistration } from "./release-transition.js";
import { protectedServiceCommand } from "./service-command.js";

export const launchAgentLabel = "org.workbench.app";
const declaration = '<?xml version="1.0" encoding="UTF-8"?>\n';
const marker = "<!-- Workbench-managed launchd job sha256=";

function seal(body: string): string {
  return declaration + marker + createHash("sha256").update(body).digest("hex") + " -->\n" + body;
}

function xml(value: string): string {
  for (const char of value) {
    const codepoint = char.codePointAt(0) ?? 0;
    if (codepoint < 32 || codepoint === 127 || (codepoint >= 0xd800 && codepoint <= 0xdfff))
      throw new Error("Service command paths must be printable");
  }
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function launchAgentDefinition(home: string, node: string, launcher: string, port?: number): string {
  if (![home, node, launcher].every((path) => isAbsolute(path)))
    throw new Error("Service command paths must be absolute");
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
    throw new Error("Service port must be in 1–65535");
  const args = [
    "/usr/bin/env",
    "-i",
    "HOME=" + home,
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    launchdServiceEnvironment + "=1",
    node,
    launcher,
    "serve",
    "--service",
    "--host",
    "127.0.0.1",
  ];
  if (port !== undefined) args.push("--port", String(port));
  return seal(
    [
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "  <key>Label</key><string>" + launchAgentLabel + "</string>",
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...args.map((arg) => "    <string>" + xml(arg) + "</string>"),
      "  </array>",
      "  <key>WorkingDirectory</key><string>" + xml(home) + "</string>",
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
}

export function launchDaemonDefinition(node: string, launcher: string, port: number): string {
  if (![node, launcher].every((path) => isAbsolute(path))) throw new Error("Service command paths must be absolute");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Service port must be in 1–65535");
  const args = [
    "/usr/bin/env",
    "-i",
    "HOME=/var/root",
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    `${launchdServiceEnvironment}=1`,
    `${launchdSharedPort}=${String(port)}`,
    "WORKBENCH_SYSTEM_SERVICE=1",
    node,
    launcher,
    "serve",
    "--service",
  ];
  const browser = (family: string, loopback: string) => [
    "      <dict>",
    `        <key>SockFamily</key><string>${family}</string>`,
    `        <key>SockNodeName</key><string>${loopback}</string>`,
    `        <key>SockServiceName</key><string>${String(port)}</string>`,
    "        <key>SockType</key><string>stream</string>",
    "        <key>SockProtocol</key><string>TCP</string>",
    "      </dict>",
  ];
  return seal(
    [
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${launchAgentLabel}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...args.map((arg) => `    <string>${xml(arg)}</string>`),
      "  </array>",
      "  <key>WorkingDirectory</key><string>/</string>",
      "  <key>RunAtLoad</key><true/>",
      "  <key>ThrottleInterval</key><integer>1</integer>",
      "  <key>Sockets</key>",
      "  <dict>",
      "    <key>Loopback</key>",
      "    <array>",
      ...browser("IPv4", "127.0.0.1"),
      ...browser("IPv6", "::1"),
      "    </array>",
      "    <key>Control</key>",
      "    <dict>",
      `      <key>SockPathName</key><string>${launchdSystemDirectory}/control.sock</string>`,
      "      <key>SockPathMode</key><integer>438</integer>",
      "    </dict>",
      "  </dict>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
}

function currentDaemon() {
  if (process.platform !== "darwin" || process.getuid?.() !== 0 || process.geteuid?.() !== 0)
    throw new Error("Manage the Workbench LaunchDaemon with macOS administrator access");
  return {
    uid: 0,
    home: "/var/root",
    path: `/Library/LaunchDaemons/${launchAgentLabel}.plist`,
    domain: "system",
  };
}

function systemDirectory(path: string, mode: number): void {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const metadata = lstatSync(parent);
    if (!metadata.isDirectory() || metadata.uid !== 0 || metadata.mode & 0o022)
      throw new Error(`${parent}: expected a protected administrator-owned directory`);
    if (dirname(parent) === parent) break;
  }
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    mkdirSync(path, { mode });
    chmodSync(path, mode);
  }
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o7777) !== mode)
    throw new Error(`${path}: preserving an existing Workbench service directory with unexpected permissions`);
}

export function installLaunchDaemon(distribution: string, requestedPort?: number): { path: string; command: string } {
  const { path } = currentDaemon();
  if (!process.env[archiveInstallationEnvironment] || !readDistributionSource(distribution))
    throw new Error("Install a verified Workbench release archive before registering its LaunchDaemon");
  const node = protectedServiceCommand(process.execPath, 0, true);
  if (typeof (process as NodeJS.Process & { execve?: unknown }).execve !== "function")
    throw new Error("The Workbench LaunchDaemon requires a Node.js runtime with process.execve");
  if (!(lstatSync(node).mode & 0o001))
    throw new Error(`${node}: the shared service needs Node.js executable by ordinary accounts`);
  const launcher = protectedServiceCommand(installedServiceLauncher(distribution), 0, true);
  assertInstalledLaunchdLauncher(launcher);
  const helper = join(distribution, launchdNativeHelper);
  try {
    accessSync(protectedServiceCommand(helper, 0, true), constants.X_OK);
  } catch (error) {
    throw new Error("Install a verified Workbench release containing the macOS service helper", { cause: error });
  }
  protectedServiceCommand(join(distribution, "bundle/main.cjs"), 0, true);
  const port = requestedPort ?? Number(userConfigValues()["daemon.system_port"]);
  const contents = launchDaemonDefinition(node, launcher, port);
  withCacheLocksSync([path], () => {
    if (lstatSync(path, { throwIfNoEntry: false }) && ownedDefinition(path, 0).bytes.toString() !== contents)
      throw new Error(path + ": preserving the existing LaunchDaemon definition");
    systemDirectory(launchdSystemDirectory, 0o755);
    systemDirectory(join(launchdSystemDirectory, "login"), 0o1733);
    if (!lstatSync(path, { throwIfNoEntry: false })) writeNew(path, contents, 0o644);
  });
  return { path, command: `sudo launchctl bootstrap system '${path}'` };
}

function currentAgent() {
  if (process.platform !== "darwin") throw new Error("LaunchAgent management requires macOS");
  const { uid, homedir } = userInfo();
  if (uid <= 0 || uid !== process.geteuid?.())
    throw new Error("Manage the Workbench LaunchAgent from its ordinary account");
  const home = realpathSync(homedir);
  return {
    uid,
    home,
    path: ownedPath(home, `Library/LaunchAgents/${launchAgentLabel}.plist`),
    domain: "gui/" + String(uid),
  };
}

function ownedDefinition(path: string, uid: number) {
  const info = lstatSync(path);
  const reject = () => new Error(path + ": preserving the existing LaunchAgent definition");
  if (!info.isFile() || info.uid !== uid || info.mode & 0o022 || info.nlink !== 1) throw reject();
  const bytes = readBoundedFile(path, 16 * 1024, "registered Workbench LaunchAgent");
  const contents = bytes.toString();
  const closer = contents.indexOf(" -->\n", declaration.length + marker.length);
  if (
    !contents.startsWith(declaration + marker) ||
    closer < 0 ||
    seal(contents.slice(closer + " -->\n".length)) !== contents
  )
    throw reject();
  return { bytes, info };
}

export function installLaunchAgent(distribution: string, port?: number): { path: string; command: string } {
  const { uid, home, path, domain } = currentAgent();
  if (!readDistributionSource(distribution))
    throw new Error("Install a verified Workbench release before registering its LaunchAgent");
  const node = protectedServiceCommand(process.execPath, uid);
  accessSync(node, constants.X_OK);
  const launcher = protectedServiceCommand(installedServiceLauncher(distribution), uid);
  protectedServiceCommand(join(distribution, "bundle/main.cjs"), uid);
  const contents = launchAgentDefinition(home, node, launcher, port);
  withCacheLocksSync([path], () => {
    if (!lstatSync(path, { throwIfNoEntry: false })) writeNew(path, contents, 0o644);
    else if (ownedDefinition(path, uid).bytes.toString() !== contents)
      throw new Error(path + ": preserving the existing LaunchAgent definition");
  });
  return { path, command: `launchctl bootstrap ${domain} '${path.replaceAll("'", "'\"'\"'")}'` };
}

const launchctl = "/bin/launchctl";
const launchEnvironment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" };

function loadedAgent(target: string, path: string, info: Stats) {
  const result = spawnSync(launchctl, ["print", target], {
    encoding: "utf8",
    env: launchEnvironment,
    maxBuffer: 64 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (/Could not find (?:specified )?(?:service|domain)/i.test(result.stderr)) return;
    throw new Error(`Cannot inspect the registered LaunchAgent: ${result.stderr.trim()}`);
  }
  const source = /^\s*path = (.+)$/m.exec(result.stdout)?.[1]?.trim();
  const loaded = source && isAbsolute(source) ? statSync(source, { throwIfNoEntry: false }) : undefined;
  if (!loaded?.isFile() || loaded.dev !== info.dev || loaded.ino !== info.ino)
    throw new Error(path + ": launchd loaded a different service definition");
  const pid = Number(/^\s*pid = (\d+)$/m.exec(result.stdout)?.[1]);
  const runs = Number(/^\s*runs = (\d+)$/m.exec(result.stdout)?.[1] ?? 0);
  const exited = /^\s*last (?:exit code = -?\d+|terminating signal = .+)$/m.test(result.stdout);
  return { pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined, runs, exited };
}

function manage(...args: string[]): void {
  execFileSync(launchctl, args, { encoding: "utf8", env: launchEnvironment, stdio: ["ignore", "pipe", "pipe"] });
}

function registeredAgent(account: ReturnType<typeof currentAgent>, launcher?: string) {
  const { uid, path, domain, home } = account;
  const system = domain === "system";
  const definition = ownedDefinition(path, uid);
  if (launcher !== undefined) {
    const command =
      "    <string>" +
      xml(protectedServiceCommand(launcher, uid)) +
      "</string>\n" +
      "    <string>serve</string>\n    <string>--service</string>";
    if (!definition.bytes.toString().includes(command))
      throw new Error("The registered Workbench LaunchAgent selects a different launcher");
  }
  const target = domain + "/" + launchAgentLabel;
  const inspect = () => loadedAgent(target, path, definition.info);
  const assertDefinition = () => {
    const current = ownedDefinition(path, uid);
    if (
      current.info.ino !== definition.info.ino ||
      current.info.dev !== definition.info.dev ||
      !current.bytes.equals(definition.bytes)
    )
      throw new Error(path + ": the LaunchAgent definition changed during the operation");
  };
  const drain = async (signal: AbortSignal, keepRegistration = false) => {
    signal.throwIfAborted();
    assertDefinition();
    const pid = inspect()?.pid;
    if (pid !== undefined) {
      // Let Workbench drain before bootout can start launchd's termination timer.
      try {
        manage("kill", "SIGTERM", target);
      } catch (error) {
        if (inspect()?.pid === pid) throw error;
      }
      for (;;) {
        const observed = inspect()?.pid;
        if (observed === undefined) break;
        if (observed !== pid) {
          if (keepRegistration) break;
          throw new Error("The Workbench launchd service restarted during shutdown");
        }
        await delay(125, undefined, { signal });
      }
    }
    assertDefinition();
    if (!keepRegistration && inspect()) manage("bootout", target);
  };
  return {
    digest: createHash("sha256").update(definition.bytes).digest("hex"),
    inspect,
    assertDefinition,
    drain,
    stateHome: macStateDirectory(home),
    restart(distribution: string, ready: AgentReadiness, signal: AbortSignal) {
      signal.throwIfAborted();
      assertDefinition();
      if (system) manage("kickstart", target);
      else manage("bootstrap", domain, path);
      return waitForAgent(distribution, inspect, macStateDirectory(home), ready, signal, system);
    },
  };
}

type AgentReadiness = (distribution: string, pid: number, stateHome: string, signal: AbortSignal) => Promise<boolean>;
type IdleCheck = (exceptPid?: number, managedState?: string) => void;

async function waitForAgent(
  distribution: string,
  inspect: ReturnType<typeof registeredAgent>["inspect"],
  stateHome: string,
  ready: AgentReadiness,
  signal: AbortSignal,
  system: boolean,
): Promise<void> {
  const deadline = AbortSignal.timeout(30_000);
  const waiting = AbortSignal.any([signal, deadline]);
  try {
    for (;;) {
      waiting.throwIfAborted();
      const status = inspect();
      if (!status || (!system && (status.runs > 1 || (status.exited && status.pid === undefined))))
        throw new Error("The Workbench launchd service exited before listener readiness");
      if (
        status.pid !== undefined &&
        (await ready(distribution, status.pid, stateHome, waiting)) &&
        inspect()?.pid === status.pid
      )
        return;
      await delay(125, undefined, { signal: waiting });
    }
  } catch (error) {
    if (deadline.aborted && !signal.aborted)
      throw new Error("The replacement Workbench launchd service did not become ready", { cause: error });
    throw error;
  }
}

/** Stop the native job only after recording which verified selection recovery must restore. */
export async function activateLaunchdRelease(
  transition: ReleaseActivation,
  assertIdle: IdleCheck,
  ready: AgentReadiness,
): Promise<void> {
  const system = process.geteuid?.() === 0;
  const account = system ? currentDaemon() : currentAgent();
  if (!lstatSync(account.path, { throwIfNoEntry: false })) {
    assertIdle();
    transition.select();
    return;
  }
  await withCacheLocksSync([account.path], async () => {
    const agent = registeredAgent(account, transition.launcher);
    if (system) {
      assertInstalledLaunchdLauncher(transition.launcher);
      accessSync(protectedServiceCommand(join(transition.replacement, launchdNativeHelper), 0, true), constants.X_OK);
    }
    const before = agent.inspect();
    assertIdle(before?.pid, agent.stateHome);
    if (!before) {
      transition.select();
      return;
    }
    if (!system && before.pid === undefined)
      throw new Error("The Workbench LaunchAgent is not ready. Inspect launchd or unload the agent to continue.");
    const cancellation = processCancellation();
    try {
      if (
        before.pid !== undefined &&
        !(await ready(transition.previous, before.pid, agent.stateHome, cancellation.signal))
      )
        throw new Error("The Workbench launchd service is still starting. Retry after its listener is ready.");
      transition.begin({
        manager: "launchd",
        scope: system ? "system" : "user",
        path: account.path,
        digest: agent.digest,
      });
      try {
        await agent.drain(cancellation.signal, system);
        assertIdle(undefined, agent.stateHome);
        transition.select();
        if (system) transition.permitManagedServiceStart(true);
        await agent.restart(transition.replacement, ready, cancellation.signal);
      } catch (failure) {
        if (cancellation.signal.aborted) throw failure;
        try {
          if (system) transition.permitManagedServiceStart(false);
          await agent.drain(cancellation.signal, system);
          transition.restore();
          if (system) transition.permitManagedServiceStart(true);
          await agent.restart(transition.previous, ready, cancellation.signal);
          transition.finishRestoration();
        } catch (restore) {
          throw combineFailures(
            failure,
            restore,
            "Workbench service recovery is pending. Run 'workbench update --recover'.",
          );
        }
        throw new Error("The Workbench update failed. The previous service release is running.", { cause: failure });
      }
    } finally {
      cancellation.close();
    }
  });
}

export async function recoverLaunchdRelease(
  launcher: string,
  restore: () => void,
  service: ReleaseServiceRegistration | undefined,
  previous: string,
  permitStart: (allowed: boolean) => void,
  assertIdle: IdleCheck,
  ready: AgentReadiness,
): Promise<void> {
  if (!service) {
    assertIdle();
    restore();
    return;
  }
  const system = process.geteuid?.() === 0;
  const account = system ? currentDaemon() : currentAgent();
  if (service.manager !== "launchd" || service.scope !== (system ? "system" : "user") || service.path !== account.path)
    throw new Error("Recover the release with the original native service manager and account");
  recoverReleaseLock(account.path);
  await withCacheLocksSync([account.path], async () => {
    const agent = registeredAgent(account, launcher);
    if (agent.digest !== service.digest)
      throw new Error("The installed Workbench LaunchAgent changed. Preserve the update receipt.");
    assertIdle(agent.inspect()?.pid, agent.stateHome);
    const cancellation = processCancellation();
    try {
      if (system) permitStart(false);
      await agent.drain(cancellation.signal, system);
      restore();
      if (system) permitStart(true);
      await agent.restart(previous, ready, cancellation.signal);
    } finally {
      cancellation.close();
    }
  });
}

export async function removeLaunchdService(scope: "user" | "system"): Promise<string | undefined> {
  const account = scope === "system" ? currentDaemon() : currentAgent();
  const { path } = account;
  if (!lstatSync(path, { throwIfNoEntry: false })) return undefined;
  return withCacheLocksSync([path], async () => {
    if (!lstatSync(path, { throwIfNoEntry: false })) return undefined;
    const agent = registeredAgent(account);
    const cancellation = processCancellation();
    try {
      await agent.drain(cancellation.signal);
      agent.assertDefinition();
      unlinkSync(path);
      return path;
    } finally {
      cancellation.close();
    }
  });
}
