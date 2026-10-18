import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { execute } from "./tool-downloads.js";
import { required } from "./invariants.js";
import { buildPaths, prepareBuild } from "./builds.js";
import { readConfig } from "./core.js";

/** Used before pnpm writes packages; managed sessions retain their already selected paths. */
export function pnpmStorageConfiguration(root: string, directory: string): Record<string, string> {
  readConfig(root);
  const selected = process.env.WORKBENCH_STORAGE_EXTERNAL;
  if (selected !== undefined && selected !== "true" && selected !== "false")
    throw new Error("invalid inherited Workbench storage selection");
  const inherited =
    selected === "true" &&
    (process.env.PNPM_CONFIG_STORE_DIR !== undefined || process.env.PNPM_CONFIG_VIRTUAL_STORE_DIR !== undefined);
  let storeDir: string;
  let virtualStoreDir: string;
  if (inherited) {
    // A check may target a staged checkout or sibling root while retaining its caller's shell context.
    const storageProject = process.env.WORKBENCH_STORAGE_PROJECT ?? process.env.WORKBENCH_SHELL_ROOT;
    if (storageProject !== undefined && realpathSync(storageProject) !== realpathSync(directory))
      throw new Error("inherited pnpm storage belongs to another language root; reopen the matching Workbench shell");
    storeDir = required(process.env.PNPM_CONFIG_STORE_DIR, "inherited pnpm storage needs a package store");
    virtualStoreDir = required(
      process.env.PNPM_CONFIG_VIRTUAL_STORE_DIR,
      "inherited pnpm storage needs a virtual store",
    );
  } else {
    // A direct pnpm invocation runs on this host, even when its next Workbench check selects a managed environment.
    const paths = buildPaths(root, directory, "native", {}, false);
    if (!paths.external) return {};
    prepareBuild(paths);
    storeDir = paths.pnpmStore;
    virtualStoreDir = join(paths.dependencies, "pnpm");
  }
  for (const path of [storeDir, virtualStoreDir]) {
    if (!isAbsolute(path)) throw new Error("external pnpm storage requires absolute paths");
    const within = relative(root, path);
    if (!within || (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`)))
      throw new Error("external pnpm storage must be outside the project checkout");
  }
  return { storeDir, virtualStoreDir, virtualStoreType: "project" };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Only links to Workbench-owned installations may be replaced automatically. */
function ownedEnvironment(path: string): boolean {
  const receipt = join(dirname(path), ".workbench-dependencies.json");
  return existsSync(receipt) && lstatSync(receipt).isFile() && !lstatSync(receipt).isSymbolicLink();
}

export function dependencySetup(command: string[]): void {
  const environment = { ...process.env, PNPM_CONFIG_CONFIRM_MODULES_PURGE: "false" };
  const external = process.env.WORKBENCH_STORAGE_EXTERNAL === "true";
  const python = existsSync("pyproject.toml");
  const node = existsSync("package.json");
  if (external && node) {
    if (!process.env.PNPM_CONFIG_STORE_DIR || !process.env.PNPM_CONFIG_VIRTUAL_STORE_DIR)
      throw new Error("external Node setup requires PNPM_CONFIG_STORE_DIR and PNPM_CONFIG_VIRTUAL_STORE_DIR");
    const metadata = JSON.parse(readFileSync("package.json", "utf8")) as { packageManager?: string };
    const settings = existsSync("pnpm-workspace.yaml")
      ? ((parse(readFileSync("pnpm-workspace.yaml", "utf8")) as { nodeLinker?: string } | null) ?? {})
      : {};
    if (
      !metadata.packageManager?.startsWith("pnpm@") ||
      (settings.nodeLinker !== undefined && settings.nodeLinker !== "isolated")
    )
      throw new Error("external Node dependency storage requires pinned pnpm with its isolated linker");
  }
  const local = resolve(".venv");
  const target = external && python ? process.env.UV_PROJECT_ENVIRONMENT : undefined;
  if (external && python && !target) throw new Error("external Python setup requires UV_PROJECT_ENVIRONMENT");
  const link = python && isLink(local) ? readlinkSync(local) : undefined;
  const owned = link !== undefined && ownedEnvironment(resolve(dirname(local), link));
  const oldLink = owned ? link : undefined;
  if (external && link !== undefined && !owned)
    throw new Error(`${local}: refusing to replace a virtual environment linked outside Workbench storage`);
  if (target && !ownedEnvironment(target)) throw new Error(`${target}: missing dependency ownership receipt`);
  const metadata = resolve("node_modules/.modules.yaml");
  const virtualStore = () => {
    if (!existsSync(metadata)) return undefined;
    const document = parse(readFileSync(metadata, "utf8")) as { virtualStoreDir?: unknown };
    return typeof document.virtualStoreDir === "string" ? resolve("node_modules", document.virtualStoreDir) : undefined;
  };
  const previousStore = external ? virtualStore() : undefined;
  // uv environments embed absolute paths: create at their final location, never move a live environment.
  if (python && !external && oldLink !== undefined) rmSync(local);
  try {
    execute(required(command[0], "dependency setup needs a command"), command.slice(1), { env: environment });
  } catch (error) {
    if (python && !external && oldLink !== undefined) {
      // The failed setup owns this newly created installation, not the former linked environment.
      rmSync(local, { recursive: true, force: true });
      symlinkSync(oldLink, local, "junction");
    }
    throw error;
  }
  if (external && node && virtualStore() !== process.env.PNPM_CONFIG_VIRTUAL_STORE_DIR)
    throw new Error("pnpm did not use the selected external virtual store; inspect project package-manager settings");
  if (external && node) {
    const document = parse(readFileSync(metadata, "utf8")) as { storeDir?: unknown };
    const expected = resolve(required(process.env.PNPM_CONFIG_STORE_DIR, "external Node setup needs a package store"));
    const within = typeof document.storeDir === "string" ? relative(expected, resolve(document.storeDir)) : undefined;
    if (within === undefined || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
      throw new Error("pnpm did not use the selected external package store; inspect project package-manager settings");
  }
  if (
    external &&
    previousStore === resolve("node_modules/.pnpm") &&
    virtualStore() === process.env.PNPM_CONFIG_VIRTUAL_STORE_DIR
  ) {
    if (lstatSync("node_modules").isSymbolicLink())
      throw new Error("refusing to clean a linked node_modules directory");
    rmSync(previousStore, { recursive: true, force: true });
  }
  if (!target) return;
  if (!existsSync(join(target, "pyvenv.cfg")))
    throw new Error("Python setup did not create the selected uv environment");
  if (oldLink !== undefined && resolve(dirname(local), oldLink) === resolve(target)) return;
  if (existsSync(local) && oldLink === undefined && !existsSync(join(local, "pyvenv.cfg")))
    throw new Error(`${local}: expected a Python virtual environment; refusing to replace unrelated files`);
  const backup = resolve(".venv.workbench-backup");
  if (existsSync(backup) || isLink(backup)) throw new Error(`${backup}: finish recovery before replacing .venv`);
  const existed = existsSync(local) || isLink(local);
  if (existed) renameSync(local, backup);
  try {
    symlinkSync(target, local, "junction");
  } catch (error) {
    if (existed) renameSync(backup, local);
    throw error;
  }
  if (existed) rmSync(backup, { recursive: true });
}
