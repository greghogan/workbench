import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, statSync, unlinkSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { writeAtomic, writeNew } from "../runtime/file-publication.mjs";
import { readBoundedFile } from "../runtime/file-reads.js";
import { ownedPath } from "../runtime/paths.js";
import { withCacheLockSync } from "../storage/cache-lock.js";
import { archiveInstallationEnvironment, readDistributionSource } from "./distribution-identity.js";
import { installedServiceLauncher, type ReleaseActivation } from "./installed-release.js";
import { combineFailures } from "../diagnostics/diagnostic-errors.mjs";
import { recoverReleaseLock, type ReleaseServiceRegistration } from "./release-transition.js";
import { protectedServiceCommand } from "./service-command.js";

export const serviceScopes = ["user", "system"] as const;
export type ServiceScope = (typeof serviceScopes)[number];
const name = "workbench.service";
const unitMarker = "# Workbench-managed systemd unit sha256=";
const serviceEnvironment = "WORKBENCH_SYSTEMD_SERVICE";

function sealedUnit(body: string): string {
  return unitMarker + createHash("sha256").update(body).digest("hex") + "\n" + body;
}

function systemdArgument(value: string): string {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) throw new Error("Service command paths must be printable");
  }
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%") + '"';
}

export function systemdServiceUnit(scope: ServiceScope, node: string, launcher: string, port?: number): string {
  if (!isAbsolute(node) || !isAbsolute(launcher)) throw new Error("Service command paths must be absolute");
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
    throw new Error("Service port must be in 1–65535");
  const system = scope === "system";
  const launch = [systemdArgument(node), systemdArgument(launcher), "serve", "--service", "--host", "127.0.0.1"];
  if (port !== undefined) launch.push("--port", String(port));
  const definition = [
    "[Unit]",
    "Description=Workbench local web service",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=3",
    "",
    "[Service]",
    "Type=notify",
    "NotifyAccess=" + (system ? "main" : "all"),
    `Environment=${serviceEnvironment}=1`,
    "TimeoutStartSec=infinity",
    "WorkingDirectory=/",
    "UnsetEnvironment=NODE_OPTIONS NODE_PATH WORKBENCH_PROJECT_ROOT WORKBENCH_DISTRIBUTION_ROOT " +
      "WORKBENCH_LOCAL_CONFIG_ROOT WORKBENCH_EXECUTING_SPEC " +
      archiveInstallationEnvironment +
      (system ? "" : " WORKBENCH_SYSTEM_SERVICE"),
    // The colon tells systemd to pass literal arguments without expanding environment variables.
    "ExecStart=:" + launch.join(" "),
    "Restart=on-failure",
    "RestartSec=2s",
    "KillMode=mixed",
    "TimeoutStopSec=infinity",
    ...(system
      ? [
          "User=root",
          "Environment=WORKBENCH_SYSTEM_SERVICE=1",
          "RuntimeDirectory=workbench",
          "RuntimeDirectoryMode=0755",
          "StateDirectory=workbench",
          "StateDirectoryMode=0700",
          "Environment=WORKBENCH_STATE_HOME=/var/lib/workbench",
        ]
      : []),
    "",
    "[Install]",
    "WantedBy=" + (system ? "multi-user" : "default") + ".target",
    "",
  ].join("\n");
  return sealedUnit(definition);
}

export function systemdServiceProcess(): boolean {
  return process.platform === "linux" && process.env[serviceEnvironment] === "1" && !!process.env.NOTIFY_SOCKET;
}

export function notifySystemdServiceReady(): void {
  if (systemdServiceProcess())
    execFileSync("/usr/bin/systemd-notify", ["--ready", "--pid=parent"], {
      env: { NOTIFY_SOCKET: process.env.NOTIFY_SOCKET, PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
}

function serviceOwner(scope: ServiceScope): number {
  if (process.platform !== "linux" || !existsSync("/run/systemd/system"))
    throw new Error("Service management requires a Linux host running systemd");
  const uid = process.geteuid?.();
  if (uid === undefined || (scope === "system" && uid !== 0))
    throw new Error("System service management requires administrator privileges");
  if (scope === "user" && uid === 0) throw new Error("Manage a user service as the account that runs it");
  return uid;
}

function servicePath(scope: ServiceScope): string {
  const config = process.env.XDG_CONFIG_HOME;
  return ownedPath(
    scope === "system"
      ? "/etc/systemd/system"
      : join(config && isAbsolute(config) ? config : join(homedir(), ".config"), "systemd/user"),
    name,
  );
}

export function installSystemdService(
  distribution: string,
  scope: ServiceScope,
  port?: number,
): { path: string; command: string } {
  const uid = serviceOwner(scope);
  if (!readDistributionSource(distribution))
    throw new Error("Install a verified Workbench release before registering its service");

  const shared = scope === "system";
  const node = protectedServiceCommand(process.execPath, uid, shared);
  accessSync(node, constants.X_OK);
  const launcher = protectedServiceCommand(installedServiceLauncher(distribution), uid, shared);
  protectedServiceCommand(join(distribution, "bundle/main.cjs"), uid, shared);
  const contents = systemdServiceUnit(scope, node, launcher, port);
  const path = servicePath(scope);
  withCacheLockSync(path, () => {
    if (!existsSync(path)) writeAtomic(path, contents, 0o644);
    else if (
      !lstatSync(path).isFile() ||
      readBoundedFile(path, 32 * 1024, "existing systemd unit").toString() !== contents
    )
      throw new Error(path + ": preserving the existing service definition");
  });
  return { path, command: "systemctl " + (scope === "user" ? "--user " : "") + "enable --now " + name };
}

function ownedDefinition(path: string, uid: number): { contents: string; metadata: Stats } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== uid || stat.mode & 0o022)
    throw new Error(path + ": preserving the existing service definition");
  const contents = readBoundedFile(path, 32 * 1024, "registered systemd unit").toString();
  const newline = contents.indexOf("\n");
  if (newline < 0 || !contents.startsWith(unitMarker) || sealedUnit(contents.slice(newline + 1)) !== contents)
    throw new Error(path + ": preserving the existing service definition");
  return { contents, metadata: stat };
}

function serviceManager(scope: ServiceScope) {
  const manager = scope === "user" ? ["--user"] : [];
  return (...args: string[]) =>
    execFileSync("/usr/bin/systemctl", [...manager, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: scope === "user" ? process.env : { PATH: "/usr/bin:/bin" },
    }).trim();
}

function verifyLoadedDefinition(scope: ServiceScope, fragment: string, expected: Stats): void {
  const loaded = isAbsolute(fragment)
    ? statSync(scope === "system" ? `/proc/1/root${fragment}` : fragment, { throwIfNoEntry: false })
    : undefined;
  if (!loaded?.isFile() || loaded.dev !== expected.dev || loaded.ino !== expected.ino)
    throw new Error(fragment + ": the systemd manager loaded a different service definition");
}

function ownedUpdateService(scope: ServiceScope, path: string, launcher: string) {
  const uid = serviceOwner(scope);
  const shared = scope === "system";
  const definition = ownedDefinition(path, uid);
  const node = protectedServiceCommand(process.execPath, uid, shared);
  const entry = protectedServiceCommand(launcher, uid, shared);
  const command = `ExecStart=:${systemdArgument(node)} ${systemdArgument(entry)} serve --service `;
  if (!definition.contents.split("\n").some((line) => line.startsWith(command)))
    throw new Error("The registered Workbench service selects a different launcher");
  const systemctl = serviceManager(scope);
  const state = () => {
    const output = systemctl("show", "--property=FragmentPath,ActiveState,MainPID,Type", name);
    const properties = new Map(
      output.split("\n").map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
    );
    const fragment = properties.get("FragmentPath");
    if (fragment) verifyLoadedDefinition(scope, fragment, definition.metadata);
    const pid = Number(properties.get("MainPID"));
    return {
      active: properties.get("ActiveState"),
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined,
      type: properties.get("Type"),
    };
  };
  return { systemctl, state, digest: createHash("sha256").update(definition.contents).digest("hex") };
}

/** Drain the owned unit and wait for readiness before committing a release switch. */
export function activateSystemdRelease(transition: ReleaseActivation, assertIdle: (exceptPid?: number) => void): void {
  const shared = process.geteuid?.() === 0;
  const scope = shared ? "system" : "user";
  const path = process.platform === "linux" && existsSync("/run/systemd/system") ? servicePath(scope) : undefined;
  if (!path || !lstatSync(path, { throwIfNoEntry: false })) {
    assertIdle();
    transition.select();
    return;
  }
  withCacheLockSync(path, () => {
    const { systemctl, state, digest } = ownedUpdateService(scope, path, transition.launcher);
    const before = state();
    if (before.active === "inactive" || before.active === "failed") {
      assertIdle();
      transition.select();
      return;
    }
    if (before.active !== "active" || before.type !== "notify" || before.pid === undefined)
      throw new Error(
        "The Workbench service is not ready for an update. Inspect systemd or stop the service to continue.",
      );
    assertIdle(before.pid);
    transition.begin({ manager: "systemd", scope, path, digest });
    try {
      systemctl("stop", name);
      assertIdle();
      transition.select();
      systemctl("start", name);
      const ready = state();
      if (ready.active !== "active" || ready.pid === undefined || ready.pid === before.pid)
        throw new Error("The replacement Workbench service did not become ready");
    } catch (failure) {
      try {
        systemctl("stop", name);
        transition.restore();
        systemctl("reset-failed", name);
        systemctl("start", name);
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
  });
}

export function recoverSystemdRelease(
  launcher: string,
  restore: () => void,
  service: ReleaseServiceRegistration | undefined,
  assertIdle: (exceptPid?: number) => void,
): void {
  if (!service) {
    assertIdle();
    restore();
    return;
  }
  const { scope, path, digest } = service;
  serviceOwner(scope);
  if (path !== servicePath(scope))
    throw new Error("Return to the original service account and configuration to recover");
  recoverReleaseLock(path);
  withCacheLockSync(path, () => {
    const { systemctl, state, digest: registered } = ownedUpdateService(scope, path, launcher);
    if (registered !== digest)
      throw new Error("The installed Workbench service definition changed. Preserve the update receipt.");
    assertIdle(state().pid);
    systemctl("stop", name);
    restore();
    systemctl("reset-failed", name);
    systemctl("start", name);
    if (state().active !== "active") throw new Error("The previous Workbench service did not become ready");
  });
}

export function removeSystemdService(scope: ServiceScope): string | undefined {
  const uid = serviceOwner(scope);
  const path = servicePath(scope);
  if (!lstatSync(path, { throwIfNoEntry: false })) return undefined;
  const systemctl = serviceManager(scope);
  return withCacheLockSync(path, () => {
    if (!lstatSync(path, { throwIfNoEntry: false })) return undefined;
    const definition = ownedDefinition(path, uid);
    const fragment = systemctl("show", "--property=FragmentPath", "--value", name);
    if (fragment) {
      verifyLoadedDefinition(scope, fragment, definition.metadata);
      systemctl("disable", "--now", name);
    }
    const current = ownedDefinition(path, uid);
    if (
      current.contents !== definition.contents ||
      current.metadata.mode !== definition.metadata.mode ||
      current.metadata.dev !== definition.metadata.dev ||
      current.metadata.ino !== definition.metadata.ino
    )
      throw new Error(path + ": the service definition changed during removal");
    unlinkSync(path);
    try {
      systemctl("daemon-reload");
    } catch (failure) {
      try {
        writeNew(path, definition.contents, definition.metadata.mode & 0o777);
      } catch (restore) {
        throw combineFailures(failure, restore, "Could not reload systemd or restore the Workbench service definition");
      }
      throw new Error("Systemd reload failed. The stopped service registration was restored.", { cause: failure });
    }
    return path;
  });
}
