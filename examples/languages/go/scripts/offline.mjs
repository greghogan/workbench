// Generated from offline.mts; edit the TypeScript source.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const [mode, builder] = process.argv.slice(2);
if (!mode || !builder || !["prepare", "verify"].includes(mode) || !["native", "nix", "guix"].includes(builder))
  throw new Error("Use offline.mjs prepare|verify native|nix|guix");
const root = resolve(import.meta.dirname, "..");
const workbench = process.env.WORKBENCH_DISTRIBUTION_ROOT ?? resolve(root, "../../..");
const temporary = mkdtempSync(join(tmpdir(), "workbench-offline-go-"));
const env = {
  ...process.env,
  GOTOOLCHAIN: "local",
  CGO_ENABLED: "0",
  GOCACHE: join(temporary, "go-build"),
  GOPROXY: mode === "verify" ? "off" : (process.env.GOPROXY ?? "https://proxy.golang.org,direct"),
};
function run(command, args) {
  const child = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (child.error || child.status !== 0) throw new Error(`${command} failed: ${String(child.error ?? child.status)}`);
}
try {
  const command =
    mode === "prepare"
      ? ["go", "mod", "download"]
      : [
          "sh",
          "-eu",
          "-c",
          'go tool staticcheck ./...; go test ./...; go build -trimpath -o "$1/count" ./cmd/count; test "$("$1/count" a banana)" = 3',
          "offline-go",
          temporary,
        ];
  if (builder === "native") run("node", [join(workbench, "bin/workbench.mjs"), "native-exec", root, "--", ...command]);
  else if (builder === "nix")
    run("nix", [
      "--extra-experimental-features",
      "nix-command flakes",
      "--offline",
      "develop",
      "--no-update-lock-file",
      `path:${root}`,
      "--command",
      ...command,
    ]);
  else run("/opt/workbench-guix/bin/guix", ["shell", "-m", join(root, "manifest.scm"), "--", ...command]);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
