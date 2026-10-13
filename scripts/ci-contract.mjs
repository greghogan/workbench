export const compilerCompatibilityRoles = ["test", "sanitizers", "lto"];

/** These phases are also the installation/cache boundaries used by hosted CI. */
export function targetPhases(target) {
  if (target.kind === "native") return ["native-install", "native-check", ...(target.release ? ["release"] : [])];
  if (target.kind === "environment") return ["environment"];
  if (target.kind !== "compatibility") throw new Error(`Unknown CI target kind: ${target.kind}`);
  if (["clang", "gcc"].includes(target.runtime)) return ["compiler-install", "compiler"];
  if (target.runtime === "python") return ["python"];
  if (["node", "go", "rust", "java", "ruby", "php"].includes(target.runtime)) return ["compatibility"];
  throw new Error(`Unknown compatibility runtime: ${target.runtime}`);
}

export function targetEnvironment(target) {
  return {
    WORKBENCH_CI_TARGET: target.id,
    CHECK_ROOTS: JSON.stringify([target.path]),
    ...(target.kind === "native" && target.toolchain ? { CHECK_TOOLCHAIN: target.toolchain } : {}),
    ...(target.kind === "environment" ? { CHECK_ENVIRONMENT: target.environment } : {}),
    ...(target.kind === "compatibility"
      ? {
          RUNTIME: target.runtime,
          RUNTIME_VERSION: target.version,
          COMPILER: target.runtime,
          COMPILER_VERSION: target.version,
          CHECK_ROLES: JSON.stringify(target.roles),
          PYTHON_VERSION: target.version,
        }
      : {}),
  };
}
