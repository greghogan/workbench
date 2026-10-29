import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { developmentRoots } from "./workspace.mjs";
import {
  MaintenanceKind,
  MaintenanceProvider,
  MaintenanceState,
  requestedVersion,
  declaredVersion,
  type MaintenanceEntry,
  type MaintenanceCommand,
} from "./contract.mjs";

import { record, records, string, strings } from "../values.mjs";

/** Declaration kinds choose authorities; lock refresh includes every manager in each affected root. */
export function maintenanceLockSelection(
  root: string,
  entries: MaintenanceEntry[],
  authorities: string[],
): MaintenanceEntry[] {
  const roots = developmentRoots(root).sort((a, b) => b.length - a.length);
  const known = new Set(entries.map((entry) => entry.path));
  const paths = authorities.filter((path) => known.has(path));
  const owningRoot = (path: string) => roots.find((root) => root === "." || path.startsWith(`${root}/`));
  const shared = paths.some((path) =>
    ["workbench/config.toml", "workbench/projects.toml", "channels.scm", "scripts/bootstrap-tools.json"].includes(path),
  );
  const selected = new Set(shared ? roots : paths.map(owningRoot));
  return entries.filter((entry) => selected.has(owningRoot(entry.path)));
}
interface LockContext {
  changes: MaintenanceEntry[];
  cli: string;
  root: string;
  shell: (args: string[]) => MaintenanceCommand;
}
const packageLockAdapters: Partial<Record<MaintenanceProvider, (context: LockContext) => MaintenanceCommand[]>> = {
  [MaintenanceProvider.Npm]: ({ cli, shell }) => [
    shell(["node", cli, "package-manager-exec", "--", "update", "--no-save", "--lockfile-only"]),
  ],
  [MaintenanceProvider.Python]: ({ shell }) => [shell(["uv", "lock", "--upgrade"])],
  [MaintenanceProvider.Cargo]: ({ shell }) => [shell(["cargo", "update"])],
  [MaintenanceProvider.Ruby]: ({ root, shell }) => [
    shell(["node", join(root, "scripts/maintenance/main.mjs"), "ruby-lock"]),
  ],
  [MaintenanceProvider.Go]: ({ changes, shell }) => [
    shell([
      "go",
      "get",
      ...changes
        .filter((entry) => entry.provider === MaintenanceProvider.Go)
        .map((entry) => `${entry.name}@v${entry.selected?.version ?? declaredVersion(entry)}`),
    ]),
    shell(["go", "mod", "tidy"]),
  ],
};
/** Resolve locks through their existing verified managers; the plan never supplies command text. */
export function maintenanceLockCommands(
  root: string,
  entries: MaintenanceEntry[],
  upgradePaths = entries
    .filter((entry) => entry.state === MaintenanceState.Available && entry.kind === MaintenanceKind.Dependencies)
    .map((entry) => entry.path),
  options: { nixDocker?: boolean } = {},
): MaintenanceCommand[] {
  if (!entries.length) return [];
  const node = (args: string[], cwd = root, environment?: Record<string, string>): MaintenanceCommand => ({
    command: process.execPath,
    arguments: args,
    cwd,
    ...(environment ? { environment } : {}),
  });
  const cli = join(root, "bin/workbench.mjs");
  const result: MaintenanceCommand[] = [];
  const containerManifest = "scripts/container-tools/package.json";
  if (entries.some((entry) => entry.path === containerManifest && entry.provider === MaintenanceProvider.Npm)) {
    const upgrade = upgradePaths.includes(containerManifest);
    result.push(node([cli, "tools", "install", "--path", ".", "--exclude-tool", "miri"]));
    result.push(
      node([
        cli,
        "shell",
        "--path",
        ".",
        "--environment",
        "native",
        "--",
        "npm",
        upgrade ? "install" : "ci",
        "--prefix",
        join(root, "scripts/container-tools"),
        ...(upgrade ? ["--package-lock-only"] : []),
        "--ignore-scripts",
      ]),
    );
  }
  const manager = entries.find((entry) => entry.path === "package.json" && entry.name === "packageManager");
  const bootstrapLock = join(root, "scripts/package-manager/package-lock.json");
  let refreshBootstrap = manager?.state === MaintenanceState.Available;
  if (manager && existsSync(bootstrapLock)) {
    const packages = record(
      record(JSON.parse(readFileSync(bootstrapLock, "utf8")), "Invalid bootstrap lock").packages,
      "Missing bootstrap packages",
    );
    const name = manager.current.split("@")[0] ?? "";
    const version = record(packages[`node_modules/${name}`], "Missing locked package manager").version;
    refreshBootstrap ||= version !== (manager.selected?.version ?? requestedVersion(manager.current));
  }
  if (refreshBootstrap) {
    result.push(node([cli, "tools", "install", "--path", ".", "--exclude-tool", "miri"]));
    result.push(
      node([
        cli,
        "shell",
        "--path",
        ".",
        "--environment",
        "native",
        "--",
        "npm",
        "install",
        "--prefix",
        join(root, "scripts/package-manager"),
        "--package-lock-only",
        "--ignore-scripts",
      ]),
    );
  }
  const configuration = parseToml(readFileSync(join(root, "workbench/config.toml"), "utf8"));
  const profiles = records(
    record(configuration.toolchains ?? {}, "Invalid toolchain configuration").profiles ?? [],
    "Invalid toolchain profiles",
  );
  const prepareProfiles = new Set<string>();
  const host = `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform}-${process.arch}`;
  const supported = (profile: Record<string, unknown>) =>
    profile.platforms === undefined || strings(profile.platforms, "Invalid profile platforms").includes(host);
  for (const entry of entries) {
    const index =
      entry.path === "workbench/config.toml"
        ? entry.locator?.kind === "field" &&
          entry.locator.path[0] === "toolchains" &&
          entry.locator.path[1] === "profiles"
          ? entry.locator.path[2]
          : undefined
        : undefined;
    const profile = index ? profiles[Number(index)] : undefined;
    if (profile && supported(profile)) prepareProfiles.add(string(profile.name, "Missing toolchain profile name"));
    if (entry.path === "workbench/projects.toml")
      for (const profile of profiles)
        if (profile.compiler === entry.name && supported(profile))
          prepareProfiles.add(string(profile.name, "Missing compiler profile name"));
  }
  for (const profile of prepareProfiles)
    result.push(node([cli, "tools", "install", "--toolchain", profile, "--exclude-tool", "miri"]));
  const roots = developmentRoots(root).sort((a, b) => b.length - a.length);
  for (const path of roots) {
    const directory = path === "." ? root : join(root, path);
    const changes = entries.filter(
      (entry) =>
        entry.path !== containerManifest &&
        roots.find((candidate) => candidate === "." || entry.path.startsWith(`${candidate}/`)) === path,
    );
    if (!changes.length) continue;
    const providers = new Set(changes.map((entry) => entry.provider));
    const shell = (command: string[]) =>
      node([cli, "shell", "--path", path, "--environment", "native", "--", ...command], root);
    result.push(node([cli, "tools", "install", "--path", path, "--exclude-tool", "miri"]));
    const upgrade = changes.some((entry) => upgradePaths.includes(entry.path));
    for (const provider of providers) {
      const adapter = packageLockAdapters[provider];
      if (upgrade && adapter) result.push(...adapter({ changes, cli, root, shell }));
    }
    if (!upgrade) {
      if (
        [
          MaintenanceProvider.Npm,
          MaintenanceProvider.Python,
          MaintenanceProvider.Ruby,
          MaintenanceProvider.Composer,
          MaintenanceProvider.Maven,
        ].some((provider) => providers.has(provider))
      )
        result.push(node([cli, "check", "--path", path, "--environment", "native", "--role", "setup", "--plain"]));
      if (providers.has(MaintenanceProvider.Cargo)) result.push(shell(["cargo", "fetch", "--locked"]));
      if (providers.has(MaintenanceProvider.Go))
        result.push(shell(["go", "list", "-mod=readonly", "-m", "all"]), shell(["go", "mod", "verify"]));
    }
    if (upgrade && providers.has(MaintenanceProvider.Composer))
      result.push(
        node([cli, "check", "--path", path, "--environment", "native", "--role", "dependency-lock", "--plain"]),
      );
    if (upgrade && providers.has(MaintenanceProvider.Maven)) {
      const proposal = join(
        root,
        "build/maintenance",
        "maven-" +
          createHash("sha256")
            .update(directory)
            .update(readFileSync(join(directory, "pom.xml")))
            .digest("hex")
            .slice(0, 24),
      );
      result.push(node([join(root, "scripts/maintenance/main.mjs"), "maven-lock", directory, proposal]));
      const project = records(
        parseToml(readFileSync(join(root, "workbench/projects.toml"), "utf8")).language_root,
        "Missing roots",
      ).find((entry) => entry.path === path);
      const environments = strings(
        project?.ci_environments ?? [
          "native",
          ...strings(
            record(configuration.ci ?? {}, "Invalid CI settings").environments ?? [],
            "Invalid managed environments",
          ),
        ],
        "Invalid Maven environments",
      );
      for (const environment of environments) {
        if (environment !== "native") result.push(node([join(root, "scripts/managed-inputs.mjs"), "--path", path]));
        if (!["native", "nix", "guix"].includes(environment))
          throw new Error(`Unsupported Maven environment: ${environment}`);
        const command =
          environment === "nix" && options.nixDocker
            ? [cli, "check", "--path", path, "--environment", "nix-docker", "--role", "dependency-verify", "--plain"]
            : [
                cli,
                "shell",
                "--path",
                path,
                "--environment",
                environment,
                "--",
                "node",
                "scripts/check.mjs",
                "dependency-verify",
                root,
              ];
        result.push({
          ...node(command),
          checksums: { project: directory, path: join(directory, ".mvn/checksums/checksums.sha256"), environment },
        });
      }
    }
    // An update must not silently move the application's Go support boundary.
    if (providers.has(MaintenanceProvider.Go)) {
      const minimum = /^go (\S+)$/m.exec(readFileSync(join(directory, "go.mod"), "utf8"))?.[1];
      if (!minimum) throw new Error(`Missing Go support boundary: ${path}`);
      result.push(
        node(
          [
            "-e",
            "const f=require('node:fs'); const s=f.readFileSync('go.mod','utf8'); if (/^go (\\S+)$/m.exec(s)?.[1] !== process.argv[1]) throw Error('The module update changed the declared Go minimum; review before retaining it');",
            minimum,
          ],
          directory,
        ),
      );
    }
  }
  result.push(node([join(root, "scripts/refresh-managed-inputs.mjs")]));
  result.push(node([join(root, "scripts/managed-inputs.mjs")]));
  result.push(node([cli, "native-assets-prune"]));
  const prepared = new Set<string>();
  return result.filter((command) => {
    if (command.arguments[1] !== "tools" || command.arguments[2] !== "install") return true;
    const key = JSON.stringify(command);
    if (prepared.has(key)) return false;
    prepared.add(key);
    return true;
  });
}
