import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readLanguageRoots, readText, type LanguageRoot } from "./core.js";
import { required } from "./invariants.js";
import { selectedToolProfile } from "./tool-profiles.js";

export type CompilerFamily = "clang" | "gcc";
export interface CompilerSelection {
  compiler?: string;
  compilerVersion?: string;
  toolchain?: string | false;
}
const compareVersions = (left: string, right: string): number => left.localeCompare(right, "en", { numeric: true });

function exact(value: unknown, source: string): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value))
    throw new Error(`${source}: expected an exact major.minor.patch compiler version`);
  return value;
}

/** Registry policy is shared by compiler selection, CI, dependencies, and build identities. */
export function compilerPolicy(directory: string): (LanguageRoot & { standards: Record<string, string> }) | undefined {
  directory = realpathSync(directory);
  let root = directory;
  while (!existsSync(join(root, "workbench/projects.toml"))) {
    const parent = dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
  const entries = readLanguageRoots(root).filter((entry) => resolve(root, entry.path) === directory);
  const native = entries.filter((entry) => entry.language === "c" || entry.language === "cpp");
  for (const entry of entries)
    if (
      !native.includes(entry) &&
      (entry.compiler !== undefined ||
        entry.compilers !== undefined ||
        entry.standard !== undefined ||
        entry.lto !== undefined)
    )
      throw new Error(`${entry.path}: compiler and standard options require a C/C++ root`);
  if (!native.length) return undefined;
  const primary = native[0];
  if (
    !primary ||
    native.every(
      (entry) =>
        entry.compiler === undefined &&
        entry.compilers === undefined &&
        entry.standard === undefined &&
        entry.lto === undefined,
    )
  )
    return undefined;
  const shared = (entry: LanguageRoot) =>
    JSON.stringify({
      compiler: entry.compiler,
      lto: entry.lto ?? "off",
      compilers: Object.entries(entry.compilers ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([family, support]) => [
          family,
          support.minimum,
          [...support.ci_versions].sort(),
          [...(support.ci_architectures ?? ["x64"])].sort(),
        ]),
    });
  for (const policy of native) {
    if (!policy.compiler || !policy.compilers?.[policy.compiler])
      throw new Error(`${policy.path}: compiler must select a declared compiler family`);
    const standards =
      policy.language === "c" ? ["90", "99", "11", "17", "23"] : ["98", "11", "14", "17", "20", "23", "26"];
    if (!policy.standard || !standards.includes(policy.standard))
      throw new Error(`${policy.path}: standard must select ${standards.join(", ")}`);
    for (const [family, support] of Object.entries(policy.compilers)) {
      const minimum = exact(support.minimum, `${policy.path}: ${family}.minimum`);
      if (
        !Array.isArray(support.ci_versions) ||
        !support.ci_versions.length ||
        new Set(support.ci_versions).size !== support.ci_versions.length
      )
        throw new Error(`${policy.path}: ${family}.ci_versions needs a nonempty list without duplicates`);
      for (const version of support.ci_versions)
        if (compareVersions(exact(version, `${policy.path}: ${family}.ci_versions`), minimum) < 0)
          throw new Error(`${policy.path}: ${family} CI version ${version} is below ${minimum}`);
    }
    if (shared(policy) !== shared(primary))
      throw new Error(`${directory}: languages sharing a root must agree on compiler policy`);
  }
  const policy = primary;
  if (!existsSync(join(directory, ".llvm-version"))) throw new Error(`${policy.path}: C/C++ requires .llvm-version`);
  return {
    ...policy,
    standards: Object.fromEntries(
      native.map((entry) => [entry.language, required(entry.standard, "expected validated language standard")]),
    ),
  };
}

export function selectedCompiler(directory: string, selection: CompilerSelection = {}) {
  const profile = selectedToolProfile(directory, selection.toolchain);
  const policy = compilerPolicy(directory);
  if (!policy) {
    if (selection.compiler !== undefined || selection.compilerVersion !== undefined || profile?.compiler !== undefined)
      throw new Error(`${directory}: compiler selection requires a configured C/C++ root`);
    return undefined;
  }
  if (selection.compilerVersion !== undefined && selection.compiler === undefined)
    throw new Error("--compiler-version requires --compiler");
  const family = selection.compiler ?? profile?.compiler ?? policy.compiler;
  if ((family !== "clang" && family !== "gcc") || !policy.compilers?.[family])
    throw new Error(`${policy.path}: compiler must select a supported family`);
  const support = policy.compilers[family];
  const file = family === "clang" ? ".llvm-version" : ".gcc-version";
  const version = exact(
    selection.compilerVersion ?? profile?.tools?.[family] ?? readText(join(directory, file)).trim(),
    file,
  );
  if (compareVersions(version, support.minimum) < 0)
    throw new Error(`${policy.path}: ${family} ${version} is below ${support.minimum}`);
  return {
    family,
    version,
    standard: required(policy.standard, "expected validated language standard"),
    standards: policy.standards,
    minimum: support.minimum,
    ...(policy.lto === undefined ? {} : { lto: policy.lto }),
  };
}

export function compilerEnvironment(directory: string, selection: CompilerSelection = {}): Record<string, string> {
  const compiler = selectedCompiler(directory, selection);
  return compiler
    ? {
        WORKBENCH_COMPILER: compiler.family,
        WORKBENCH_COMPILER_VERSION: compiler.version,
        WORKBENCH_LANGUAGE_STANDARD: compiler.standard,
        ...Object.fromEntries(
          Object.entries(compiler.standards).map(([language, standard]) => [
            language === "c" ? "WORKBENCH_C_STANDARD" : "WORKBENCH_CXX_STANDARD",
            standard,
          ]),
        ),
        WORKBENCH_COMPILER_MINIMUM: compiler.minimum,
        WORKBENCH_LTO: compiler.lto ?? "off",
      }
    : {};
}
