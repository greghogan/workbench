/** Shared by CLI schemas, native selection, dependency tooling and standalone CI adapters. */
export const compilerCatalog = {
  clang: {
    pin: ".llvm-version",
    executables: { c: "clang", cpp: "clang++" },
    platforms: ["linux-x64", "linux-arm64", "macos-arm64", "windows-x64"],
    compatibilityOS: "linux",
    managed: true,
    standards: { c: ["90", "99", "11", "17", "23"], cpp: ["98", "11", "14", "17", "20", "23", "26"] },
    lto: ["off", "thin", "full"],
  },
  gcc: {
    pin: ".gcc-version",
    executables: { c: "gcc", cpp: "g++" },
    platforms: ["linux-x64", "linux-arm64"],
    compatibilityOS: "linux",
    managed: true,
    standards: { c: ["90", "99", "11", "17", "23"], cpp: ["98", "11", "14", "17", "20", "23", "26"] },
    lto: ["off", "full"],
  },
  mvsc: {
    pin: ".mvsc-version",
    executables: { c: "cl", cpp: "cl" },
    platforms: ["windows-x64"],
    compatibilityOS: "windows",
    managed: false,
    standards: { c: ["11", "17"], cpp: ["14", "17", "20"] },
    lto: ["off", "full"],
  },
} as const;
export type CompilerFamily = keyof typeof compilerCatalog;
export const compilerFamilies = Object.keys(compilerCatalog) as CompilerFamily[];
export const managedCompilerFamilies = compilerFamilies.filter((family) => compilerCatalog[family].managed);
export const linuxCompilerFamilies = compilerFamilies.filter((family) =>
  compilerCatalog[family].platforms.some((platform) => platform.startsWith("linux-")),
);
export function isCompilerFamily(value: unknown): value is CompilerFamily {
  return typeof value === "string" && Object.hasOwn(compilerCatalog, value);
}

/** MSVC pins identify the toolset directory; CMake and cl report the compiler version. */
export function compilerBaseline(family: CompilerFamily, version: string): string {
  if (family !== "mvsc" || !version) return version;
  const [major, minor] = version.split(".");
  return `${String(Number(major) + 5)}.${minor ?? ""}`;
}
