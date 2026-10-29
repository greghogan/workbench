import { nativeHostLanguages, nativeHostRequirements } from "./native-host-requirements.mjs";
import { strings } from "./values.mjs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
const roots = strings(JSON.parse(process.env.CHECK_ROOTS ?? "[]"), "Invalid check roots");
const requirements = nativeHostRequirements(nativeHostLanguages(roots, process.env.RUNTIME));
// Git Bash also supplies link.exe; Rust must select the declared MSVC linker explicitly.
if (requirements.msvcLinker) {
  const sdk = process.env.VCToolsInstallDir;
  const linker = sdk && join(sdk, "bin", "Hostx64", "x64", "link.exe");
  if (!linker || !existsSync(linker)) throw new Error("Windows Rust checks require the MSVC SDK environment");
  if (process.env.GITHUB_ENV) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_ENV, `CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=${linker}\n`);
  }
}
if (!requirements.packages.length) process.exit(0);
function run(cmd: string, args: readonly string[]) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error || r.status !== 0) throw r.error ?? new Error(`${cmd} failed: ${String(r.status)}`);
}
if (process.platform === "linux") {
  run("sudo", ["apt-get", "update"]);
  run("sudo", ["apt-get", "install", "--no-install-recommends", "-y", ...requirements.packages]);
} else if (process.platform === "darwin") {
  run("brew", ["install", ...requirements.packages]);
  const { appendFileSync } = await import("node:fs");
  if (process.env.GITHUB_ENV) {
    const paths = requirements.pkgConfigPackages.map((pkg) =>
      join(spawnSync("brew", ["--prefix", pkg], { encoding: "utf8" }).stdout.trim(), "lib/pkgconfig"),
    );
    appendFileSync(process.env.GITHUB_ENV, `PKG_CONFIG_PATH=${paths.join(":")}:${process.env.PKG_CONFIG_PATH ?? ""}\n`);
  }
} else if (process.platform === "win32") {
  const msys = "C:/msys64";
  run(join(msys, "usr/bin/bash.exe"), ["-lc", `pacman -S --needed --noconfirm ${requirements.packages.join(" ")}`]);
  if (process.env.GITHUB_PATH) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_PATH, `${msys}/ucrt64/bin\n${msys}/usr/bin\n`);
  }
}
