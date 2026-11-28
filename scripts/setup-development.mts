import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  lstatSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { parseAllDocuments } from "../app/src/core/configuration/runtime-parsers.mjs";
import { runOwnedChild, processCancellation } from "../app/src/core/runtime/owned-child.mjs";
import { processFailure } from "../app/src/core/runtime/process-outcome.mjs";
import { isMainScript } from "./script-entry.mjs";
import { record, string } from "../app/src/core/runtime/values.mjs";

function pnpmDocument(path: string, contents = readFileSync(path)): Record<string, unknown> {
  const documents = parseAllDocuments(contents.toString("utf8"));
  for (const document of documents) {
    const [error] = document.errors;
    if (error) throw error;
  }
  return record(documents.at(-1)?.toJSON(), `${path}: invalid pnpm metadata`);
}

function preparedGraph(root: string) {
  const metadata = join(root, "node_modules/.modules.yaml");
  const compiler = join(root, "node_modules/esbuild");
  if (!existsSync(metadata) || !existsSync(compiler)) return;
  const manifestPath = join(root, "package.json");
  const lock = join(root, "pnpm-lock.yaml");
  const hook = join(root, ".pnpmfile.cjs");
  const metadataBytes = readFileSync(metadata);
  const modules = pnpmDocument(metadata, metadataBytes);
  if (typeof modules.virtualStoreDir !== "string") return;
  const installed = join(resolve(dirname(realpathSync.native(metadata)), modules.virtualStoreDir), "lock.yaml");
  if (!existsSync(installed)) return;
  const manifestBytes = readFileSync(manifestPath);
  const expectedLock = readFileSync(lock);
  const preparedLock = readFileSync(installed);
  const hookBytes = existsSync(hook) ? readFileSync(hook) : undefined;
  const identity = createHash("sha256").update(JSON.stringify([installed, realpathSync.native(compiler)]));
  for (const bytes of [metadataBytes, manifestBytes, expectedLock, preparedLock, hookBytes])
    if (bytes) identity.update(String(bytes.length) + "\0").update(bytes);
    else identity.update("absent\0");
  return {
    identity: identity.digest("hex"),
    modules,
    manifestBytes,
    lock,
    installed,
    expectedLock,
    preparedLock,
    hookBytes,
  };
}

function matchesPreparedGraph(graph: ReturnType<typeof preparedGraph>): boolean {
  if (!graph) return false;
  const { modules, manifestBytes, lock, installed, expectedLock, preparedLock, hookBytes } = graph;
  const manifest = record(JSON.parse(manifestBytes.toString("utf8")), "Invalid package metadata");
  if (modules.packageManager !== manifest.packageManager) return false;
  const expected = pnpmDocument(lock, expectedLock);
  if (!expectedLock.equals(preparedLock) && !isDeepStrictEqual(expected, pnpmDocument(installed, preparedLock)))
    return false;
  const checksum = hookBytes ? `sha256-${createHash("sha256").update(hookBytes).digest("base64")}` : undefined;
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

/** A prepared tree must match the project lock, not just contain the build tool. */
export function preparedDependenciesMatch(root: string): boolean {
  return matchesPreparedGraph(preparedGraph(root));
}

/** Source installation builds disposable bundles before invoking the Workbench CLI. */
export async function setupDevelopment(root: string, args = process.argv.slice(2)): Promise<void> {
  if (process.env.WORKBENCH_SOURCE_SETUP === "1") return;
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      dependencies: { type: "string" },
      "build-only": { type: "boolean" },
      "reuse-prepared": { type: "boolean" },
      "verify-prepared": { type: "boolean" },
      "prepared-proof": { type: "string" },
      "prepared-proof-output": { type: "string" },
    },
  });
  if (values["verify-prepared"] || process.env.WORKBENCH_CHECK_SCOPED === "1") {
    const graph = preparedGraph(root);
    if (!(values["prepared-proof"] && graph?.identity === values["prepared-proof"]) && !matchesPreparedGraph(graph))
      throw new Error("Prepare the locked dependencies before running checks");
    return;
  }
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
  const provider = values.dependencies ? resolve(values.dependencies) : undefined;
  const { bundleInputDigest, reuseBundles } = await import("./bundle-cache.mts");
  let observedInputs: string | undefined;
  const destinationInputs = () => {
    observedInputs ??= bundleInputDigest(root);
    return observedInputs;
  };
  const bundleInputs = { destinationInputs };
  if (values["build-only"] || lifecycle) {
    if (reuseBundles(root, root, bundleInputs)) return;
    if (provider && reuseBundles(provider, root, bundleInputs)) return;
  }
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
  const configuredVirtualStore = process.env.PNPM_CONFIG_VIRTUAL_STORE_DIR;
  const localVirtualStore = join(root, "node_modules/.pnpm");
  try {
    if (provider && !existsSync(join(root, "node_modules"))) {
      const metadata = (directory: string) =>
        record(
          JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
          `${directory}: invalid package metadata`,
        );
      const from = metadata(provider),
        to = metadata(root);
      const matching =
        readFileSync(join(provider, "pnpm-lock.yaml")).equals(readFileSync(join(root, "pnpm-lock.yaml"))) &&
        [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
          "overrides",
          "resolutions",
          "pnpm",
          "packageManager",
        ].every((key) => isDeepStrictEqual(from[key], to[key])) &&
        readFileSync(join(provider, "pnpm-workspace.yaml")).equals(readFileSync(join(root, "pnpm-workspace.yaml")));
      if (matching) {
        if (!preparedDependenciesMatch(provider))
          throw new Error("The dependency provider does not match its source pins; run source setup in that checkout");
        const { linkDependencies } = await import("./link-dependencies.mts");
        linkDependencies(join(provider, "node_modules"), join(root, "node_modules"));
      } else {
        try {
          await run(
            process.execPath,
            [
              join(provider, "bin/workbench.mjs"),
              "package-manager-exec",
              "--",
              "install",
              "--offline",
              "--frozen-lockfile",
              "--ignore-scripts",
            ],
            root,
            {
              ...environment,
              WORKBENCH_DISTRIBUTION_ROOT: provider,
              WORKBENCH_LOCAL_CONFIG_ROOT: provider,
              WORKBENCH_OFFLINE: "1",
              WORKBENCH_STORAGE_PROJECT: undefined,
              PNPM_CONFIG_STORE_DIR: undefined,
              PNPM_CONFIG_VIRTUAL_STORE_DIR: undefined,
            },
          );
        } catch (cause) {
          cancellation.signal.throwIfAborted();
          throw new Error("The staged dependency inputs are unavailable. Run 'workbench prepare --staged'.", { cause });
        }
      }
    }
    let graph = preparedGraph(root);
    const prepared = matchesPreparedGraph(graph);
    if (
      !prepared &&
      ["node_modules", "node_modules/.modules.yaml"].some((path) =>
        lstatSync(join(root, path), { throwIfNoEntry: false })?.isSymbolicLink(),
      )
    )
      throw new Error(
        "The linked dependency provider no longer matches its source pins; repair the provider before running source setup",
      );
    const offline = process.env.WORKBENCH_OFFLINE === "1";
    const distribution = resolve(process.env.WORKBENCH_DISTRIBUTION_ROOT ?? root);
    const bundledInstaller = !lifecycle && !values["build-only"] && existsSync(join(distribution, "bundle/main.cjs"));
    const managed =
      offline &&
      !prepared &&
      bundledInstaller &&
      (await import("../app/src/core/execution/environments/managed-inputs.ts")).managedInputRepository(root)
        ?.declaration.registry;
    const cachedStore = process.env.WORKBENCH_CACHE_HOME && join(process.env.WORKBENCH_CACHE_HOME, "downloads/pnpm");
    // Recreate a fresh checkout's links from the locked package store transferred by preparation.
    const nativeStore =
      offline &&
      !prepared &&
      bundledInstaller &&
      !managed &&
      values["reuse-prepared"] &&
      cachedStore &&
      existsSync(cachedStore)
        ? cachedStore
        : undefined;
    if (offline && !prepared && !managed && !nativeStore)
      throw new Error(
        "Source dependencies are not prepared; run source setup online or supply matching prepared dependencies",
      );
    if ((!offline || managed || nativeStore) && bundledInstaller && !(values["reuse-prepared"] && prepared)) {
      await run(
        process.execPath,
        [
          join(distribution, "bin/workbench.mjs"),
          "package-manager-exec",
          "--",
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          ...(nativeStore ? ["--offline", "--store-dir", nativeStore] : []),
        ],
        root,
        {
          ...environment,
          WORKBENCH_DISTRIBUTION_ROOT: distribution,
          ...(nativeStore ? { WORKBENCH_PREPARED: "1" } : {}),
        },
      );
    } else if (!prepared) {
      const npm = npmCommand();
      const managerInputs = join(root, "scripts/package-manager");
      const manifest = record(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "Invalid package metadata");
      const lockText = readFileSync(join(managerInputs, "package-lock.json"), "utf8");
      const lock = record(JSON.parse(lockText), "Invalid package-manager lock");
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
      temporary = mkdtempSync(join(tmpdir(), "workbench-source-setup-"));
      const manager = join(temporary, "manager");
      mkdirSync(manager);
      copyFileSync(join(managerInputs, "package.json"), join(manager, "package.json"));
      writeFileSync(join(manager, "package-lock.json"), lockText);
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
      const replace = existsSync(join(root, "node_modules"));
      if (replace && lstatSync(join(root, "node_modules")).isSymbolicLink())
        throw new Error(
          "Preserving a node_modules link without pnpm metadata; prepare matching dependencies before source setup",
        );
      initialLocalStore = !configuredVirtualStore && !existsSync(localVirtualStore);
      await run(process.execPath, [
        join(manager, "node_modules/pnpm/bin/pnpm.mjs"),
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        ...(replace ? ["--force"] : []),
        "--store-dir",
        process.env.PNPM_CONFIG_STORE_DIR ?? join(temporary, "store"),
        "--virtual-store-dir",
        configuredVirtualStore ?? localVirtualStore,
      ]);
    }
    if (!prepared) {
      graph = preparedGraph(root);
      if (!matchesPreparedGraph(graph)) throw new Error("Prepared source dependencies do not match the declared pins");
    }
    if (temporary && !configuredVirtualStore && !values["build-only"] && !lifecycle) {
      // The compiler's child process must release the bootstrap executable before pnpm can replace it on Windows.
      await run(process.execPath, [join(root, "scripts/setup-development.mjs"), "--build-only"], root, {
        ...environment,
        WORKBENCH_SOURCE_SETUP: undefined,
      });
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
      if (
        initialLocalStore &&
        modules.virtualStoreDir &&
        resolve(realpathSync.native(join(root, "node_modules")), modules.virtualStoreDir) !== localVirtualStore &&
        existsSync(localVirtualStore) &&
        !lstatSync(localVirtualStore).isSymbolicLink()
      )
        rmSync(localVirtualStore, { recursive: true });
    } else {
      const { buildTooling, collectToolingArtifacts } = await import("./build-tooling.mts");
      const sourceInputs = destinationInputs();
      cancellation.signal.throwIfAborted();
      await buildTooling({ root, operation: "prepare-development", sourceInputs, signal: cancellation.signal });
      cancellation.signal.throwIfAborted();
      if (!reuseBundles(root, root, bundleInputs)) {
        const { compileBundles, publishBundles } = await import("./bundle-build.mjs");
        const { verifyRuntimeDependencies } = await import("./runtime-dependencies.mjs");
        cancellation.signal.throwIfAborted();
        console.error("Building local Workbench bundles…");
        const bundles = await compileBundles(root, cancellation.signal, sourceInputs);
        verifyRuntimeDependencies({ root, artifacts: collectToolingArtifacts(root), ...bundles });
        publishBundles(root, bundles);
      }
    }
    if (values["prepared-proof-output"] && graph) {
      const current = preparedGraph(root);
      if (current?.identity !== graph.identity)
        throw new Error("Prepared dependencies changed during source setup; retry");
      writeFileSync(values["prepared-proof-output"], graph.identity, { flag: "wx", mode: 0o600 });
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
