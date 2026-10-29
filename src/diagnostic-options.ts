import { LogLevel, LogFormat, hasEnumValue } from "../scripts/diagnostic-contract.mjs";
import type { readUserConfig } from "./user-config.js";

/** Resolution is pure; bootstrap callers may omit preferences when configuration itself is broken. */
export function resolveDiagnosticOptions(
  cli: { logLevel?: string; logFormat?: string; logSave?: boolean },
  env: NodeJS.ProcessEnv,
  preferences: ReturnType<typeof readUserConfig> = {},
) {
  const level = cli.logLevel ?? env.WORKBENCH_LOG_LEVEL ?? preferences["diagnostics.level"] ?? LogLevel.Info;
  const format = cli.logFormat ?? env.WORKBENCH_LOG_FORMAT ?? preferences["diagnostics.format"] ?? LogFormat.Text;
  if (!hasEnumValue(LogLevel, level)) throw new Error("diagnostic level must be debug, info, warn, or error");
  if (!hasEnumValue(LogFormat, format)) throw new Error("diagnostic format must be text or json");
  const persist =
    cli.logSave === true ||
    env.WORKBENCH_LOG_PERSIST === "1" ||
    (env.WORKBENCH_LOG_PERSIST !== "0" && preferences["diagnostics.persist"] === true);
  return { level, format, persist };
}
