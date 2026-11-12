import { LogLevel, LogFormat, hasEnumValue } from "./diagnostic-contract.mjs";
import type { readUserConfig } from "../configuration/user-config.js";

/** Resolution is pure; bootstrap callers may omit preferences when configuration itself is broken. */
export function resolveDiagnosticOptions(
  cli: { logLevel?: string; logFileLevel?: string; logFormat?: string },
  env: NodeJS.ProcessEnv,
  preferences: ReturnType<typeof readUserConfig> = {},
  scope: "cli" | "server" = "cli",
) {
  const level =
    cli.logLevel ??
    env.WORKBENCH_LOG_LEVEL ??
    (scope === "server" ? preferences["diagnostics.server_level"] : undefined) ??
    preferences["diagnostics.level"] ??
    LogLevel.Info;
  const fileLevel =
    cli.logFileLevel ??
    env.WORKBENCH_LOG_FILE_LEVEL ??
    (scope === "server" ? preferences["diagnostics.server_file_level"] : undefined) ??
    preferences["diagnostics.file_level"] ??
    LogLevel.Info;
  const format = cli.logFormat ?? env.WORKBENCH_LOG_FORMAT ?? preferences["diagnostics.format"] ?? LogFormat.Text;
  if (!hasEnumValue(LogLevel, level)) throw new Error("diagnostic level must be debug, info, warn, or error");
  if (!hasEnumValue(LogLevel, fileLevel)) throw new Error("diagnostic file level must be debug, info, warn, or error");
  if (!hasEnumValue(LogFormat, format)) throw new Error("diagnostic format must be text or json");
  const persist = scope === "server" || preferences["logs.cli_max_bytes"] !== 0;
  return { level, fileLevel, format, persist };
}
