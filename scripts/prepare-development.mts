import { string } from "../app/src/core/runtime/values.mjs";
import { installImageTools, openImagePreparation } from "./prepare-image-tools.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Shared recipe: acquire declared inputs, then prove fresh offline builds and smoke execution.
const [builder, ...options] = process.argv.slice(2);
if (builder !== "native" && builder !== "nix" && builder !== "guix")
  throw new Error(
    "Use prepare-development.mjs native|nix|guix [--verify|--verify-tools|--tools-only|--dependencies-only|--acquire-only] [--path ROOT]... [--toolchain NAME] [--skip-ci-toolchains]",
  );
const selectedPaths: string[] = [];
let toolchain: string | undefined;
let skipCIToolchains = false;
const modes = ["verify", "verify-tools", "tools-only", "dependencies-only", "acquire-only"] as const;
let mode: "prepare" | (typeof modes)[number] = "prepare";
for (let index = 0; index < options.length; index++) {
  const option = options[index];
  const selected = modes.find((candidate) => option === `--${candidate}`);
  if (selected && mode === "prepare") mode = selected;
  else if (option === "--path" && options[index + 1] && !options[index + 1]?.startsWith("--"))
    selectedPaths.push(string(options[++index], "Missing preparation path"));
  else if (option === "--toolchain" && !toolchain && /^[a-z][a-z0-9_-]*$/.test(options[index + 1] ?? ""))
    toolchain = options[++index];
  else if (option === "--skip-ci-toolchains" && !skipCIToolchains) skipCIToolchains = true;
  else throw new Error(`Invalid preparation option: ${String(option)}`);
}
if (toolchain && builder !== "native") throw new Error("--toolchain selects a native preparation toolchain");
const toolchainArgs = toolchain ? ["--toolchain", toolchain] : [];
const verify = mode === "verify" || mode === "verify-tools";
if (!verify && builder !== "native")
  throw new Error(
    "Managed images are assembled by scripts/prepare-managed-development.mjs from their declared closures",
  );
const preparation = openImagePreparation(!verify);
const { cli, root, run, cancellation } = preparation;
try {
  await run(["project", "add", root]);
  const paths = await preparation.paths(selectedPaths);
  if (!verify && mode !== "dependencies-only" && mode !== "acquire-only" && builder === "native")
    await installImageTools(preparation, paths, toolchain, skipCIToolchains);
  if (mode === "verify-tools") {
    for (const path of paths)
      await run(["shell", "--path", path, "--environment", builder, ...toolchainArgs, "--", "node", "--version"]);
  } else if (mode !== "tools-only") {
    for (const path of paths) {
      console.log(`::group::${verify ? "Offline verification" : "Prepare"}: ${builder} ${path}`);
      const selection = ["--path", path, "--environment", builder, ...toolchainArgs];
      if (!verify) await run(["prepare", ...selection]);
      // One setup and build session retains the fresh outputs for smoke execution.
      if (mode !== "acquire-only" && mode !== "dependencies-only")
        await run(["check", ...selection, "--no-cache", "--role", "build", ...(verify ? ["--role", "smoke"] : [])]);
      console.log("::endgroup::");
    }

    if (builder === "native" && !verify && paths.some((path) => existsSync(join(root, path, "pnpm-lock.yaml")))) {
      const { retainPnpmMetadata } = await import("./pnpm-metadata.mjs");
      await retainPnpmMetadata(root, cli, paths, cancellation.signal);
    }
  }
} finally {
  cancellation.close();
}
