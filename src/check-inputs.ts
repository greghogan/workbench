import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { cpus, hostname, release } from "node:os";
import { distributionRoot } from "./core.js";
import { nativeCheckEnvironment, checkConfigurationFiles, checkBaseEnvironment } from "./check-environment.js";
import { nativeTools } from "./native-assets.js";
import { NativeToolUnavailable, toolProbes } from "./tool-probes.js";
import { resolveCheckCommand } from "./toolchains.js";
import { checkExecution } from "./check-resources.js";
import { required } from "./invariants.js";
import { buildCheckout, buildPaths, buildStorageSettings } from "./builds.js";
import { localConfiguration } from "./environments.js";
import type { CheckSelection, planChecks } from "./check-plan.js";
import { checkSourcePolicy } from "./check-source-policy.js";
import { ownedPath } from "./paths.js";

type Plan = ReturnType<typeof planChecks>;
export const inputDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const slash = (path: string) => path.split(sep).join("/");

/** Read contents rather than trusting stat freshness on network filesystems. */
function fileDigest(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(65536);
  const file = openSync(path, "r");
  try {
    let count: number;
    while ((count = readSync(file, buffer)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } finally {
    closeSync(file);
  }
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("Git source inventory is unavailable");
  return result.stdout;
}

/** Index snapshots and working directories use the same path/content/mode representation. */
export function sourceFingerprint(root: string, owner = root, staged = false): string {
  if (!staged && realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== root)
    throw new Error("source inventory requires the project's Git root");
  const index = git(owner, ["ls-files", "--stage", "-z"]);
  const modes = new Map<string, { mode: string; oid: string }>();
  for (const entry of index.split("\0").filter(Boolean)) {
    const match = /^([0-9]+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(entry);
    if (match?.[3] !== "0") throw new Error("source index has unresolved entries");
    modes.set(match[4] ?? "", { mode: match[1] ?? "", oid: match[2] ?? "" });
  }
  const names = new Set(modes.keys());
  if (!staged)
    for (const name of git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))
      names.add(name);
  const policy = checkSourcePolicy(root);
  const addInput = (name: string): void => {
    const path = ownedPath(root, name);
    if (!existsSync(path)) return;
    if (lstatSync(path).isDirectory()) for (const child of readdirSync(path)) addInput(`${name}/${child}`);
    else names.add(name);
  };
  for (const input of policy.inputs) addInput(input);
  const entries: unknown[] = [];
  for (const name of [...names].sort()) {
    if (isAbsolute(name) || name.split("/").some((part) => !part || part === "." || part === ".." || part === ".git"))
      throw new Error("unsafe source inventory path");
    if (!policy.includes(name)) continue;
    const path = join(root, name);
    const indexed = modes.get(name);
    if (indexed?.mode === "160000") {
      if (existsSync(join(path, ".git"))) throw new Error("initialized submodules require fresh checks");
      entries.push([name, "gitlink", indexed.oid]);
      continue;
    }
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      const target = realpathSync(path);
      if (!target.startsWith(`${root}${sep}`) || !statSync(target).isFile())
        throw new Error("source links outside the tree or to directories require fresh checks");
      entries.push([name, "link", readlinkSync(path), fileDigest(target)]);
    } else if (metadata.isFile()) {
      const executable = process.platform === "win32" ? indexed?.mode === "100755" : !!(metadata.mode & 0o111);
      entries.push([name, executable ? "executable" : "file", fileDigest(path)]);
    } else throw new Error("non-file source entries require fresh checks");
  }
  return inputDigest(entries);
}

const distributionGenerated = new Set([
  ".git",
  "node_modules",
  "build",
  "target",
  "dist",
  "coverage",
  ".pnpm-store",
  ".local-collections",
  ".collections",
  "__pycache__",
]);
function distributionFingerprint(root: string): string {
  try {
    return sourceFingerprint(root);
  } catch {
    /* Installed distributions need no Git checkout. */
  }
  const entries: unknown[] = [];
  const policy = checkSourcePolicy(root);
  function walk(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      if (distributionGenerated.has(name)) continue;
      const path = join(directory, name),
        metadata = lstatSync(path);
      if (!policy.includes(slash(relative(root, path)))) continue;
      if (metadata.isDirectory()) walk(path);
      else if (metadata.isFile()) entries.push([slash(relative(root, path)), metadata.mode & 0o111, fileDigest(path)]);
      else if (metadata.isSymbolicLink()) throw new Error("distribution links require fresh checks");
    }
  }
  walk(root);
  return inputDigest(entries);
}

function executable(name: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const candidates =
    isAbsolute(name) || /[/\\]/.test(name)
      ? [resolve(cwd, name)]
      : (env.PATH ?? "").split(delimiter).map((path) => resolve(cwd, path, name));
  const suffixes = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
  for (const path of candidates)
    for (const suffix of suffixes) {
      const candidate = path + suffix;
      if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
    }
  throw new Error(`tool unavailable for check fingerprint: ${name}`);
}

export interface CheckFingerprint {
  key: string;
  components: Record<string, string>;
  environmentVariables?: Record<string, string> | undefined;
}

/** Optional, bounded diagnostics; neither values nor arbitrary receipt text may reach the terminal. */
export function safeEnvironmentDigests(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (
    entries.length > 256 ||
    entries.some(
      ([name, digest]) =>
        !/^[A-Za-z_][A-Za-z_0-9()]{0,127}$/.test(name) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest),
    )
  )
    return undefined;
  return Object.fromEntries(entries);
}

export function changedEnvironmentVariables(before: CheckFingerprint, after: CheckFingerprint): string[] {
  if (!before.environmentVariables || !after.environmentVariables) return [];
  return [...new Set([...Object.keys(before.environmentVariables), ...Object.keys(after.environmentVariables)])]
    .filter((name) => before.environmentVariables?.[name] !== after.environmentVariables?.[name])
    .sort();
}

/** Compare digests only; diagnostics never expose source or environment values. */
export function changedCheckInputs(before: CheckFingerprint, after: CheckFingerprint): string[] {
  return Object.keys(before.components).filter((name) => before.components[name] !== after.components[name]);
}

/** Only identified native environments are reusable; mutable managed shells run fresh. */
export function checkFingerprint(root: string, options: CheckSelection, plan: Plan): CheckFingerprint {
  if (plan.sessions.some((session) => session.environment !== "native"))
    throw new Error("managed environments require fresh checks");
  const owner = realpathSync(process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? buildCheckout(root));
  const paths = plan.sessions.map((session) => buildPaths(root, session.directory, "native", options));
  const normalize = (value: string) => {
    // Snapshot outputs stay isolated; their generated locations are not different check inputs.
    for (const path of paths) {
      const scope = `${slash(path.identity.root)}:${path.identity.fingerprint}`;
      for (const [location, label] of [
        [path.directory, `<build:${scope}>`],
        [path.dependencies, `<dependencies:${scope}>`],
      ] as const)
        value = value.replaceAll(location, label).replaceAll(JSON.stringify(location).slice(1, -1), label);
    }
    return value.replaceAll(root, "<checkout>").replaceAll(owner, "<checkout>");
  };
  const staged = process.env.WORKBENCH_EPHEMERAL_CHECKOUT === "1";
  const source = sourceFingerprint(root, staged ? owner : root, staged);
  const distribution = distributionRoot(root);
  const toolFiles = new Map<string, string>();
  const binaries = new Map<string, string>();
  const binary = (name: string, cwd: string, env: NodeJS.ProcessEnv) => {
    const path = executable(name, cwd, env);
    let hash = binaries.get(path);
    if (!hash) {
      hash = fileDigest(path);
      binaries.set(path, hash);
    }
    toolFiles.set(normalize(path), inputDigest([hash, statSync(path).mode & 0o111]));
    return path;
  };
  const probes = new Map<string, string>();
  const allocation = checkExecution(root, plan);
  const environments: unknown[] = [];
  const variableInputs = new Map<string, [string, string][]>();
  const sessions = plan.sessions.map((session, index) => {
    const env = nativeCheckEnvironment(
      root,
      session.directory,
      options,
      required(allocation.cpus[index], "missing check CPU allocation"),
      paths[index],
    );
    const configuration = checkConfigurationFiles(root, session.directory, env).map((path) => [
      normalize(path),
      existsSync(path) ? fileDigest(path) : null,
    ]);
    const scope = slash(relative(root, session.directory)) || ".";
    const variables = Object.entries(env)
      .filter(
        ([name]) =>
          ![
            "WORKBENCH_LOCAL_CONFIG_ROOT",
            "WORKBENCH_EPHEMERAL_CHECKOUT",
            "WORKBENCH_PROJECT_ROOT",
            "WORKBENCH_POLICY_REVIEW",
          ].includes(name),
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]): [string, string] => [name, normalize(value ?? "")]);
    environments.push([scope, variables, configuration]);
    for (const [name, value] of variables) {
      const inputs = variableInputs.get(name) ?? [];
      inputs.push([scope, value]);
      variableInputs.set(name, inputs);
    }
    const toolVersions: unknown[] = [];
    for (const tool of nativeTools(session.directory, distribution, options).filter((tool) => tool.name !== "miri")) {
      try {
        for (const probe of toolProbes(tool)) {
          let name = probe.compilerVariable ? (env[probe.compilerVariable] ?? probe.executable) : probe.executable;
          if (tool.name === "rust") {
            const found = spawnSync("rustup", ["which", "--toolchain", tool.version, probe.executable], {
              env,
              encoding: "utf8",
              timeout: 10000,
            });
            if (found.status !== 0) throw new Error("Rust toolchain identity is unavailable");
            name = found.stdout.trim();
          }
          const path = binary(name, session.directory, env);
          const key = inputDigest([path, probe.args, env]);
          let version = probes.get(key);
          if (version === undefined) {
            const result = spawnSync(path, probe.args, {
              cwd: session.directory,
              env,
              encoding: "utf8",
              timeout: 10000,
              maxBuffer: 1024 * 1024,
            });
            if (result.status !== 0)
              throw new Error(
                `${probe.name} cannot start: ${result.error?.message ?? (result.stderr.trim().slice(-1000) || `exit status ${String(result.status)}`)}`,
              );
            version = normalize(result.stdout + result.stderr);
            probes.set(key, version);
          }
          toolVersions.push([tool.name, probe.name, version]);
        }
      } catch (cause) {
        const path = slash(relative(root, session.directory)) || ".";
        throw new NativeToolUnavailable(
          `Cannot verify ${tool.name} ${tool.version} for ${path}: ${cause instanceof Error ? cause.message : String(cause)}. Install the pinned tools with workbench tools install --path ${path}.`,
          { cause },
        );
      }
    }
    const commands = session.checks.map((check) => {
      const command = resolveCheckCommand(session.directory, check.command, distribution);
      binary(command[0] ?? "", session.directory, env);
      for (const argument of check.role === "secret" ? [] : command.slice(1)) {
        const path = resolve(session.directory, argument);
        if (existsSync(path) && statSync(path).isFile()) binary(path, session.directory, env);
      }
      return [check.name, check.role, check.command.map(normalize), check.warnSeconds ?? null, check.requiresSetup];
    });
    return [slash(relative(root, session.directory)) || ".", session.environment, commands, toolVersions];
  });
  const base = checkBaseEnvironment(root, root);
  for (const name of [process.execPath, "git", "sh", "bash", "env"]) binary(name, root, base);
  const hostFiles = [
    "/etc/os-release",
    "/var/lib/dpkg/status",
    "/var/lib/rpm/rpmdb.sqlite",
    "/usr/lib/sysimage/rpm/rpmdb.sqlite",
  ]
    .filter((path) => existsSync(path))
    .map((path) => [path, fileDigest(path)]);
  if (source !== sourceFingerprint(root, staged ? owner : root, staged))
    throw new Error("source files changed while identifying inputs");
  const revision = base.WORKBENCH_COVERAGE_BASE ?? "HEAD";
  if (!revision || revision.startsWith("-") || /[\r\n:]/.test(revision))
    throw new Error("invalid coverage baseline revision");
  const baselines = [...new Set(plan.sessions.map((session) => session.directory))].map((directory) => {
    const path = slash(relative(root, join(directory, "coverage/coverage-summary.json")));
    const result = spawnSync("git", ["-C", owner, "cat-file", "blob", `${revision}:${path}`], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) throw new Error("Git coverage baseline is unavailable", { cause: result.error });
    return [path, result.status === 0 ? inputDigest(result.stdout) : null];
  });
  const material = {
    version: 1,
    source,
    sessions,
    environment: environments,
    hostFiles,
    baselines,
    distribution: distribution === root ? source : distributionFingerprint(distribution),
    tools: [...toolFiles].sort(([a], [b]) => a.localeCompare(b)),
    platform: [process.platform, process.arch, release(), hostname(), cpus()[0]?.model, process.versions],
    allocation,
    preferences: [localConfiguration(root), buildStorageSettings(root)],
  };
  return {
    key: inputDigest(material),
    environmentVariables: safeEnvironmentDigests(
      Object.fromEntries([...variableInputs].map(([name, values]) => [name, inputDigest(values)])),
    ),
    components: {
      source: inputDigest([material.source, material.baselines]),
      checks: inputDigest([material.sessions, material.allocation.dependencies]),
      environment: inputDigest(material.environment),
      host: inputDigest([material.hostFiles, material.platform]),
      distribution: inputDigest(material.distribution),
      tools: inputDigest(material.tools),
      allocation: inputDigest(material.allocation),
      preferences: inputDigest(material.preferences),
    },
  };
}
