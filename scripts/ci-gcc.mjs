import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ciImageContext, gccImage, verifyCIImage } from "./ci-image.mjs";

// Execute inside the compiler's distribution; never copy its binaries into another OS.
export function executeGCC(script, args = []) {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new Error("GCC image execution requires native Linux x64 or ARM64");
  const distribution = resolve(import.meta.dirname, "..");
  const target = JSON.parse(process.env.CACHE_TARGET ?? "{}");
  const version = process.env.COMPILER_VERSION ?? target.version;
  const base = gccImage(distribution, version);
  const context = mkdtempSync(join(tmpdir(), "workbench-gcc-image-"));
  try {
    const image = ciImageContext(distribution, context, base);
    execFileSync(
      "docker",
      [
        "build",
        "--platform",
        `linux/${process.arch === "x64" ? "amd64" : "arm64"}`,
        "--network=host",
        "--build-arg",
        `BASE_IMAGE=${base}`,
        "--tag",
        image,
        context,
      ],
      {
        stdio: "inherit",
      },
    );
    verifyCIImage(image);
    mkdirSync(join(process.env.RUNNER_TEMP, "gcc-home"), { recursive: true });
    const paths = [...new Set([process.cwd(), distribution, process.env.RUNNER_TEMP].filter(Boolean))];
    if (paths.some((path) => path.includes(","))) throw new Error("Docker mount paths cannot contain commas");
    const child = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network=host",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "--workdir",
        process.cwd(),
        ...paths.flatMap((path) => ["--mount", `type=bind,src=${path},dst=${path}`]),
        ...Object.entries(process.env)
          .filter(([key]) =>
            /^(?:WORKBENCH_|XDG_|CHECK_|CACHE_TARGET$|RUNNER_TEMP$|GITHUB_(?:ENV|OUTPUT|ACTIONS)$|COMPILER|ZSTD_CLEVEL$|CMAKE_BUILD_PARALLEL_LEVEL$|CTEST_PARALLEL_LEVEL$)/.test(
              key,
            ),
          )
          .flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        "--env",
        `HOME=${process.env.RUNNER_TEMP}/gcc-home`,
        "--env",
        `WORKBENCH_GCC_IMAGE_VERSION=${version}`,
        image,
        "node",
        script,
        ...args,
      ],
      { stdio: "inherit" },
    );
    if (child.error || child.status !== 0)
      throw new Error(`GCC image execution failed: ${child.error ?? child.status}`);
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}
