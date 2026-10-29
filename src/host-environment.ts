import { win32 } from "node:path";

export const platformEnvironmentNames = [
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  // Without this context, Git for Windows initializes MSYS again and prepends tool directories to PATH.
  "MSYSTEM",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TZ",
  "CI",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
  "GIT_SSL_CAINFO",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
];
export function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform = process.platform,
): string | undefined {
  if (platform !== "win32" && !name.startsWith("npm_config_")) return Object.hasOwn(env, name) ? env[name] : undefined;
  const key = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Platform installation locations, independent of the shell's PATH or profile precedence. */
export function platformHostDirectories(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32")
    return [
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/local/sbin",
      "/usr/sbin",
      "/sbin",
      ...(platform === "darwin"
        ? ["/opt/homebrew/bin", "/opt/local/bin"]
        : platform === "linux"
          ? ["/run/current-system/sw/bin", "/run/current-system/profile/bin"]
          : []),
    ];
  const field = (name: string) => environmentValue(env, name, platform);
  const system = field("SystemRoot") ?? "C:\\Windows";
  const programs = field("ProgramFiles") ?? "C:\\Program Files";
  const programs86 = field("ProgramFiles(x86)");
  const local = field("LOCALAPPDATA");
  return [
    win32.join(programs, "Git", "cmd"),
    ...(programs86 ? [win32.join(programs86, "Git", "cmd")] : []),
    ...(local ? [win32.join(local, "Programs", "Git", "cmd")] : []),
    win32.join(system, "System32"),
    system,
    win32.join(system, "System32", "WindowsPowerShell", "v1.0"),
    win32.join(programs, "PowerShell", "7"),
    "C:\\msys64\\ucrt64\\bin",
    "C:\\msys64\\usr\\bin",
    win32.join(programs, "Docker", "Docker", "resources", "bin"),
  ];
}
