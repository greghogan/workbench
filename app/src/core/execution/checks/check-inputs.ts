import { currentExecutionEnvironment } from "../environments/execution-context.js";
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
import { delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { cpus, hostname, release } from "node:os";
import { distributionRoot } from "../../projects/project-context.js";
import { canonicalProject } from "../../projects/project-registry.js";
import { nativeCheckEnvironment, checkConfigurationFiles, checkBaseEnvironment } from "./check-environment.js";
import { nativeTools } from "../../toolchains/native/native-assets.js";
import { NativeToolUnavailable, toolProbes } from "../../toolchains/tool-probes.js";
import { resolveCheckCommand } from "../../toolchains/toolchains.js";
import { checkExecution } from "./check-resources.js";
import { buildCheckout, buildPaths, buildStorageSettings } from "../../artifacts/builds.js";
import { localConfiguration } from "../environments/environments.js";
import type { CheckPlan, CheckSelection } from "./check-plan.js";
import { checkSourcePolicy } from "./check-source-policy.js";
import { ownedPath } from "../../runtime/paths.js";
import { withConfigurationSnapshot } from "../../configuration/configuration-snapshot.js";
import { checkGateInputScope, inputScopeMatcher, type CheckInputScope } from "./check-input-scope.js";
import { distributionPathIncluded } from "../../distribution/distribution-layout.js";
import { generatedOutput } from "../../runtime/generated-file.js";
import { untrackedToolingOutput } from "../../distribution/tooling-artifacts.mjs";

export const inputDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const slash = (path: string) => path.split(sep).join("/");

/** Read contents rather than trusting stat freshness on network filesystems. */
export function fileDigest(path: string): string {
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

/** Preserve Git's selected index/object store while resolving its executable through the pristine host path. */
function gitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    ...Object.fromEntries(
      [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      ].flatMap((name) =>
        currentExecutionEnvironment()[name] === undefined ? [] : [[name, currentExecutionEnvironment()[name]]],
      ),
    ),
  };
}
function git(root: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    env: gitEnvironment(env),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("Git source inventory is unavailable");
  return result.stdout;
}

export function committedCheckCoverage(owner: string, path: string, env: NodeJS.ProcessEnv): string | undefined {
  const revision = env.WORKBENCH_COVERAGE_BASE ?? "HEAD";
  if (!revision || revision.startsWith("-") || /[\r\n:]/.test(revision))
    throw new Error("invalid coverage baseline revision");
  const result = spawnSync("git", ["-C", owner, "cat-file", "blob", `${revision}:${path}`], {
    env: gitEnvironment(env),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error("Git coverage baseline is unavailable", { cause: result.error });
  return result.status === 0 ? result.stdout : undefined;
}

/** Index snapshots and working directories use the same path/content/mode representation. */
export function sourceFingerprint(
  root: string,
  owner = root,
  staged = false,
  inputs?: readonly string[],
  whole = false,
): string {
  return inputDigest(sourceInventory(root, owner, staged, whole ? undefined : inputs)(inputs, whole));
}

export type CheckSourceEntry =
  | [path: string, kind: "directory"]
  | [path: string, kind: "file" | "executable" | "gitlink", digest: string]
  | [path: string, kind: "link", target: string, digest: string];

function sourceInventory(root: string, owner: string, staged: boolean, discover?: readonly string[]) {
  const env = checkBaseEnvironment(root, root);
  if (!staged && realpathSync(git(root, ["rev-parse", "--show-toplevel"], env).trim()) !== root)
    throw new Error("source inventory requires the project's Git root");
  const tree = staged ? currentExecutionEnvironment().WORKBENCH_REVIEW_TREE : undefined;
  if (tree !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree))
    throw new Error("invalid staged source tree");
  const inventory = tree
    ? git(owner, ["ls-tree", "--full-tree", "-rz", tree], env)
    : git(owner, ["ls-files", "--stage", "-z"], env);
  const modes = new Map<string, { mode: string; oid: string }>();
  for (const entry of inventory.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    const [mode, object, stage] = entry.slice(0, separator).split(" ");
    const oid = tree ? stage : object;
    if (!mode || !oid || separator < 0) throw new Error("invalid Git source inventory");
    if (!tree && stage !== "0") throw new Error("source index has unresolved entries");
    modes.set(entry.slice(separator + 1), { mode, oid });
  }
  const names = new Set(modes.keys());
  if (!staged)
    for (const name of git(
      root,
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        ...(discover && process.platform === "linux" && !discover.includes(".")
          ? ["--", ...discover.map((path) => `:(top,literal)${path}`)]
          : []),
      ],
      env,
    )
      .split("\0")
      .filter(Boolean))
      names.add(name);
  const policy = checkSourcePolicy(root);
  const addInput = (name: string): void => {
    const path = ownedPath(root, name);
    if (!existsSync(path)) return;
    if (lstatSync(path).isDirectory()) for (const child of readdirSync(path)) addInput(`${name}/${child}`);
    else names.add(name);
  };
  for (const input of policy.inputs) addInput(input);
  const digest = memoize(fileDigest);
  return (inputs?: readonly string[], whole = false) => {
    const selected = new Set(names);
    const matches = inputs && !whole ? inputScopeMatcher(inputs) : undefined;
    const namedExclusions = inputs && inputScopeMatcher(inputs.filter((name) => !policy.includes(name)));
    const includes = (name: string) =>
      (!matches || matches(name)) && (policy.includes(name) || namedExclusions?.(name) === true);
    const entries: CheckSourceEntry[] = [];
    if (matches && existsSync(join(root, "languages/index.toml")) && distributionRoot(root) === root)
      for (const name of names) {
        if (!matches(name)) continue;
        const generated = generatedOutput(name);
        if (generated && matches(generated) && untrackedToolingOutput(generated)) selected.add(generated);
      }
    if (inputs)
      for (const name of inputs) {
        // Explicit files can be ignored by Git. Directories use the normal Git inventory.
        ownedPath(root, posix.dirname(name));
        const metadata = sourceMetadata(join(root, name));
        if (metadata?.isDirectory()) entries.push([name, "directory"]);
        else if (metadata) selected.add(name);
      }
    for (const name of [...selected].sort()) {
      if (isAbsolute(name) || name.split("/").some((part) => !part || part === "." || part === ".." || part === ".git"))
        throw new Error("unsafe source inventory path");
      if (!includes(name)) continue;
      const path = join(root, name);
      const indexed = modes.get(name);
      if (indexed?.mode === "160000") {
        if (existsSync(join(path, ".git"))) throw new Error("initialized submodules require fresh checks");
        entries.push([name, "gitlink", indexed.oid]);
        continue;
      }
      const metadata = sourceMetadata(path);
      if (!metadata) continue;
      if (metadata.isSymbolicLink()) {
        const link = readlinkSync(path);
        const target = realpathSync(path);
        if (!target.startsWith(`${root}${sep}`) || !statSync(target).isFile())
          throw new Error("source links outside the tree or to directories require fresh checks");
        if (matches) {
          const captured = [target, resolve(dirname(path), link)].map((entry) => slash(relative(root, entry)));
          if (
            (process.platform === "darwin" && isAbsolute(link)) ||
            captured.some((name) => !selected.has(name) || !includes(name))
          )
            throw new Error("source link target is unavailable in the declared inputs");
        }
        entries.push([name, "link", link, digest(target)]);
      } else if (metadata.isFile()) {
        const executable = process.platform === "win32" ? indexed?.mode === "100755" : !!(metadata.mode & 0o111);
        entries.push([name, executable ? "executable" : "file", digest(path)]);
      } else throw new Error("non-file source entries require fresh checks");
    }
    return entries;
  };
}

function memoize<T>(read: (key: string) => T): (key: string) => T {
  const cached = new Map<string, T>();
  return (key) => {
    const found = cached.get(key);
    if (found !== undefined) return found;
    const value = read(key);
    cached.set(key, value);
    return value;
  };
}

function sourceMetadata(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
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
function distributionFingerprint(root: string, runtimeOnly = false): string {
  try {
    if (!runtimeOnly) return sourceFingerprint(root);
  } catch {
    /* Installed distributions need no Git checkout. */
  }
  const entries: unknown[] = [];
  const policy = checkSourcePolicy(root);
  function walk(name: string): void {
    if (
      distributionGenerated.has(posix.basename(name)) ||
      (runtimeOnly ? !distributionPathIncluded(name) : !policy.includes(name))
    )
      return;
    const path = join(root, name);
    const metadata = sourceMetadata(path);
    if (metadata?.isDirectory()) for (const child of readdirSync(path).sort()) walk(`${name}/${child}`);
    else if (metadata?.isFile()) entries.push([name, metadata.mode & 0o111, fileDigest(path)]);
    else if (metadata?.isSymbolicLink()) throw new Error("distribution links require fresh checks");
  }
  // A source checkout can also be its own distribution. Bind the runtime inputs
  // independently of the selected checks without folding every project root back into their key.
  const names = runtimeOnly
    ? [
        ".node-version",
        ".tool-versions",
        "package.json",
        "pnpm-lock.yaml",
        "bin",
        "bundle",
        "languages",
        "scripts",
        "app/resources",
        "app/src",
      ]
    : readdirSync(root).sort();
  for (const name of names) walk(name);
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
  configurationFiles?: Record<string, string> | undefined;
  inputScope?: CheckInputScope;
  freshSource?: string;
  scopedSource?: readonly CheckSourceEntry[];
  coverageBaselines?: Record<string, string | null>;
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

export function safeConfigurationDigests(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (
    entries.length > 32 ||
    entries.some(
      ([path, digest]) =>
        !path.length ||
        path.length > 192 ||
        /\p{Cc}/u.test(path) ||
        typeof digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(digest),
    ) ||
    Buffer.byteLength(JSON.stringify(entries)) > 8192
  )
    return undefined;
  return Object.fromEntries(entries);
}

export function changedConfigurationFiles(before: CheckFingerprint, after: CheckFingerprint): string[] {
  if (!before.configurationFiles || !after.configurationFiles) return [];
  return [...new Set([...Object.keys(before.configurationFiles), ...Object.keys(after.configurationFiles)])]
    .filter((path) => before.configurationFiles?.[path] !== after.configurationFiles?.[path])
    .sort();
}

/** Compare digests only; diagnostics never expose source or environment values. */
export function changedCheckInputs(before: CheckFingerprint, after: CheckFingerprint): string[] {
  return Object.keys(before.components).filter((name) => before.components[name] !== after.components[name]);
}

export function changedRunInputs(before: CheckFingerprint, after: CheckFingerprint): string[] {
  const changed = changedCheckInputs(before, after);
  if (before.freshSource !== after.freshSource && !changed.includes("source")) changed.unshift("source");
  return changed;
}

/** Only identified native environments are reusable; mutable managed shells run fresh. */
export function checkFingerprint(root: string, options: CheckSelection, plan: CheckPlan): CheckFingerprint {
  return withConfigurationSnapshot(() => configuredFingerprint(root, options, plan));
}

function checkSourceContext(root: string) {
  // A container can retain the original checkout name for cache ownership without mounting it.
  const owner = canonicalProject(currentExecutionEnvironment().WORKBENCH_LOCAL_CONFIG_ROOT ?? buildCheckout(root));
  const staged = currentExecutionEnvironment().WORKBENCH_EPHEMERAL_CHECKOUT === "1";
  return { owner, staged, sourceOwner: staged ? owner : root };
}

interface SourceObservation {
  digest: string;
  entries: CheckSourceEntry[];
}
type ReadSource = (paths?: readonly string[], whole?: boolean) => SourceObservation;

function sourceReader(root: string, owner: string, staged: boolean): ReadSource {
  let inventory: ReturnType<typeof sourceInventory> | undefined;
  const read = memoize((key) => {
    inventory ??= sourceInventory(root, owner, staged);
    const [paths, whole] = JSON.parse(key) as [string[] | null, boolean];
    const entries = inventory(paths ?? undefined, whole);
    return { digest: inputDigest(entries), entries };
  });
  return (paths, whole = false) => read(JSON.stringify([paths ?? null, whole]));
}

export function captureCheckSource(root: string, paths: readonly string[]): SourceObservation {
  const { sourceOwner, staged } = checkSourceContext(root);
  return sourceReader(root, sourceOwner, staged)(paths);
}

/** Share Git inventory, bytes, and probes across group receipts for one observation. */
export function checkFingerprintBatch(root: string, options: CheckSelection) {
  const { sourceOwner, staged } = checkSourceContext(root);
  const shared = {
    source: sourceReader(root, sourceOwner, staged),
    confirm: sourceReader(root, sourceOwner, staged),
    digest: memoize(fileDigest),
    distribution: memoize((path) => distributionFingerprint(path, path === root)),
    probes: new Map<string, string>(),
  };
  return {
    fingerprint: (plan: CheckPlan, scope: CheckInputScope) =>
      withConfigurationSnapshot(() => configuredFingerprint(root, options, plan, { scope, ...shared })),
    freshSource: () => shared.source().digest,
  };
}

function configuredFingerprint(
  root: string,
  options: CheckSelection,
  plan: CheckPlan,
  batch?: {
    scope: CheckInputScope;
    source: ReadSource;
    confirm: ReadSource;
    digest: (path: string) => string;
    distribution: (path: string) => string;
    probes: Map<string, string>;
  },
): CheckFingerprint {
  if (plan.sessions.some((session) => session.environment !== "native"))
    throw new Error("managed environments require fresh checks");
  const { owner, staged, sourceOwner } = checkSourceContext(root);
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
  const readSource: ReadSource =
    batch?.source ??
    ((inputs, whole) => {
      const entries = sourceInventory(root, sourceOwner, staged, whole ? undefined : inputs)(inputs, whole);
      return { digest: inputDigest(entries), entries };
    });
  const confirmSource = batch?.confirm ?? readSource;
  const digest = batch?.digest ?? fileDigest;
  let inputScope = batch?.scope ?? checkGateInputScope(plan.sessions, checkSourcePolicy(root).inputs);
  let source: SourceObservation | undefined;
  if (inputScope.mode === "scoped") {
    try {
      source = readSource(inputScope.paths);
    } catch {
      inputScope = {
        mode: "whole-project",
        reason: "Declared inputs could not be inventoried safely",
        paths: inputScope.paths,
      };
    }
  }
  const whole = inputScope.mode === "whole-project";
  source ??= readSource(inputScope.paths, whole);
  const freshSource =
    !batch &&
    inputScope.mode === "scoped" &&
    plan.sessions.some((session) => session.checks.some((check) => check.role === "secret"))
      ? readSource().digest
      : undefined;
  const distribution = distributionRoot(root);
  const toolFiles = new Map<string, string>();
  const binaries = new Map<string, string>();
  const binary = (name: string, cwd: string, env: NodeJS.ProcessEnv) => {
    const path = executable(name, cwd, env);
    let hash = binaries.get(path);
    if (!hash) {
      hash = digest(path);
      binaries.set(path, hash);
    }
    toolFiles.set(normalize(path), inputDigest([hash, statSync(path).mode & 0o111]));
    return path;
  };
  const probes = batch?.probes ?? new Map<string, string>();
  const allocation = checkExecution(root, plan);
  const environments: unknown[] = [];
  const variableInputs = new Map<string, [string, string][]>();
  const configurationInputs = new Map<string, string>();
  const sessions = plan.sessions.map((session, index) => {
    const env = nativeCheckEnvironment(root, session.directory, options, allocation.cpuLimit, paths[index]);
    const configuration = checkConfigurationFiles(root, session.directory, env)
      .map((path): [string, string | null] => [normalize(path), existsSync(path) ? digest(path) : null])
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [path, digest] of configuration) configurationInputs.set(path, inputDigest(digest));
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
          const key = inputDigest([path, probe.args, env, session.directory]);
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
            version = result.stdout + result.stderr;
            probes.set(key, version);
          }
          toolVersions.push([tool.name, probe.name, normalize(version)]);
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
    .map((path) => [path, digest(path)]);
  if (source.digest !== confirmSource(inputScope.paths, whole).digest)
    throw new Error("source files changed while identifying inputs");
  const baselines = [...new Set(plan.sessions.map((session) => session.directory))].map((directory) => {
    const path = slash(relative(root, join(directory, "coverage/coverage-summary.json")));
    const contents = committedCheckCoverage(owner, path, base);
    return [path, contents === undefined ? null : inputDigest(contents)] as const;
  });
  const material = {
    version: 1,
    ...(options.offline && { offline: true }),
    source: source.digest,
    ...(inputScope.mode === "scoped" ? { inputScope } : {}),
    sessions,
    environment: environments,
    hostFiles,
    baselines,
    distribution:
      distribution === root && inputScope.mode === "whole-project"
        ? source.digest
        : (batch?.distribution(distribution) ?? distributionFingerprint(distribution, distribution === root)),
    tools: [...toolFiles].sort(([a], [b]) => a.localeCompare(b)),
    platform: [process.platform, process.arch, release(), hostname(), cpus()[0]?.model, process.versions],
    allocation,
    preferences: [localConfiguration(root), buildStorageSettings(root)],
  };
  return {
    key: inputDigest(material),
    inputScope,
    ...(freshSource === undefined ? {} : { freshSource }),
    ...(inputScope.mode === "scoped"
      ? { scopedSource: source.entries, coverageBaselines: Object.fromEntries(baselines) }
      : {}),
    environmentVariables: safeEnvironmentDigests(
      Object.fromEntries([...variableInputs].map(([name, values]) => [name, inputDigest(values)])),
    ),
    configurationFiles: safeConfigurationDigests(Object.fromEntries(configurationInputs)),
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
