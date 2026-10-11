import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { userDirectory } from "./storage.js";
import { ownedPath } from "./paths.js";
import { withCacheLockSync as cacheLock } from "./cache-lock.js";
import {
  digest,
  distributionBytes,
  distributionManifest,
  inspectDistribution,
  validateDistributionPin,
  type DistributionPin,
} from "./distribution-manifest.js";
import { InvalidInput } from "./input-errors.js";

export interface InstallationStore {
  schema_version: 1;
  scope: "user" | "system";
  owner: string;
  id: string;
}
export interface RetentionRoot {
  schema_version: 1;
  id: string;
  kind: "profile" | "use" | "recovery" | "launcher";
  pins: DistributionPin[];
}
interface Epoch {
  token: string;
  busy: boolean;
}
const withCacheLockSync: typeof cacheLock = (path, action) => cacheLock(path, action, 10_000);

const identifier = /^(?:\d+|S-1-(?:\d+-)*\d+)$/;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const pinHash = /^[0-9a-f]{64}$/;

function powershell(script: string, values: string[] = []): string {
  // Arguments remain data in an environment variable, including paths containing quotes.
  return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, WORKBENCH_ACL_ARGUMENTS: JSON.stringify(values) },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
let accountOwner: string | undefined;
export function installationOwner(): string {
  accountOwner ??=
    process.platform === "win32"
      ? powershell("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value")
      : String(process.geteuid?.());
  return accountOwner;
}

function administrator(): boolean {
  return process.platform === "win32"
    ? powershell(
        "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
      ) === "True"
    : process.geteuid?.() === 0;
}
function protectedSystemParents(base: string): void {
  for (let path = dirname(base); ; path = dirname(path)) {
    if (existsSync(path)) {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new InvalidInput("system store parents must be real protected directories");
      if (process.platform !== "win32" && (info.uid !== 0 || (info.mode & 0o022 && !(info.mode & 0o1000))))
        throw new InvalidInput("system store parents must be administrator-owned; use a protected system path");
      if (process.platform === "win32")
        powershell(
          `$ErrorActionPreference='Stop'; $v=ConvertFrom-Json $env:WORKBENCH_ACL_ARGUMENTS;
        $acl=Get-Acl -LiteralPath $v[0];
        if(@('S-1-5-18','S-1-5-32-544') -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'Unsafe system parent owner' }
        foreach($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
          if($r.AccessControlType -eq 'Allow' -and @('S-1-5-18','S-1-5-32-544') -notcontains $r.IdentityReference.Value -and
             (($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles) -ne 0 -or
              ($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ChangePermissions) -ne 0 -or
              ($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::TakeOwnership) -ne 0)) { throw 'Unsafe system parent permissions' }
        }`,
          [path],
        );
    }
    if (dirname(path) === path) break;
  }
}

/** Windows modes do not implement owner separation; install a protected DACL explicitly. */
function permissions(path: string, owner: string, shared: boolean, profile = false): void {
  if (process.platform !== "win32") {
    chmodSync(path, shared ? 0o755 : 0o700);
    if (profile) chownSync(path, Number(owner), -1);
    return;
  }
  powershell(
    `$ErrorActionPreference='Stop'; $v=ConvertFrom-Json $env:WORKBENCH_ACL_ARGUMENTS;
    $acl=New-Object Security.AccessControl.DirectorySecurity;
    $acl.SetAccessRuleProtection($true,$false);
    $owner=New-Object Security.Principal.SecurityIdentifier($v[1]); $acl.SetOwner($owner);
    foreach($sid in @($v[1],'S-1-5-18','S-1-5-32-544')) {
      $principal=New-Object Security.Principal.SecurityIdentifier($sid);
      $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
      $acl.AddAccessRule($rule);
    }
    if($v[2] -eq 'true') {
      $principal=New-Object Security.Principal.SecurityIdentifier('S-1-5-11');
      $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow');
      $acl.AddAccessRule($rule);
    }
    Set-Acl -LiteralPath $v[0] -AclObject $acl;`,
    [path, owner, String(shared)],
  );
}

function verifyWindowsPermissions(path: string, owner: string, privateDirectory = false): void {
  if (process.platform !== "win32") return;
  powershell(
    `$ErrorActionPreference='Stop'; $v=ConvertFrom-Json $env:WORKBENCH_ACL_ARGUMENTS;
    $acl=Get-Acl -LiteralPath $v[0];
    if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $v[1]) { throw 'Unsafe installation owner' }
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if($rule.AccessControlType -eq 'Allow' -and @($v[1],'S-1-5-18','S-1-5-32-544') -notcontains $rule.IdentityReference.Value -and
         ($v[2] -eq 'true' -or
          ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -ne 0 -or
          ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Delete) -ne 0 -or
          ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles) -ne 0 -or
          ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ChangePermissions) -ne 0 -or
          ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::TakeOwnership) -ne 0)) { throw 'Unsafe installation ACL' }
    }`,
    [path, owner, String(privateDirectory)],
  );
}

export function installationStores(): string[] {
  const system =
    process.platform === "linux"
      ? (process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share")
          .split(":")
          .filter(isAbsolute)
          .map((p) => join(p, "workbench/installations"))
      : process.platform === "darwin"
        ? ["/Library/Application Support/workbench/installations"]
        : process.env.PROGRAMDATA
          ? [join(process.env.PROGRAMDATA, "workbench/installations")]
          : [];
  return [join(userDirectory("data"), "installations"), ...system];
}
function json(base: string, name: string): unknown {
  return JSON.parse(distributionBytes(base, name, 1024 * 1024).toString("utf8")) as unknown;
}
function atomic(base: string, name: string, value: unknown, mode = 0o600): void {
  const path = ownedPath(base, name);
  const temporary = ownedPath(base, `${name}.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode });
  renameSync(temporary, path);
}
export function readInstallationStore(base: string): InstallationStore {
  const info = lstatSync(base);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new InvalidInput("installation store must be a real directory");
  const store = json(base, "store.json") as InstallationStore;
  if (
    (store as { schema_version: unknown }).schema_version !== 1 ||
    !["user", "system"].includes(store.scope) ||
    !identifier.test(store.owner) ||
    !uuid.test(store.id)
  )
    throw new InvalidInput("invalid installation store identity");
  if (store.scope === "system") protectedSystemParents(base);
  if (
    process.platform !== "win32" &&
    (String(info.uid) !== store.owner || info.mode & 0o022 || (store.scope === "system" && info.uid !== 0))
  )
    throw new InvalidInput("installation store ownership or permissions are unsafe");
  for (const name of ["owners", "versions"]) {
    const child = lstatSync(ownedPath(base, name));
    if (
      !child.isDirectory() ||
      (process.platform !== "win32" && (String(child.uid) !== store.owner || child.mode & 0o022))
    )
      throw new InvalidInput("installation store namespace ownership is unsafe");
  }
  if (process.platform === "win32") {
    if (store.scope === "system" && store.owner !== "S-1-5-32-544")
      throw new InvalidInput("system installation must be owned by Administrators");
    for (const path of [base, join(base, "owners"), join(base, "versions")])
      verifyWindowsPermissions(path, store.owner);
  }
  return store;
}
function authority(base: string): InstallationStore {
  const store = readInstallationStore(base);
  if (store.scope === "system" ? !administrator() : store.owner !== installationOwner())
    throw new InvalidInput("installation maintenance requires the store owner or system administrator");
  return store;
}
export function createInstallationStore(base: string, scope: "user" | "system"): InstallationStore {
  if (scope === "system" && !administrator())
    throw new InvalidInput("system installation requires administrator authority");
  if (scope === "system") protectedSystemParents(base);
  if (existsSync(base)) {
    const store = authority(base);
    if (store.scope !== scope) throw new InvalidInput("installation store scope differs from the request");
    return store;
  }
  mkdirSync(dirname(base), { recursive: true });
  mkdirSync(base, { mode: scope === "system" ? 0o755 : 0o700 });
  const store: InstallationStore = {
    schema_version: 1,
    scope,
    owner: scope === "system" && process.platform === "win32" ? "S-1-5-32-544" : installationOwner(),
    id: randomUUID(),
  };
  permissions(base, store.owner, scope === "system");
  for (const folder of ["versions", "owners"]) {
    const child = join(base, folder);
    mkdirSync(child, { mode: scope === "system" ? 0o755 : 0o700 });
    if (process.platform === "win32") permissions(child, store.owner, scope === "system");
  }
  atomic(base, "store.json", store, 0o644);
  atomic(base, "epoch.json", { token: randomUUID(), busy: false }, 0o644);
  provisionInstallationOwner(base, installationOwner());
  return store;
}
export function provisionInstallationOwner(base: string, owner: string): void {
  const store = authority(base);
  const account =
    process.platform === "win32" ? /^S-1-(?:\d+-)*\d+$/.test(owner) : /^\d+$/.test(owner) && Number(owner) < 4294967295;
  if (!account || (store.scope === "user" && owner !== store.owner))
    throw new InvalidInput("invalid installation account");
  withCacheLockSync(join(base, "maintenance"), () => {
    const path = ownedPath(base, `owners/${owner}`);
    if (existsSync(path)) {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && String(info.uid) !== owner))
        throw new InvalidInput("profile ownership does not match the provisioned account");
      return;
    }
    mkdirSync(path, { mode: 0o700 });
    permissions(path, owner, false, true);
  });
}
function ownerDirectory(base: string): string {
  readInstallationStore(base);
  const owner = installationOwner();
  const path = ownedPath(base, `owners/${owner}`);
  if (!existsSync(path))
    throw new InvalidInput(
      `installation account ${owner} is not provisioned; an administrator must run installation provision ${owner}`,
    );
  const info = lstatSync(path);
  if (!info.isDirectory() || (process.platform !== "win32" && (String(info.uid) !== owner || info.mode & 0o077)))
    throw new InvalidInput("installation profile directory has unsafe permissions");
  verifyWindowsPermissions(path, owner, true);
  return path;
}
export const installedVersion = (base: string, pin: DistributionPin): string => {
  if (!pinHash.test(pin.sha256)) throw new InvalidInput("invalid installation SHA-256");
  return ownedPath(base, `versions/${pin.sha256}`);
};

function readEpoch(base: string): Epoch {
  const epoch = json(base, "epoch.json") as Epoch;
  if (!uuid.test(epoch.token) || typeof epoch.busy !== "boolean")
    throw new InvalidInput("invalid installation coordination state");
  return epoch;
}
export function retainInstallation(
  base: string,
  pins: DistributionPin[],
  kind: RetentionRoot["kind"],
  id: string = randomUUID(),
): RetentionRoot {
  pins.forEach(validateDistributionPin);
  if (!uuid.test(id) || !pins.length) throw new InvalidInput("invalid installation retention root");
  const owner = ownerDirectory(base);
  return withCacheLockSync(join(owner, "writer"), () => {
    const before = readEpoch(base);
    if (before.busy)
      throw new InvalidInput("installation maintenance is active or needs recovery; retry after inspecting the store");
    const root: RetentionRoot = { schema_version: 1, id, kind, pins };
    // Publish reachability before checking the maintenance epoch again. GC fences all additions before scanning.
    atomic(owner, `${id}.json`, root);
    const after = readEpoch(base);
    if (after.busy || before.token !== after.token)
      throw new InvalidInput(
        "installation maintenance overlapped registration; the conservative root remains for repair",
      );
    for (const pin of pins) inspectDistribution(installedVersion(base, pin), pin);
    return root;
  });
}
export function releaseInstallationRoot(base: string, id: string): void {
  if (!uuid.test(id)) throw new InvalidInput("invalid retention root ID");
  const owner = ownerDirectory(base);
  withCacheLockSync(join(owner, "writer"), () => {
    rmSync(ownedPath(owner, `${id}.json`));
  });
}

/** Copy only verified inventory bytes; source code and hooks are never executed by installation. */
export function copyDistribution(source: string, destination: string, expected: DistributionPin): void {
  const { manifest } = inspectDistribution(source, expected);
  mkdirSync(destination, { mode: 0o755 });
  try {
    for (const [name, entry] of Object.entries(manifest.files)) {
      if (!existsSync(join(source, name)) && /^(src|tests|examples)\//.test(name)) continue;
      const output = ownedPath(destination, name);
      mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
      if ("link" in entry) {
        // Windows junctions need absolute targets, so use ordinary relative directory links in sealed distributions.
        symlinkSync(entry.link, output, process.platform === "win32" ? "dir" : undefined);
      } else
        writeFileSync(output, distributionBytes(source, name), { flag: "wx", mode: entry.executable ? 0o755 : 0o644 });
    }
    writeFileSync(join(destination, distributionManifest), distributionBytes(source, distributionManifest), {
      flag: "wx",
      mode: 0o644,
    });
    inspectDistribution(destination, expected);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
function makeImmutable(root: string): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) makeImmutable(path);
    else if (process.platform !== "win32") chmodSync(path, info.mode & 0o111 ? 0o555 : 0o444);
  }
  if (process.platform !== "win32") chmodSync(root, 0o555);
}
function removeVersion(root: string): void {
  // Store authority owns the immutable namespace. Never follow version symlinks during removal.
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new InvalidInput("invalid installed version directory");
  const writable = (path: string) => {
    if (process.platform !== "win32") chmodSync(path, 0o755);
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (lstatSync(child).isDirectory() && !lstatSync(child).isSymbolicLink()) writable(child);
    }
  };
  writable(root);
  rmSync(root, { recursive: true });
}
export function installDistribution(
  source: string,
  sha256: string,
  base: string,
  scope: "user" | "system",
): DistributionPin {
  if (digest(distributionBytes(source, distributionManifest, 8 * 1024 * 1024)) !== sha256)
    throw new InvalidInput("distribution SHA-256 differs from the independently selected digest");
  const { pin } = inspectDistribution(source);
  createInstallationStore(base, scope);
  authority(base);
  return withCacheLockSync(join(base, "maintenance"), () => {
    const destination = installedVersion(base, pin);
    if (existsSync(destination)) {
      inspectDistribution(destination, pin);
      return pin;
    }
    const staging = ownedPath(base, `versions/.install-${randomUUID()}`);
    copyDistribution(source, staging, pin);
    try {
      makeImmutable(staging);
      renameSync(staging, destination);
    } catch (error) {
      if (existsSync(staging)) removeVersion(staging);
      throw error;
    }
    return pin;
  });
}

export interface InstallationListing {
  pin: DistributionPin;
  reasons: { owner: string; id: string; kind: string }[];
}
export function listInstallations(base: string): InstallationListing[] {
  authority(base); // Full root inspection requires authority; it never crawls private project paths.
  const roots: { owner: string; root: RetentionRoot }[] = [];
  for (const owner of readdirSync(ownedPath(base, "owners"))) {
    if (!identifier.test(owner)) throw new InvalidInput("unknown installation ownership state; pruning is unsafe");
    const directory = ownedPath(base, `owners/${owner}`);
    const info = lstatSync(directory);
    if (!info.isDirectory() || (process.platform !== "win32" && (String(info.uid) !== owner || info.mode & 0o077)))
      throw new InvalidInput("unsafe or unreadable account roots; pruning is unsafe");
    verifyWindowsPermissions(directory, owner, true);
    for (const name of readdirSync(directory)) {
      if (name === "writer.lock")
        throw new InvalidInput("account roots have an active or abandoned writer; retry or repair before pruning");
      if (!/^[0-9a-f-]+\.json$/.test(name))
        throw new InvalidInput("unknown account retention state; pruning is unsafe");
      const root = json(directory, name) as RetentionRoot;
      if (
        !uuid.test(root.id) ||
        name !== `${root.id}.json` ||
        (root as { schema_version: unknown }).schema_version !== 1 ||
        !["profile", "use", "recovery", "launcher"].includes(root.kind) ||
        !Array.isArray(root.pins) ||
        !root.pins.length
      )
        throw new InvalidInput("invalid account retention root; pruning is unsafe");
      for (const pin of root.pins) {
        // Validate all identity fields without requiring the version still to be present during explicit repair.
        validateDistributionPin(pin);
      }
      roots.push({ owner, root });
    }
  }
  return readdirSync(ownedPath(base, "versions")).map((name) => {
    if (!pinHash.test(name)) throw new InvalidInput("incomplete or unknown installation; preserve it for recovery");
    const { pin } = inspectDistribution(ownedPath(base, `versions/${name}`));
    if (pin.sha256 !== name) throw new InvalidInput("version directory identity mismatch");
    return {
      pin,
      reasons: roots
        .filter(({ root }) => root.pins.some((p) => p.sha256 === pin.sha256))
        .map(({ owner, root }) => ({ owner, id: root.id, kind: root.kind })),
    };
  });
}
export function pruneInstallations(base: string, apply = false): InstallationListing[] {
  authority(base);
  return withCacheLockSync(join(base, "maintenance"), () => {
    const epoch = readEpoch(base);
    if (epoch.busy) throw new InvalidInput("interrupted installation maintenance needs explicit recovery");
    atomic(base, "epoch.json", { token: randomUUID(), busy: true }, 0o644);
    try {
      const list = listInstallations(base);
      if (apply) for (const entry of list) if (!entry.reasons.length) removeVersion(installedVersion(base, entry.pin));
      return list;
    } finally {
      atomic(base, "epoch.json", { token: randomUUID(), busy: false }, 0o644);
    }
  });
}

export function recoverInstallationStore(base: string): void {
  authority(base);
  // Does not steal a maintenance lock: the administrator first inspects/removes an abandoned claim explicitly.
  withCacheLockSync(join(base, "maintenance"), () => {
    listInstallations(base);
    atomic(base, "epoch.json", { token: randomUUID(), busy: false }, 0o644);
  });
}

export function defaultInstallation(base: string, pin: DistributionPin, forget: string[] = []): void {
  const store = authority(base);
  withCacheLockSync(join(base, "maintenance"), () => {
    inspectDistribution(installedVersion(base, pin), pin);
    const previous = existsSync(join(base, "default.json"))
      ? (json(base, "default.json") as { pin: DistributionPin; generations: DistributionPin[] })
      : undefined;
    const generations = [...(previous?.generations ?? [])];
    if (!generations.some((p) => p.sha256 === pin.sha256)) generations.push(pin);
    if (forget.includes(pin.sha256)) throw new InvalidInput("cannot forget the active default installation");
    for (const hash of forget)
      if (!generations.some((p) => p.sha256 === hash)) throw new InvalidInput(`unknown default generation: ${hash}`);
    const retained = generations.filter((p) => !forget.includes(p.sha256));
    retainInstallation(base, generations, "launcher", store.id);
    atomic(base, "default.json", { pin, generations: retained }, 0o644);
    const bin = ownedPath(base, "bin");
    mkdirSync(bin, { recursive: true, mode: 0o755 });
    const launcher = `import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const base=dirname(import.meta.dirname);
const {pin}=JSON.parse(readFileSync(join(base,'default.json'),'utf8'));
if(!/^[0-9a-f]{64}$/.test(pin.sha256))throw new Error('Invalid default Workbench identity');
const result=spawnSync(process.execPath,[join(base,'versions',pin.sha256,'bin/workbench.mjs'),...process.argv.slice(2)],{stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
`;
    atomicLauncher(bin, "workbench.mjs", launcher);
    atomicLauncher(
      bin,
      "workbench",
      '#!/usr/bin/env bash\nset -euo pipefail\nlauncher_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)\nexec node "$launcher_dir/workbench.mjs" "$@"\n',
    );
    atomicLauncher(bin, "workbench.cmd", '@echo off\r\nnode "%~dp0workbench.mjs" %*\r\n');
    retainInstallation(base, retained, "launcher", store.id);
  });
}
function atomicLauncher(root: string, name: string, text: string): void {
  const temporary = ownedPath(root, `${name}.${randomUUID()}.tmp`);
  writeFileSync(temporary, text, { flag: "wx", mode: 0o755 });
  renameSync(temporary, ownedPath(root, name));
}
