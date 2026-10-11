export type CompilerRuntime = "clang" | "gcc";
export type StandaloneRuntime = "node" | "go" | "rust" | "python" | "java" | "ruby" | "php";
export type CompatibilityRuntime = CompilerRuntime | StandaloneRuntime;
export type CIPhase =
  | "native-install"
  | "native-check"
  | "release"
  | "compiler-install"
  | "compiler"
  | "python"
  | "compatibility"
  | "environment";
interface NoRuntime {
  runtime?: never;
  version?: never;
  roles?: never;
}
export type TargetSelection =
  | ({ kind: "native"; release: boolean } & NoRuntime)
  | ({ kind: "environment"; release: false } & NoRuntime)
  | { kind: "compatibility"; runtime: CompilerRuntime; version: string; roles: string[]; release: false }
  | { kind: "compatibility"; runtime: StandaloneRuntime; version: string; roles: string[]; release: false };
export const compilerCompatibilityRoles: string[];
export function targetPhases(target: TargetSelection): CIPhase[];
export function targetEnvironment(
  target: TargetSelection & { id: string; path: string; environment: string },
): Record<string, string>;
