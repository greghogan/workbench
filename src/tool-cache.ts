import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { userDirectory } from "./storage.js";
import { ownedPath } from "./paths.js";
import { cacheBytes } from "./cache-size.js";
import { withCacheLocksSync } from "./cache-lock.js";
import { withToolCacheMaintenance, inspectToolCacheActivity } from "./tool-cache-lock.js";
import { nativeInstallationPlan, nativeEnvironment } from "./native-tools.js";
import { distributionRoot } from "./core.js";
import { inspectToolReferences, type ToolReferences } from "./tool-references.js";
import { matchesToolRequirement } from "./tool-requirements.js";
import { pruneItem, type CachePruneObserver } from "./cache-prune-progress.js";
import { ChecksCancelled } from "./check-cancellation.js";

const execute = promisify(execFile);

type ToolProtection = { kind: "result"; directory: string } | { kind: "blocker"; reason: string };
// Symbol metadata survives internal copies without changing the public JSON report.
const protectionDetails = Symbol("tool protections");

export interface ToolCacheEntry {
  id: string;
  provider: "workbench" | "rustup" | "uv";
  tool: string;
  version: string;
  platform: string;
  directory: string;
  identity: string;
  bytes: number;
  protected: string[];
  pinnedBy: string[];
  [protectionDetails]: ToolProtection[];
}
export interface ToolCacheReport {
  entries: ToolCacheEntry[];
  issues: string[];
  blockedBy?: string;
  references: ToolReferences;
}

function directories(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".lock") && !entry.name.endsWith(".partial"))
    .map((entry) => ownedPath(root, entry.name));
}

function manager(command: string, args: string[], env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")}: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.trim();
}

function managerEnvironment(root?: string, plans?: ReturnType<typeof nativeInstallationPlan>): NodeJS.ProcessEnv {
  if (!root) return process.env;
  const uv = (plans ?? nativeInstallationPlan(root, undefined, { toolchain: false })).find(
    (entry) => entry.tool === "uv",
  );
  return nativeEnvironment(resolve(root, uv?.root ?? "."), distributionRoot(root), { toolchain: false });
}

/** No downloads or manager initialization: inspect only installed toolsets. */
export function inspectToolCache(root?: string, heldInstallations: readonly string[] = []): ToolCacheReport {
  const entries: ToolCacheEntry[] = [],
    issues: string[] = [];
  const activity = inspectToolCacheActivity();
  const blockedBy = activity.blockedBy;
  const references = inspectToolReferences();
  issues.push(...references.issues);
  let selectedEnvironment: NodeJS.ProcessEnv = process.env;
  if (root) {
    try {
      const plans = nativeInstallationPlan(root, undefined, { toolchain: false });
      selectedEnvironment = managerEnvironment(root, plans);
    } catch (error) {
      issues.push(`Manager discovery could not use project settings: ${String(error)}`);
    }
  }
  const env = {
    ...selectedEnvironment,
    UV_OFFLINE: "1",
    UV_PYTHON_DOWNLOADS: "never",
    RUSTUP_AUTO_INSTALL: "0",
  };
  const add = (entry: Omit<ToolCacheEntry, "id" | "bytes" | "pinnedBy" | typeof protectionDetails>) => {
    const protections: ToolProtection[] = entry.protected.map((reason) => ({ kind: "blocker", reason }));
    const block = (reason: string) => {
      protections.push({ kind: "blocker", reason });
    };
    if (blockedBy) block(`Unresolved Workbench command or lock: ${blockedBy}`);
    if (references.issues.length) block("cache result references require attention");
    const pinnedBy = references.results
      .filter((result) => result.tools.some((requirement) => matchesToolRequirement(requirement, entry)))
      .map((result) => result.directory);
    protections.push(...pinnedBy.map((directory): ToolProtection => ({ kind: "result", directory })));
    for (const use of activity.uses)
      if (
        use.tools?.some((tool) => matchesToolRequirement(tool, entry)) ||
        use.executable.startsWith(`${entry.directory}${sep}`)
      )
        block(`active Workbench command: ${String(use.pid)}`);
    const comparable = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
    if (comparable(realpathSync(process.execPath)).startsWith(`${comparable(realpathSync(entry.directory))}${sep}`))
      block("running Workbench");
    entries.push({
      ...entry,
      ...withProtections(protections),
      pinnedBy,
      id: `${entry.provider}:${relative(
        entry.provider === "workbench" ? join(userDirectory("cache"), "toolchains") : dirname(entry.directory),
        entry.directory,
      )
        .split(sep)
        .join("/")}`,
      bytes: cacheBytes(entry.directory),
    });
  };
  for (const tool of directories(ownedPath(userDirectory("cache"), "toolchains")))
    for (const version of directories(tool))
      for (const target of directories(version))
        for (const directory of directories(target)) {
          const receipt = ownedPath(directory, ".workbench-artifact");
          if (!existsSync(receipt) || !lstatSync(receipt).isFile()) continue;
          if (lstatSync(receipt).size > 256) {
            issues.push(`${directory}: invalid installation receipt`);
            continue;
          }
          const identity = readFileSync(receipt, "utf8").trim();
          if (!/^[a-f0-9]{64}$/.test(identity) || !basename(directory).startsWith(identity.slice(0, 16))) {
            issues.push(`${directory}: installation receipt does not match its location`);
            continue;
          }
          add({
            provider: "workbench",
            tool: basename(tool),
            version: basename(version),
            platform: basename(target),
            directory,
            identity,
            protected:
              existsSync(`${directory}.lock`) && !heldInstallations.includes(directory)
                ? ["installation or cleanup lock"]
                : [],
          });
        }
  const rustHome = resolve(process.env.RUSTUP_HOME ?? join(homedir(), ".rustup"));
  if (existsSync(join(rustHome, "toolchains"))) {
    try {
      const output = manager("rustup", ["toolchain", "list", "--verbose"], env);
      if (output === undefined) throw new Error("Rust toolchains exist, but rustup is unavailable on PATH");
      for (const line of output.split(/\r?\n/)) {
        const match = /^(\S+)(?: \(([^)]*)\))?\s+(.+)$/.exec(line);
        if (!match) continue;
        const name = match[1] ?? "";
        const version = /^(stable|beta|nightly(?:-\d{4}-\d{2}-\d{2})?|\d+\.\d+\.\d+)(?:-[a-zA-Z0-9_.-]+)?$/.exec(
          name,
        )?.[1];
        if (!version) continue; // Custom linked toolchains belong to their owner.
        const directory = ownedPath(realpathSync(rustHome), `toolchains/${name}`);
        if (
          !existsSync(directory) ||
          realpathSync(match[3] ?? "") !== directory ||
          !existsSync(join(directory, "lib/rustlib/rust-installer-version"))
        )
          continue;
        const protection: string[] = [];
        add({
          provider: "rustup",
          tool: "rust",
          version,
          platform: name.slice(version.length + 1),
          directory,
          identity: name,
          protected: protection,
        });
      }
    } catch (error) {
      issues.push(String(error));
    }
  }
  if (!process.env.UV_PYTHON_INSTALL_DIR || existsSync(process.env.UV_PYTHON_INSTALL_DIR)) {
    try {
      const pythonHome = manager("uv", ["python", "dir"], env);
      if (pythonHome && existsSync(pythonHome)) {
        const home = realpathSync(pythonHome);
        const output = manager(
          "uv",
          ["python", "list", "--only-installed", "--managed-python", "--output-format", "json"],
          env,
        );
        const installs: unknown = JSON.parse(output ?? "[]");
        if (!Array.isArray(installs)) throw new Error("uv returned an invalid Python inventory");
        const seen = new Set<string>();
        for (const install of installs as { key?: unknown; path?: unknown; version?: unknown }[]) {
          if (typeof install.path !== "string" || typeof install.version !== "string" || !existsSync(install.path))
            continue;
          const name = relative(home, realpathSync(install.path)).split(sep)[0] ?? "";
          if (!/^(?:cpython|pypy)-\d+\.\d+\.\d+[a-zA-Z0-9_.+-]*-[a-zA-Z0-9_.-]+$/.test(name)) continue;
          const directory = ownedPath(home, name);
          if (seen.has(directory)) continue;
          seen.add(directory);
          add({
            provider: "uv",
            tool: "python",
            version: install.version,
            platform: name.replace(/^[^-]+-[^-]+-/, ""),
            directory,
            identity: name,
            protected: [],
          });
        }
      }
    } catch (error) {
      issues.push(String(error));
    }
  }
  return {
    entries: entries.sort(
      (a, b) =>
        a.tool.localeCompare(b.tool) ||
        a.version.localeCompare(b.version, undefined, { numeric: true }) ||
        a.id.localeCompare(b.id),
    ),
    issues,
    references,
    ...(blockedBy ? { blockedBy } : {}),
  };
}

function withProtections(protections: ToolProtection[]) {
  return {
    [protectionDetails]: protections,
    protected: protections.map((protection) =>
      protection.kind === "result" ? `retained result: ${protection.directory}` : protection.reason,
    ),
  };
}

/** A result selected in this cleanup releases its dependencies in the same operation. */
export function prunableTools(report: ToolCacheReport, results: string[] = []): ToolCacheEntry[] {
  const released = new Set(results);
  return report.entries
    .map((entry) => ({
      ...entry,
      ...withProtections(
        entry[protectionDetails].filter(
          (protection) => protection.kind !== "result" || !released.has(protection.directory),
        ),
      ),
    }))
    .filter((entry) => !entry[protectionDetails].length);
}

/** Reinspect the complete selection before any deletion; managers own removal of their installations. */
export function pruneToolCache(report: ToolCacheReport, root?: string, apply?: false): ToolCacheEntry[];
export function pruneToolCache(
  report: ToolCacheReport,
  root: string | undefined,
  apply: true,
  results?: { directories: string[]; remove: () => Promise<void> },
  progress?: CachePruneObserver,
): Promise<ToolCacheEntry[]>;
export function pruneToolCache(
  report: ToolCacheReport,
  root?: string,
  apply = false,
  results?: { directories: string[]; remove: () => Promise<void> },
  progress?: CachePruneObserver,
): ToolCacheEntry[] | Promise<ToolCacheEntry[]> {
  const entries = prunableTools(report);
  if (!apply) return entries;
  if (!entries.length) return Promise.resolve(entries);
  return Promise.resolve().then(() =>
    withToolCacheMaintenance(() =>
      withCacheLocksSync(
        entries.filter((entry) => entry.provider === "workbench").map((entry) => entry.directory),
        async () => {
          const held = entries.filter((entry) => entry.provider === "workbench").map((entry) => entry.directory);
          const current = inspectToolCache(root, held);
          const eligible = prunableTools(current, results?.directories);
          for (const entry of entries) {
            const now = eligible.find((candidate) => candidate.id === entry.id);
            if (
              now?.directory !== entry.directory ||
              now.identity !== entry.identity ||
              now.provider !== entry.provider ||
              now.tool !== entry.tool ||
              now.version !== entry.version ||
              now.protected.length
            )
              throw new Error(`${entry.id}: installation or protection changed; inspect again`);
          }
          await results?.remove();
          if (results) {
            const remaining = inspectToolCache(root, held);
            for (const entry of entries)
              if (!prunableTools(remaining).some((candidate) => candidate.id === entry.id))
                throw new Error(`${entry.id}: a retained result still pins this installation`);
          }
          const env = {
            ...(entries.some((entry) => entry.provider !== "workbench") ? managerEnvironment(root) : process.env),
            UV_OFFLINE: "1",
            UV_PYTHON_DOWNLOADS: "never",
          };
          let removed = 0;
          for (const entry of entries) {
            try {
              await pruneItem(
                `Tools / ${toolCacheGroup(entry.tool)} / ${entry.tool} ${entry.version}`,
                async () => {
                  if (entry.provider === "workbench") await rm(entry.directory, { recursive: true });
                  else {
                    await execute(
                      entry.provider === "uv" ? "uv" : "rustup",
                      entry.provider === "uv"
                        ? ["python", "uninstall", "--install-dir", dirname(entry.directory), entry.identity]
                        : ["toolchain", "uninstall", entry.identity],
                      { env, maxBuffer: 4 * 1024 * 1024 },
                    );
                    if (existsSync(entry.directory)) throw new Error("owning manager did not remove the installation");
                  }
                },
                progress,
              );
              removed++;
            } catch (error) {
              if (error instanceof ChecksCancelled) throw error;
              throw new Error(
                `${entry.id}: pruning failed after removing ${String(removed)} installations; inspect again`,
                { cause: error },
              );
            }
          }
          return entries;
        },
      ),
    ),
  );
}

/** Language ownership is presentation only; provider-specific installation identities stay intact. */
export function toolCacheGroup(tool: string): string {
  if (["llvm", "clang", "gcc", "llvm-runtime", "llvm-xml-runtime", "vcpkg"].includes(tool)) return "c-cpp";
  if (["rust", "miri", "rustup-init", "cargo-llvm-cov", "cargo-nextest"].includes(tool)) return "rust";
  if (["python", "uv"].includes(tool)) return "python";
  if (["node", "pnpm"].includes(tool)) return "node";
  if (tool === "maven") return "java";
  return ["ruby", "php", "go", "java"].includes(tool) ? tool : "build-tools";
}
