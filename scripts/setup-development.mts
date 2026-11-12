import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdtempSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { parseAllDocuments } from "../app/src/core/configuration/runtime-parsers.mjs";
import { runOwnedChild, processCancellation } from "../app/src/core/runtime/owned-child.mjs";
import { processFailure } from "../app/src/core/runtime/process-outcome.mjs";
import { isMainScript } from "./script-entry.mjs";
import { record, string } from "../app/src/core/runtime/values.mjs";

function pnpmDocument(path: string): Record<string, unknown> {
  const documents = parseAllDocuments(readFileSync(path, "utf8"));
  for (const document of documents) {
    const [error] = document.errors;
    if (error) throw error;
  }
  return record(documents.at(-1)?.toJSON(), `${path}: invalid pnpm metadata`);
}

/** A prepared tree must match the project lock, not just contain the build tool. */
export function preparedDependenciesMatch(root: string): boolean {
  const metadata = join(root, "node_modules/.modules.yaml");
  if (!existsSync(metadata) || !existsSync(join(root, "node_modules/esbuild"))) return false;
  const manifest = record(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "Invalid package metadata");
  const modules = pnpmDocument(metadata);
  if (modules.packageManager !== manifest.packageManager || typeof modules.virtualStoreDir !== "string") return false;
  const installed = join(resolve(root, "node_modules", modules.virtualStoreDir), "lock.yaml");
  if (!existsSync(installed)) return false;
  const expected = pnpmDocument(join(root, "pnpm-lock.yaml"));
  if (!isDeepStrictEqual(expected, pnpmDocument(installed))) return false;
  const hook = join(root, ".pnpmfile.cjs");
  const checksum = existsSync(hook)
    ? `sha256-${createHash("sha256").update(readFileSync(hook)).digest("base64")}`
    : undefined;
  if (expected.pnpmfileChecksum !== checksum) return false;
  const importer = record(record(expected.importers, "Missing pnpm importers")["."], "Missing project importer");
  for (const kind of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const declared = record(manifest[kind] ?? {}, "Invalid declared dependencies");
    const selected = record(importer[kind] ?? {}, "Invalid installed dependencies");
    if (!isDeepStrictEqual(Object.keys(declared).sort(), Object.keys(selected).sort())) return false;
    for (const [name, specifier] of Object.entries(declared))
      if (record(selected[name], "Invalid installed dependency").specifier !== specifier) return false;
  }
  return true;
}

/** Source installation builds disposable bundles before invoking the Workbench CLI. */
export async function setupDevelopment(root: string, args = process.argv.slice(2)): Promise<void> {
  if (process.env.WORKBENCH_SOURCE_SETUP === "1") return;
  const { values } = parseArgs({
    args,
    strict: true,
    options: { dependencies: { type: "string" }, "build-only": { type: "boolean" } },
  });
  const lifecycle = process.env.npm_lifecycle_event === "prepare";
  const pin = readFileSync(join(root, ".node-version"), "utf8").trim();
  if (!process.features.typescript)
    throw new Error(`Source setup requires native TypeScript support; use the development Node.js ${pin}`);
  const { minimumCliNode } = await import("../app/src/core/distribution/node-runtimes.mts");
  const running = process.versions.node.split(".").map(Number),
    minimum = minimumCliNode.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if ((running[index] ?? 0) > (minimum[index] ?? 0)) break;
    if ((running[index] ?? 0) < (minimum[index] ?? 0))
      throw new Error(`Source setup requires Node.js ${minimumCliNode} or newer; use development Node.js ${pin}`);
  }
  if (values["build-only"] || lifecycle) {
    const { reuseBundles } = await import("./bundle-cache.mts");
    if (reuseBundles(root)) return;
    if (values.dependencies && reuseBundles(resolve(values.dependencies), root)) return;
  }
  const provider = values.dependencies ? resolve(values.dependencies) : undefined;
  const cancellation = processCancellation();
  const { npmCommand, npmRuntimeEnvironment } = await import("../app/src/core/toolchains/npm-command.ts");
  const environment: NodeJS.ProcessEnv = {
    ...npmRuntimeEnvironment(),
    WORKBENCH_SOURCE_SETUP: "1",
    COREPACK_ENABLE_NETWORK: "0",
    WORKBENCH_PROJECT_ROOT: root,
    WORKBENCH_DISTRIBUTION_ROOT: root,
    WORKBENCH_EPHEMERAL_CHECKOUT: "1",
    WORKBENCH_LOCAL_CONFIG_ROOT: process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? root,
  };
  for (const key of ["WORKBENCH_EXECUTING_SPEC", "WORKBENCH_LAUNCH_CHAIN"]) Reflect.deleteProperty(environment, key);
  const run = async (command: string, parameters: string[], cwd = root, env = environment) => {
    const result = await runOwnedChild(command, parameters, { cwd, env, signal: cancellation.signal });
    const failure = processFailure("development setup", result);
    if (failure) throw failure;
  };
  let temporary: string | undefined;
  let initialLocalStore = false;
  try {
    if (provider && !existsSync(join(root, "node_modules"))) {
      const metadata = (directory: string) =>
        record(
          JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
          `${directory}: invalid package metadata`,
        );
      const from = metadata(provider),
        to = metadata(root);
      if (
        !readFileSync(join(provider, "pnpm-lock.yaml")).equals(readFileSync(join(root, "pnpm-lock.yaml"))) ||
        ![
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
          "overrides",
          "resolutions",
          "pnpm",
          "packageManager",
        ].every((key) => isDeepStrictEqual(from[key], to[key])) ||
        !readFileSync(join(provider, "pnpm-workspace.yaml")).equals(readFileSync(join(root, "pnpm-workspace.yaml")))
      )
        throw new Error(
          "The staged dependency pins differ from the prepared checkout; prepare their locked dependencies before checking this snapshot",
        );
      if (!preparedDependenciesMatch(provider))
        throw new Error("The dependency provider does not match its source pins; run source setup in that checkout");
      const { linkDependencies } = await import("./link-dependencies.mts");
      linkDependencies(join(provider, "node_modules"), join(root, "node_modules"));
    }
    if (!lifecycle && !values["build-only"] && existsSync(join(root, "bundle/main.cjs"))) {
      await run(process.execPath, [
        join(root, "bin/workbench.mjs"),
        "package-manager-exec",
        "--",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
      ]);
    } else if (!preparedDependenciesMatch(root)) {
      if (process.env.WORKBENCH_OFFLINE === "1")
        throw new Error(
          "Source dependencies are not prepared; run source setup online or supply matching prepared dependencies",
        );
      const npm = npmCommand();
      const manager = join(root, "scripts/package-manager");
      const manifest = record(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "Invalid package metadata");
      const lock = record(
        JSON.parse(readFileSync(join(manager, "package-lock.json"), "utf8")),
        "Invalid package-manager lock",
      );
      const packages = record(lock.packages, "Missing bootstrap packages");
      const selected = record(packages["node_modules/pnpm"], "Missing locked package manager");
      if (
        lock.lockfileVersion !== 3 ||
        `pnpm@${string(selected.version, "Missing package-manager version")}` !== manifest.packageManager
      )
        throw new Error("The package-manager bootstrap lock must match package.json");
      for (const [path, value] of Object.entries(packages)) {
        if (!path) continue;
        const entry = record(value, `Invalid bootstrap package ${path}`);
        if (
          typeof entry.resolved !== "string" ||
          !entry.resolved.startsWith("https://") ||
          typeof entry.integrity !== "string" ||
          !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)
        )
          throw new Error("Bootstrap packages require HTTPS and strong integrity hashes");
      }
      await run(npm.command, [
        ...npm.prefix,
        "ci",
        "--prefix",
        manager,
        "--ignore-scripts",
        "--include=optional",
        "--no-audit",
        "--no-fund",
      ]);
      await run(npm.command, [...npm.prefix, "audit", "signatures", "--prefix", manager]);
      temporary = mkdtempSync(join(tmpdir(), "workbench-source-setup-"));
      const replace = existsSync(join(root, "node_modules"));
      if (replace && lstatSync(join(root, "node_modules")).isSymbolicLink())
        throw new Error(
          "Preserving a node_modules link without pnpm metadata; prepare matching dependencies before source setup",
        );
      initialLocalStore = !existsSync(join(root, "node_modules/.pnpm"));
      await run(process.execPath, [
        join(manager, "node_modules/pnpm/bin/pnpm.mjs"),
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        ...(replace ? ["--force"] : []),
        "--store-dir",
        process.env.PNPM_CONFIG_STORE_DIR ?? join(temporary, "store"),
        "--virtual-store-dir",
        join(root, "node_modules/.pnpm"),
      ]);
    }
    if (!preparedDependenciesMatch(root))
      throw new Error("Prepared source dependencies do not match the declared pins");
    await run(process.execPath, [join(root, "scripts/build-tooling.mts"), "--maintainers-only"]);
    const { reuseBundles } = await import("./bundle-cache.mts");
    if (!reuseBundles(root)) {
      const { compileBundles, publishBundles } = await import("./bundle-build.mjs");
      const { collectToolingArtifacts } = await import("./build-tooling.mts");
      const { verifyRuntimeDependencies } = await import("./runtime-dependencies.mjs");
      cancellation.signal.throwIfAborted();
      console.error("Building local Workbench bundles…");
      const bundles = await compileBundles(root, cancellation.signal);
      verifyRuntimeDependencies({ root, artifacts: collectToolingArtifacts(root), ...bundles });
      publishBundles(root, bundles);
    }
    if (temporary && !values["build-only"] && !lifecycle) {
      await run(process.execPath, [
        join(root, "bin/workbench.mjs"),
        "package-manager-exec",
        "--",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
      ]);
      const { parse } = await import("yaml");
      const modules = parse(readFileSync(join(root, "node_modules/.modules.yaml"), "utf8")) as {
        virtualStoreDir?: string;
      };
      const local = join(root, "node_modules/.pnpm");
      if (
        initialLocalStore &&
        modules.virtualStoreDir &&
        resolve(root, "node_modules", modules.virtualStoreDir) !== local &&
        existsSync(local) &&
        !lstatSync(local).isSymbolicLink()
      )
        rmSync(local, { recursive: true });
    }
  } finally {
    cancellation.close();
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

if (isMainScript(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await setupDevelopment(root).catch((error: unknown) => {
    console.error(`workbench: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
