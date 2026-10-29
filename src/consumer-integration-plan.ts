import { compilerCatalog, isCompilerFamily, type CompilerFamily } from "../scripts/compiler-catalog.mjs";
export interface ConsumerProfile {
  id: string;
  languages: string[];
  compiler?: CompilerFamily;
}

/** Profiles are independent evidence; cancellation alone prevents starting the remaining profiles. */
export async function executeConsumerProfiles(
  profiles: ConsumerProfile[],
  signal: AbortSignal,
  run: (profile: ConsumerProfile, index: number) => Promise<void>,
  rejected: (error: unknown, index: number) => void,
): Promise<void> {
  for (const [index, profile] of profiles.entries()) {
    signal.throwIfAborted();
    try {
      await run(profile, index);
    } catch (error) {
      rejected(error, index);
      signal.throwIfAborted();
    }
  }
}
export function planConsumerProfiles(
  languages: string[],
  compilers?: CompilerFamily[],
  platform: NodeJS.Platform = process.platform,
  architecture = process.arch,
): ConsumerProfile[] {
  if (!languages.length || new Set(languages).size !== languages.length)
    throw new Error("Select unique integration languages");
  if (compilers) {
    if (
      !compilers.length ||
      new Set(compilers).size !== compilers.length ||
      !languages.every((language) => language === "c" || language === "cpp")
    )
      throw new Error("Compiler integration requires unique compilers and an explicit C/C++ language selection");
    const host = `${platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform}-${architecture}`;
    return compilers.map((compiler) => {
      if (!isCompilerFamily(compiler)) throw new Error("Unsupported integration compiler");
      if (!(compilerCatalog[compiler].platforms as readonly string[]).includes(host))
        throw new Error(`${compiler} integration is unavailable on ${host}`);
      return { id: compiler, languages, compiler };
    });
  }
  const native = languages.filter((language) => language === "c" || language === "cpp");
  return [
    { id: "pins", languages },
    ...(platform === "win32" && architecture === "x64" && native.length
      ? [{ id: "mvsc", languages: native, compiler: "mvsc" as const }]
      : []),
  ];
}
