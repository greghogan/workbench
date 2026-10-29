import { nativeHostLanguages, nativeHostRequirements } from "./native-host-requirements.mjs";
import { strings } from "./values.mjs";
import { acquireCommand } from "./network-command.mts";
import { runCIEntry } from "./ci-errors.mts";
import { captureOwnedChild, processCancellation } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { mapWork } from "./work-admission.mts";
import { existsSync } from "node:fs";
import { join } from "node:path";
await runCIEntry("Host SDK prerequisites", async () => {
  const cancellation = processCancellation();
  try {
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
    if (!requirements.packages.length) return;
    async function run(cmd: string, args: string[]) {
      await acquireCommand("Acquire host SDK prerequisite packages", cmd, args, { signal: cancellation.signal });
    }
    if (process.platform === "linux") {
      await run("sudo", ["apt-get", "update"]);
      await run("sudo", ["apt-get", "install", "--no-install-recommends", "-y", ...requirements.packages]);
    } else if (process.platform === "darwin") {
      await run("brew", ["install", ...requirements.packages]);
      const { appendFileSync } = await import("node:fs");
      if (process.env.GITHUB_ENV) {
        const paths = await mapWork(
          requirements.pkgConfigPackages,
          { capacity: 4, signal: cancellation.signal },
          async (pkg) => {
            const query = await captureOwnedChild(
              "brew",
              ["--prefix", pkg],
              { cwd: process.cwd(), env: process.env, signal: cancellation.signal },
              65536,
            );
            const failure = processFailure(`Locate the installed ${pkg} SDK`, query, query);
            if (failure) throw failure;
            if (!query.stdout.trim()) throw new Error(`Cannot locate the installed ${pkg} SDK`);
            return join(query.stdout.trim(), "lib/pkgconfig");
          },
        );
        appendFileSync(
          process.env.GITHUB_ENV,
          `PKG_CONFIG_PATH=${paths.join(":")}:${process.env.PKG_CONFIG_PATH ?? ""}\n`,
        );
      }
    } else if (process.platform === "win32") {
      const msys = "C:/msys64";
      await run(join(msys, "usr/bin/bash.exe"), [
        "-lc",
        `pacman -S --needed --noconfirm ${requirements.packages.join(" ")}`,
      ]);
      if (process.env.GITHUB_PATH) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(process.env.GITHUB_PATH, `${msys}/ucrt64/bin\n${msys}/usr/bin\n`);
      }
    }
  } finally {
    cancellation.close();
  }
});
