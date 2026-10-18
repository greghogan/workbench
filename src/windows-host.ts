import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { win32 } from "node:path";

interface GitProbe {
  probe: (executable: string, env: NodeJS.ProcessEnv) => { status: number | null; stdout: string };
  exists: (path: string) => boolean;
  canonical: (path: string) => string;
}
const gitProbe: GitProbe = {
  probe: (executable, env) => spawnSync(executable, ["--exec-path"], { env, encoding: "utf8", timeout: 10000 }),
  exists: existsSync,
  canonical: realpathSync,
};
/** Resolve wrapper and hook executables to the same installation, independently of caller overrides. */
export function windowsGitExecutable(actual: string, env: NodeJS.ProcessEnv, host: GitProbe = gitProbe): string {
  const source = { ...env };
  for (const key of Object.keys(source)) if (key.toUpperCase() === "GIT_EXEC_PATH") Reflect.deleteProperty(source, key);
  const result = host.probe(actual, source);
  const candidate =
    result.status === 0 && result.stdout.trim() ? win32.resolve(result.stdout.trim(), "../../bin/git.exe") : actual;
  return host.exists(candidate) ? host.canonical(candidate) : actual;
}

/** Git's launchers prepend their own runtime. Use that same runtime before and inside hooks. */
export function windowsGitDirectories(git: string, host: Pick<GitProbe, "exists" | "canonical"> = gitProbe): string[] {
  const bin = win32.dirname(git);
  if (win32.basename(win32.dirname(bin)).toLowerCase() === "usr") return [];
  const utilities = win32.resolve(bin, "../../usr/bin");
  return host.exists(win32.join(utilities, "bash.exe")) ? [bin, host.canonical(utilities)] : [];
}
export function normalizeWindowsPaths(
  env: NodeJS.ProcessEnv,
  canonical: (path: string) => string = realpathSync,
  exists: (path: string) => boolean = existsSync,
): void {
  for (const name of [
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "SystemRoot",
    "WINDIR",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]) {
    const path = env[name];
    if (path && win32.isAbsolute(path) && exists(path)) env[name] = canonical(path);
  }
}
