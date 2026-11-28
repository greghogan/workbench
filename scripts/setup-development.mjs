// Generated from setup-development.mts; edit the TypeScript source.
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
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { parseAllDocuments } from "../app/src/core/configuration/runtime-parsers.mjs";
import { runOwnedChild, processCancellation } from "../app/src/core/runtime/owned-child.mjs";
import { processFailure } from "../app/src/core/runtime/process-outcome.mjs";
import { isMainScript } from "./script-entry.mjs";
import { record, string } from "../app/src/core/runtime/values.mjs";
function pnpmDocument(path, contents = readFileSync(path)) {
  const documents = parseAllDocuments(contents.toString("utf8"));
  for (const document of documents) {
    const [error] = document.errors;
    if (error) throw error;
  }
  return record(documents.at(-1)?.toJSON(), `${path}: invalid pnpm metadata`);
}
function preparedGraph(root) {
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
  const hookBytes = existsSync(hook) ? readFileSync(hook) : void 0;
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
    hookBytes
  };
}
function matchesPreparedGraph(graph) {
  if (!graph) return false;
  const { modules, manifestBytes, lock, installed, expectedLock, preparedLock, hookBytes } = graph;
  const manifest = record(JSON.parse(manifestBytes.toString("utf8")), "Invalid package metadata");
  if (modules.packageManager !== manifest.packageManager) return false;
  const expected = pnpmDocument(lock, expectedLock);
  if (!expectedLock.equals(preparedLock) && !isDeepStrictEqual(expected, pnpmDocument(installed, preparedLock)))
    return false;
  const checksum = hookBytes ? `sha256-${createHash("sha256").update(hookBytes).digest("base64")}` : void 0;
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
function preparedDependenciesMatch(root) {
  return matchesPreparedGraph(preparedGraph(root));
}
async function setupDevelopment(root, args = process.argv.slice(2)) {
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
      "prepared-proof-output": { type: "string" }
    }
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
  const running = process.versions.node.split(".").map(Number), minimum = minimumCliNode.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if ((running[index] ?? 0) > (minimum[index] ?? 0)) break;
    if ((running[index] ?? 0) < (minimum[index] ?? 0))
      throw new Error(`Source setup requires Node.js ${minimumCliNode} or newer; use development Node.js ${pin}`);
  }
  const provider = values.dependencies ? resolve(values.dependencies) : void 0;
  const { bundleInputDigest, reuseBundles } = await import("./bundle-cache.mts");
  let observedInputs;
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
  const environment = {
    ...npmRuntimeEnvironment(),
    WORKBENCH_SOURCE_SETUP: "1",
    COREPACK_ENABLE_NETWORK: "0",
    WORKBENCH_PROJECT_ROOT: root,
    WORKBENCH_DISTRIBUTION_ROOT: root,
    WORKBENCH_EPHEMERAL_CHECKOUT: "1",
    WORKBENCH_LOCAL_CONFIG_ROOT: process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? root
  };
  for (const key of ["WORKBENCH_EXECUTING_SPEC", "WORKBENCH_LAUNCH_CHAIN"]) Reflect.deleteProperty(environment, key);
  const run = async (command, parameters, cwd = root, env = environment) => {
    const result = await runOwnedChild(command, parameters, { cwd, env, signal: cancellation.signal });
    const failure = processFailure("development setup", result);
    if (failure) throw failure;
  };
  let temporary;
  let initialLocalStore = false;
  const configuredVirtualStore = process.env.PNPM_CONFIG_VIRTUAL_STORE_DIR;
  const localVirtualStore = join(root, "node_modules/.pnpm");
  try {
    if (provider && !existsSync(join(root, "node_modules"))) {
      const metadata = (directory) => record(
        JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
        `${directory}: invalid package metadata`
      );
      const from = metadata(provider), to = metadata(root);
      const matching = readFileSync(join(provider, "pnpm-lock.yaml")).equals(readFileSync(join(root, "pnpm-lock.yaml"))) && [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
        "overrides",
        "resolutions",
        "pnpm",
        "packageManager"
      ].every((key) => isDeepStrictEqual(from[key], to[key])) && readFileSync(join(provider, "pnpm-workspace.yaml")).equals(readFileSync(join(root, "pnpm-workspace.yaml")));
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
              "--ignore-scripts"
            ],
            root,
            {
              ...environment,
              WORKBENCH_DISTRIBUTION_ROOT: provider,
              WORKBENCH_LOCAL_CONFIG_ROOT: provider,
              WORKBENCH_OFFLINE: "1",
              WORKBENCH_STORAGE_PROJECT: void 0,
              PNPM_CONFIG_STORE_DIR: void 0,
              PNPM_CONFIG_VIRTUAL_STORE_DIR: void 0
            }
          );
        } catch (cause) {
          cancellation.signal.throwIfAborted();
          throw new Error("The staged dependency inputs are unavailable. Run 'workbench prepare --staged'.", { cause });
        }
      }
    }
    let graph = preparedGraph(root);
    const prepared = matchesPreparedGraph(graph);
    if (!prepared && ["node_modules", "node_modules/.modules.yaml"].some(
      (path) => lstatSync(join(root, path), { throwIfNoEntry: false })?.isSymbolicLink()
    ))
      throw new Error(
        "The linked dependency provider no longer matches its source pins; repair the provider before running source setup"
      );
    const offline = process.env.WORKBENCH_OFFLINE === "1";
    const distribution = resolve(process.env.WORKBENCH_DISTRIBUTION_ROOT ?? root);
    const bundledInstaller = !lifecycle && !values["build-only"] && existsSync(join(distribution, "bundle/main.cjs"));
    const managed = offline && !prepared && bundledInstaller && (await import("../app/src/core/execution/environments/managed-inputs.ts")).managedInputRepository(root)?.declaration.registry;
    const cachedStore = process.env.WORKBENCH_CACHE_HOME && join(process.env.WORKBENCH_CACHE_HOME, "downloads/pnpm");
    const nativeStore = offline && !prepared && bundledInstaller && !managed && values["reuse-prepared"] && cachedStore && existsSync(cachedStore) ? cachedStore : void 0;
    if (offline && !prepared && !managed && !nativeStore)
      throw new Error(
        "Source dependencies are not prepared; run source setup online or supply matching prepared dependencies"
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
          ...nativeStore ? ["--offline", "--store-dir", nativeStore] : []
        ],
        root,
        {
          ...environment,
          WORKBENCH_DISTRIBUTION_ROOT: distribution,
          ...nativeStore ? { WORKBENCH_PREPARED: "1" } : {}
        }
      );
    } else if (!prepared) {
      const npm = npmCommand();
      const managerInputs = join(root, "scripts/package-manager");
      const manifest = record(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "Invalid package metadata");
      const lockText = readFileSync(join(managerInputs, "package-lock.json"), "utf8");
      const lock = record(JSON.parse(lockText), "Invalid package-manager lock");
      const packages = record(lock.packages, "Missing bootstrap packages");
      const selected = record(packages["node_modules/pnpm"], "Missing locked package manager");
      if (lock.lockfileVersion !== 3 || `pnpm@${string(selected.version, "Missing package-manager version")}` !== manifest.packageManager)
        throw new Error("The package-manager bootstrap lock must match package.json");
      for (const [path, value] of Object.entries(packages)) {
        if (!path) continue;
        const entry = record(value, `Invalid bootstrap package ${path}`);
        if (typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://") || typeof entry.integrity !== "string" || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity))
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
        "--no-fund"
      ]);
      await run(npm.command, [...npm.prefix, "audit", "signatures", "--prefix", manager]);
      const replace = existsSync(join(root, "node_modules"));
      if (replace && lstatSync(join(root, "node_modules")).isSymbolicLink())
        throw new Error(
          "Preserving a node_modules link without pnpm metadata; prepare matching dependencies before source setup"
        );
      initialLocalStore = !configuredVirtualStore && !existsSync(localVirtualStore);
      await run(process.execPath, [
        join(manager, "node_modules/pnpm/bin/pnpm.mjs"),
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        ...replace ? ["--force"] : [],
        "--store-dir",
        process.env.PNPM_CONFIG_STORE_DIR ?? join(temporary, "store"),
        "--virtual-store-dir",
        configuredVirtualStore ?? localVirtualStore
      ]);
    }
    if (!prepared) {
      graph = preparedGraph(root);
      if (!matchesPreparedGraph(graph)) throw new Error("Prepared source dependencies do not match the declared pins");
    }
    if (temporary && !configuredVirtualStore && !values["build-only"] && !lifecycle) {
      await run(process.execPath, [join(root, "scripts/setup-development.mjs"), "--build-only"], root, {
        ...environment,
        WORKBENCH_SOURCE_SETUP: void 0
      });
      await run(process.execPath, [
        join(root, "bin/workbench.mjs"),
        "package-manager-exec",
        "--",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts"
      ]);
      const { parse } = await import("yaml");
      const modules = parse(readFileSync(join(root, "node_modules/.modules.yaml"), "utf8"));
      if (initialLocalStore && modules.virtualStoreDir && resolve(realpathSync.native(join(root, "node_modules")), modules.virtualStoreDir) !== localVirtualStore && existsSync(localVirtualStore) && !lstatSync(localVirtualStore).isSymbolicLink())
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
        console.error("Building local Workbench bundles\u2026");
        const bundles = await compileBundles(root, cancellation.signal, sourceInputs);
        verifyRuntimeDependencies({ root, artifacts: collectToolingArtifacts(root), ...bundles });
        publishBundles(root, bundles);
      }
    }
    if (values["prepared-proof-output"] && graph) {
      const current = preparedGraph(root);
      if (current?.identity !== graph.identity)
        throw new Error("Prepared dependencies changed during source setup; retry");
      writeFileSync(values["prepared-proof-output"], graph.identity, { flag: "wx", mode: 384 });
    }
  } finally {
    cancellation.close();
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
if (isMainScript(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await setupDevelopment(root).catch((error) => {
    console.error(`workbench: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
export {
  preparedDependenciesMatch,
  setupDevelopment
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInNldHVwLWRldmVsb3BtZW50Lm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXNvbHZlLCBqb2luLCBkaXJuYW1lIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHtcbiAgY29weUZpbGVTeW5jLFxuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgbWtkdGVtcFN5bmMsXG4gIHJtU3luYyxcbiAgbHN0YXRTeW5jLFxuICByZWFscGF0aFN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgaXNEZWVwU3RyaWN0RXF1YWwsIHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IHBhcnNlQWxsRG9jdW1lbnRzIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9jb25maWd1cmF0aW9uL3J1bnRpbWUtcGFyc2Vycy5tanNcIjtcbmltcG9ydCB7IHJ1bk93bmVkQ2hpbGQsIHByb2Nlc3NDYW5jZWxsYXRpb24gfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL3J1bnRpbWUvb3duZWQtY2hpbGQubWpzXCI7XG5pbXBvcnQgeyBwcm9jZXNzRmFpbHVyZSB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS9wcm9jZXNzLW91dGNvbWUubWpzXCI7XG5pbXBvcnQgeyBpc01haW5TY3JpcHQgfSBmcm9tIFwiLi9zY3JpcHQtZW50cnkubWpzXCI7XG5pbXBvcnQgeyByZWNvcmQsIHN0cmluZyB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS92YWx1ZXMubWpzXCI7XG5cbmZ1bmN0aW9uIHBucG1Eb2N1bWVudChwYXRoOiBzdHJpbmcsIGNvbnRlbnRzID0gcmVhZEZpbGVTeW5jKHBhdGgpKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBjb25zdCBkb2N1bWVudHMgPSBwYXJzZUFsbERvY3VtZW50cyhjb250ZW50cy50b1N0cmluZyhcInV0ZjhcIikpO1xuICBmb3IgKGNvbnN0IGRvY3VtZW50IG9mIGRvY3VtZW50cykge1xuICAgIGNvbnN0IFtlcnJvcl0gPSBkb2N1bWVudC5lcnJvcnM7XG4gICAgaWYgKGVycm9yKSB0aHJvdyBlcnJvcjtcbiAgfVxuICByZXR1cm4gcmVjb3JkKGRvY3VtZW50cy5hdCgtMSk/LnRvSlNPTigpLCBgJHtwYXRofTogaW52YWxpZCBwbnBtIG1ldGFkYXRhYCk7XG59XG5cbmZ1bmN0aW9uIHByZXBhcmVkR3JhcGgocm9vdDogc3RyaW5nKSB7XG4gIGNvbnN0IG1ldGFkYXRhID0gam9pbihyb290LCBcIm5vZGVfbW9kdWxlcy8ubW9kdWxlcy55YW1sXCIpO1xuICBjb25zdCBjb21waWxlciA9IGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXMvZXNidWlsZFwiKTtcbiAgaWYgKCFleGlzdHNTeW5jKG1ldGFkYXRhKSB8fCAhZXhpc3RzU3luYyhjb21waWxlcikpIHJldHVybjtcbiAgY29uc3QgbWFuaWZlc3RQYXRoID0gam9pbihyb290LCBcInBhY2thZ2UuanNvblwiKTtcbiAgY29uc3QgbG9jayA9IGpvaW4ocm9vdCwgXCJwbnBtLWxvY2sueWFtbFwiKTtcbiAgY29uc3QgaG9vayA9IGpvaW4ocm9vdCwgXCIucG5wbWZpbGUuY2pzXCIpO1xuICBjb25zdCBtZXRhZGF0YUJ5dGVzID0gcmVhZEZpbGVTeW5jKG1ldGFkYXRhKTtcbiAgY29uc3QgbW9kdWxlcyA9IHBucG1Eb2N1bWVudChtZXRhZGF0YSwgbWV0YWRhdGFCeXRlcyk7XG4gIGlmICh0eXBlb2YgbW9kdWxlcy52aXJ0dWFsU3RvcmVEaXIgIT09IFwic3RyaW5nXCIpIHJldHVybjtcbiAgY29uc3QgaW5zdGFsbGVkID0gam9pbihyZXNvbHZlKGRpcm5hbWUocmVhbHBhdGhTeW5jLm5hdGl2ZShtZXRhZGF0YSkpLCBtb2R1bGVzLnZpcnR1YWxTdG9yZURpciksIFwibG9jay55YW1sXCIpO1xuICBpZiAoIWV4aXN0c1N5bmMoaW5zdGFsbGVkKSkgcmV0dXJuO1xuICBjb25zdCBtYW5pZmVzdEJ5dGVzID0gcmVhZEZpbGVTeW5jKG1hbmlmZXN0UGF0aCk7XG4gIGNvbnN0IGV4cGVjdGVkTG9jayA9IHJlYWRGaWxlU3luYyhsb2NrKTtcbiAgY29uc3QgcHJlcGFyZWRMb2NrID0gcmVhZEZpbGVTeW5jKGluc3RhbGxlZCk7XG4gIGNvbnN0IGhvb2tCeXRlcyA9IGV4aXN0c1N5bmMoaG9vaykgPyByZWFkRmlsZVN5bmMoaG9vaykgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IGlkZW50aXR5ID0gY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUoSlNPTi5zdHJpbmdpZnkoW2luc3RhbGxlZCwgcmVhbHBhdGhTeW5jLm5hdGl2ZShjb21waWxlcildKSk7XG4gIGZvciAoY29uc3QgYnl0ZXMgb2YgW21ldGFkYXRhQnl0ZXMsIG1hbmlmZXN0Qnl0ZXMsIGV4cGVjdGVkTG9jaywgcHJlcGFyZWRMb2NrLCBob29rQnl0ZXNdKVxuICAgIGlmIChieXRlcykgaWRlbnRpdHkudXBkYXRlKFN0cmluZyhieXRlcy5sZW5ndGgpICsgXCJcXDBcIikudXBkYXRlKGJ5dGVzKTtcbiAgICBlbHNlIGlkZW50aXR5LnVwZGF0ZShcImFic2VudFxcMFwiKTtcbiAgcmV0dXJuIHtcbiAgICBpZGVudGl0eTogaWRlbnRpdHkuZGlnZXN0KFwiaGV4XCIpLFxuICAgIG1vZHVsZXMsXG4gICAgbWFuaWZlc3RCeXRlcyxcbiAgICBsb2NrLFxuICAgIGluc3RhbGxlZCxcbiAgICBleHBlY3RlZExvY2ssXG4gICAgcHJlcGFyZWRMb2NrLFxuICAgIGhvb2tCeXRlcyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWF0Y2hlc1ByZXBhcmVkR3JhcGgoZ3JhcGg6IFJldHVyblR5cGU8dHlwZW9mIHByZXBhcmVkR3JhcGg+KTogYm9vbGVhbiB7XG4gIGlmICghZ3JhcGgpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgeyBtb2R1bGVzLCBtYW5pZmVzdEJ5dGVzLCBsb2NrLCBpbnN0YWxsZWQsIGV4cGVjdGVkTG9jaywgcHJlcGFyZWRMb2NrLCBob29rQnl0ZXMgfSA9IGdyYXBoO1xuICBjb25zdCBtYW5pZmVzdCA9IHJlY29yZChKU09OLnBhcnNlKG1hbmlmZXN0Qnl0ZXMudG9TdHJpbmcoXCJ1dGY4XCIpKSwgXCJJbnZhbGlkIHBhY2thZ2UgbWV0YWRhdGFcIik7XG4gIGlmIChtb2R1bGVzLnBhY2thZ2VNYW5hZ2VyICE9PSBtYW5pZmVzdC5wYWNrYWdlTWFuYWdlcikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBleHBlY3RlZCA9IHBucG1Eb2N1bWVudChsb2NrLCBleHBlY3RlZExvY2spO1xuICBpZiAoIWV4cGVjdGVkTG9jay5lcXVhbHMocHJlcGFyZWRMb2NrKSAmJiAhaXNEZWVwU3RyaWN0RXF1YWwoZXhwZWN0ZWQsIHBucG1Eb2N1bWVudChpbnN0YWxsZWQsIHByZXBhcmVkTG9jaykpKVxuICAgIHJldHVybiBmYWxzZTtcbiAgY29uc3QgY2hlY2tzdW0gPSBob29rQnl0ZXMgPyBgc2hhMjU2LSR7Y3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUoaG9va0J5dGVzKS5kaWdlc3QoXCJiYXNlNjRcIil9YCA6IHVuZGVmaW5lZDtcbiAgaWYgKGV4cGVjdGVkLnBucG1maWxlQ2hlY2tzdW0gIT09IGNoZWNrc3VtKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGltcG9ydGVyID0gcmVjb3JkKHJlY29yZChleHBlY3RlZC5pbXBvcnRlcnMsIFwiTWlzc2luZyBwbnBtIGltcG9ydGVyc1wiKVtcIi5cIl0sIFwiTWlzc2luZyBwcm9qZWN0IGltcG9ydGVyXCIpO1xuICBmb3IgKGNvbnN0IGtpbmQgb2YgW1wiZGVwZW5kZW5jaWVzXCIsIFwiZGV2RGVwZW5kZW5jaWVzXCIsIFwib3B0aW9uYWxEZXBlbmRlbmNpZXNcIl0pIHtcbiAgICBjb25zdCBkZWNsYXJlZCA9IHJlY29yZChtYW5pZmVzdFtraW5kXSA/PyB7fSwgXCJJbnZhbGlkIGRlY2xhcmVkIGRlcGVuZGVuY2llc1wiKTtcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlY29yZChpbXBvcnRlcltraW5kXSA/PyB7fSwgXCJJbnZhbGlkIGluc3RhbGxlZCBkZXBlbmRlbmNpZXNcIik7XG4gICAgaWYgKCFpc0RlZXBTdHJpY3RFcXVhbChPYmplY3Qua2V5cyhkZWNsYXJlZCkuc29ydCgpLCBPYmplY3Qua2V5cyhzZWxlY3RlZCkuc29ydCgpKSkgcmV0dXJuIGZhbHNlO1xuICAgIGZvciAoY29uc3QgW25hbWUsIHNwZWNpZmllcl0gb2YgT2JqZWN0LmVudHJpZXMoZGVjbGFyZWQpKVxuICAgICAgaWYgKHJlY29yZChzZWxlY3RlZFtuYW1lXSwgXCJJbnZhbGlkIGluc3RhbGxlZCBkZXBlbmRlbmN5XCIpLnNwZWNpZmllciAhPT0gc3BlY2lmaWVyKSByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKiBBIHByZXBhcmVkIHRyZWUgbXVzdCBtYXRjaCB0aGUgcHJvamVjdCBsb2NrLCBub3QganVzdCBjb250YWluIHRoZSBidWlsZCB0b29sLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByZXBhcmVkRGVwZW5kZW5jaWVzTWF0Y2gocm9vdDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBtYXRjaGVzUHJlcGFyZWRHcmFwaChwcmVwYXJlZEdyYXBoKHJvb3QpKTtcbn1cblxuLyoqIFNvdXJjZSBpbnN0YWxsYXRpb24gYnVpbGRzIGRpc3Bvc2FibGUgYnVuZGxlcyBiZWZvcmUgaW52b2tpbmcgdGhlIFdvcmtiZW5jaCBDTEkuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2V0dXBEZXZlbG9wbWVudChyb290OiBzdHJpbmcsIGFyZ3MgPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKHByb2Nlc3MuZW52LldPUktCRU5DSF9TT1VSQ0VfU0VUVVAgPT09IFwiMVwiKSByZXR1cm47XG4gIGNvbnN0IHsgdmFsdWVzIH0gPSBwYXJzZUFyZ3Moe1xuICAgIGFyZ3MsXG4gICAgc3RyaWN0OiB0cnVlLFxuICAgIG9wdGlvbnM6IHtcbiAgICAgIGRlcGVuZGVuY2llczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICBcImJ1aWxkLW9ubHlcIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICAgICAgXCJyZXVzZS1wcmVwYXJlZFwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gICAgICBcInZlcmlmeS1wcmVwYXJlZFwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gICAgICBcInByZXBhcmVkLXByb29mXCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgXCJwcmVwYXJlZC1wcm9vZi1vdXRwdXRcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgfSxcbiAgfSk7XG4gIGlmICh2YWx1ZXNbXCJ2ZXJpZnktcHJlcGFyZWRcIl0gfHwgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NIRUNLX1NDT1BFRCA9PT0gXCIxXCIpIHtcbiAgICBjb25zdCBncmFwaCA9IHByZXBhcmVkR3JhcGgocm9vdCk7XG4gICAgaWYgKCEodmFsdWVzW1wicHJlcGFyZWQtcHJvb2ZcIl0gJiYgZ3JhcGg/LmlkZW50aXR5ID09PSB2YWx1ZXNbXCJwcmVwYXJlZC1wcm9vZlwiXSkgJiYgIW1hdGNoZXNQcmVwYXJlZEdyYXBoKGdyYXBoKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlByZXBhcmUgdGhlIGxvY2tlZCBkZXBlbmRlbmNpZXMgYmVmb3JlIHJ1bm5pbmcgY2hlY2tzXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBsaWZlY3ljbGUgPSBwcm9jZXNzLmVudi5ucG1fbGlmZWN5Y2xlX2V2ZW50ID09PSBcInByZXBhcmVcIjtcbiAgY29uc3QgcGluID0gcmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCIubm9kZS12ZXJzaW9uXCIpLCBcInV0ZjhcIikudHJpbSgpO1xuICBpZiAoIXByb2Nlc3MuZmVhdHVyZXMudHlwZXNjcmlwdClcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFNvdXJjZSBzZXR1cCByZXF1aXJlcyBuYXRpdmUgVHlwZVNjcmlwdCBzdXBwb3J0OyB1c2UgdGhlIGRldmVsb3BtZW50IE5vZGUuanMgJHtwaW59YCk7XG4gIGNvbnN0IHsgbWluaW11bUNsaU5vZGUgfSA9IGF3YWl0IGltcG9ydChcIi4uL2FwcC9zcmMvY29yZS9kaXN0cmlidXRpb24vbm9kZS1ydW50aW1lcy5tdHNcIik7XG4gIGNvbnN0IHJ1bm5pbmcgPSBwcm9jZXNzLnZlcnNpb25zLm5vZGUuc3BsaXQoXCIuXCIpLm1hcChOdW1iZXIpLFxuICAgIG1pbmltdW0gPSBtaW5pbXVtQ2xpTm9kZS5zcGxpdChcIi5cIikubWFwKE51bWJlcik7XG4gIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCAzOyBpbmRleCsrKSB7XG4gICAgaWYgKChydW5uaW5nW2luZGV4XSA/PyAwKSA+IChtaW5pbXVtW2luZGV4XSA/PyAwKSkgYnJlYWs7XG4gICAgaWYgKChydW5uaW5nW2luZGV4XSA/PyAwKSA8IChtaW5pbXVtW2luZGV4XSA/PyAwKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgU291cmNlIHNldHVwIHJlcXVpcmVzIE5vZGUuanMgJHttaW5pbXVtQ2xpTm9kZX0gb3IgbmV3ZXI7IHVzZSBkZXZlbG9wbWVudCBOb2RlLmpzICR7cGlufWApO1xuICB9XG4gIGNvbnN0IHByb3ZpZGVyID0gdmFsdWVzLmRlcGVuZGVuY2llcyA/IHJlc29sdmUodmFsdWVzLmRlcGVuZGVuY2llcykgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHsgYnVuZGxlSW5wdXREaWdlc3QsIHJldXNlQnVuZGxlcyB9ID0gYXdhaXQgaW1wb3J0KFwiLi9idW5kbGUtY2FjaGUubXRzXCIpO1xuICBsZXQgb2JzZXJ2ZWRJbnB1dHM6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgY29uc3QgZGVzdGluYXRpb25JbnB1dHMgPSAoKSA9PiB7XG4gICAgb2JzZXJ2ZWRJbnB1dHMgPz89IGJ1bmRsZUlucHV0RGlnZXN0KHJvb3QpO1xuICAgIHJldHVybiBvYnNlcnZlZElucHV0cztcbiAgfTtcbiAgY29uc3QgYnVuZGxlSW5wdXRzID0geyBkZXN0aW5hdGlvbklucHV0cyB9O1xuICBpZiAodmFsdWVzW1wiYnVpbGQtb25seVwiXSB8fCBsaWZlY3ljbGUpIHtcbiAgICBpZiAocmV1c2VCdW5kbGVzKHJvb3QsIHJvb3QsIGJ1bmRsZUlucHV0cykpIHJldHVybjtcbiAgICBpZiAocHJvdmlkZXIgJiYgcmV1c2VCdW5kbGVzKHByb3ZpZGVyLCByb290LCBidW5kbGVJbnB1dHMpKSByZXR1cm47XG4gIH1cbiAgY29uc3QgY2FuY2VsbGF0aW9uID0gcHJvY2Vzc0NhbmNlbGxhdGlvbigpO1xuICBjb25zdCB7IG5wbUNvbW1hbmQsIG5wbVJ1bnRpbWVFbnZpcm9ubWVudCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYXBwL3NyYy9jb3JlL3Rvb2xjaGFpbnMvbnBtLWNvbW1hbmQudHNcIik7XG4gIGNvbnN0IGVudmlyb25tZW50OiBOb2RlSlMuUHJvY2Vzc0VudiA9IHtcbiAgICAuLi5ucG1SdW50aW1lRW52aXJvbm1lbnQoKSxcbiAgICBXT1JLQkVOQ0hfU09VUkNFX1NFVFVQOiBcIjFcIixcbiAgICBDT1JFUEFDS19FTkFCTEVfTkVUV09SSzogXCIwXCIsXG4gICAgV09SS0JFTkNIX1BST0pFQ1RfUk9PVDogcm9vdCxcbiAgICBXT1JLQkVOQ0hfRElTVFJJQlVUSU9OX1JPT1Q6IHJvb3QsXG4gICAgV09SS0JFTkNIX0VQSEVNRVJBTF9DSEVDS09VVDogXCIxXCIsXG4gICAgV09SS0JFTkNIX0xPQ0FMX0NPTkZJR19ST09UOiBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTE9DQUxfQ09ORklHX1JPT1QgPz8gcm9vdCxcbiAgfTtcbiAgZm9yIChjb25zdCBrZXkgb2YgW1wiV09SS0JFTkNIX0VYRUNVVElOR19TUEVDXCIsIFwiV09SS0JFTkNIX0xBVU5DSF9DSEFJTlwiXSkgUmVmbGVjdC5kZWxldGVQcm9wZXJ0eShlbnZpcm9ubWVudCwga2V5KTtcbiAgY29uc3QgcnVuID0gYXN5bmMgKGNvbW1hbmQ6IHN0cmluZywgcGFyYW1ldGVyczogc3RyaW5nW10sIGN3ZCA9IHJvb3QsIGVudiA9IGVudmlyb25tZW50KSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuT3duZWRDaGlsZChjb21tYW5kLCBwYXJhbWV0ZXJzLCB7IGN3ZCwgZW52LCBzaWduYWw6IGNhbmNlbGxhdGlvbi5zaWduYWwgfSk7XG4gICAgY29uc3QgZmFpbHVyZSA9IHByb2Nlc3NGYWlsdXJlKFwiZGV2ZWxvcG1lbnQgc2V0dXBcIiwgcmVzdWx0KTtcbiAgICBpZiAoZmFpbHVyZSkgdGhyb3cgZmFpbHVyZTtcbiAgfTtcbiAgbGV0IHRlbXBvcmFyeTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgaW5pdGlhbExvY2FsU3RvcmUgPSBmYWxzZTtcbiAgY29uc3QgY29uZmlndXJlZFZpcnR1YWxTdG9yZSA9IHByb2Nlc3MuZW52LlBOUE1fQ09ORklHX1ZJUlRVQUxfU1RPUkVfRElSO1xuICBjb25zdCBsb2NhbFZpcnR1YWxTdG9yZSA9IGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXMvLnBucG1cIik7XG4gIHRyeSB7XG4gICAgaWYgKHByb3ZpZGVyICYmICFleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXNcIikpKSB7XG4gICAgICBjb25zdCBtZXRhZGF0YSA9IChkaXJlY3Rvcnk6IHN0cmluZykgPT5cbiAgICAgICAgcmVjb3JkKFxuICAgICAgICAgIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBcInBhY2thZ2UuanNvblwiKSwgXCJ1dGY4XCIpKSxcbiAgICAgICAgICBgJHtkaXJlY3Rvcnl9OiBpbnZhbGlkIHBhY2thZ2UgbWV0YWRhdGFgLFxuICAgICAgICApO1xuICAgICAgY29uc3QgZnJvbSA9IG1ldGFkYXRhKHByb3ZpZGVyKSxcbiAgICAgICAgdG8gPSBtZXRhZGF0YShyb290KTtcbiAgICAgIGNvbnN0IG1hdGNoaW5nID1cbiAgICAgICAgcmVhZEZpbGVTeW5jKGpvaW4ocHJvdmlkZXIsIFwicG5wbS1sb2NrLnlhbWxcIikpLmVxdWFscyhyZWFkRmlsZVN5bmMoam9pbihyb290LCBcInBucG0tbG9jay55YW1sXCIpKSkgJiZcbiAgICAgICAgW1xuICAgICAgICAgIFwiZGVwZW5kZW5jaWVzXCIsXG4gICAgICAgICAgXCJkZXZEZXBlbmRlbmNpZXNcIixcbiAgICAgICAgICBcIm9wdGlvbmFsRGVwZW5kZW5jaWVzXCIsXG4gICAgICAgICAgXCJwZWVyRGVwZW5kZW5jaWVzXCIsXG4gICAgICAgICAgXCJvdmVycmlkZXNcIixcbiAgICAgICAgICBcInJlc29sdXRpb25zXCIsXG4gICAgICAgICAgXCJwbnBtXCIsXG4gICAgICAgICAgXCJwYWNrYWdlTWFuYWdlclwiLFxuICAgICAgICBdLmV2ZXJ5KChrZXkpID0+IGlzRGVlcFN0cmljdEVxdWFsKGZyb21ba2V5XSwgdG9ba2V5XSkpICYmXG4gICAgICAgIHJlYWRGaWxlU3luYyhqb2luKHByb3ZpZGVyLCBcInBucG0td29ya3NwYWNlLnlhbWxcIikpLmVxdWFscyhyZWFkRmlsZVN5bmMoam9pbihyb290LCBcInBucG0td29ya3NwYWNlLnlhbWxcIikpKTtcbiAgICAgIGlmIChtYXRjaGluZykge1xuICAgICAgICBpZiAoIXByZXBhcmVkRGVwZW5kZW5jaWVzTWF0Y2gocHJvdmlkZXIpKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIlRoZSBkZXBlbmRlbmN5IHByb3ZpZGVyIGRvZXMgbm90IG1hdGNoIGl0cyBzb3VyY2UgcGluczsgcnVuIHNvdXJjZSBzZXR1cCBpbiB0aGF0IGNoZWNrb3V0XCIpO1xuICAgICAgICBjb25zdCB7IGxpbmtEZXBlbmRlbmNpZXMgfSA9IGF3YWl0IGltcG9ydChcIi4vbGluay1kZXBlbmRlbmNpZXMubXRzXCIpO1xuICAgICAgICBsaW5rRGVwZW5kZW5jaWVzKGpvaW4ocHJvdmlkZXIsIFwibm9kZV9tb2R1bGVzXCIpLCBqb2luKHJvb3QsIFwibm9kZV9tb2R1bGVzXCIpKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgcnVuKFxuICAgICAgICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgam9pbihwcm92aWRlciwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgICAgICAgXCJwYWNrYWdlLW1hbmFnZXItZXhlY1wiLFxuICAgICAgICAgICAgICBcIi0tXCIsXG4gICAgICAgICAgICAgIFwiaW5zdGFsbFwiLFxuICAgICAgICAgICAgICBcIi0tb2ZmbGluZVwiLFxuICAgICAgICAgICAgICBcIi0tZnJvemVuLWxvY2tmaWxlXCIsXG4gICAgICAgICAgICAgIFwiLS1pZ25vcmUtc2NyaXB0c1wiLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIC4uLmVudmlyb25tZW50LFxuICAgICAgICAgICAgICBXT1JLQkVOQ0hfRElTVFJJQlVUSU9OX1JPT1Q6IHByb3ZpZGVyLFxuICAgICAgICAgICAgICBXT1JLQkVOQ0hfTE9DQUxfQ09ORklHX1JPT1Q6IHByb3ZpZGVyLFxuICAgICAgICAgICAgICBXT1JLQkVOQ0hfT0ZGTElORTogXCIxXCIsXG4gICAgICAgICAgICAgIFdPUktCRU5DSF9TVE9SQUdFX1BST0pFQ1Q6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgUE5QTV9DT05GSUdfU1RPUkVfRElSOiB1bmRlZmluZWQsXG4gICAgICAgICAgICAgIFBOUE1fQ09ORklHX1ZJUlRVQUxfU1RPUkVfRElSOiB1bmRlZmluZWQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICk7XG4gICAgICAgIH0gY2F0Y2ggKGNhdXNlKSB7XG4gICAgICAgICAgY2FuY2VsbGF0aW9uLnNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIlRoZSBzdGFnZWQgZGVwZW5kZW5jeSBpbnB1dHMgYXJlIHVuYXZhaWxhYmxlLiBSdW4gJ3dvcmtiZW5jaCBwcmVwYXJlIC0tc3RhZ2VkJy5cIiwgeyBjYXVzZSB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBsZXQgZ3JhcGggPSBwcmVwYXJlZEdyYXBoKHJvb3QpO1xuICAgIGNvbnN0IHByZXBhcmVkID0gbWF0Y2hlc1ByZXBhcmVkR3JhcGgoZ3JhcGgpO1xuICAgIGlmIChcbiAgICAgICFwcmVwYXJlZCAmJlxuICAgICAgW1wibm9kZV9tb2R1bGVzXCIsIFwibm9kZV9tb2R1bGVzLy5tb2R1bGVzLnlhbWxcIl0uc29tZSgocGF0aCkgPT5cbiAgICAgICAgbHN0YXRTeW5jKGpvaW4ocm9vdCwgcGF0aCksIHsgdGhyb3dJZk5vRW50cnk6IGZhbHNlIH0pPy5pc1N5bWJvbGljTGluaygpLFxuICAgICAgKVxuICAgIClcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJUaGUgbGlua2VkIGRlcGVuZGVuY3kgcHJvdmlkZXIgbm8gbG9uZ2VyIG1hdGNoZXMgaXRzIHNvdXJjZSBwaW5zOyByZXBhaXIgdGhlIHByb3ZpZGVyIGJlZm9yZSBydW5uaW5nIHNvdXJjZSBzZXR1cFwiLFxuICAgICAgKTtcbiAgICBjb25zdCBvZmZsaW5lID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX09GRkxJTkUgPT09IFwiMVwiO1xuICAgIGNvbnN0IGRpc3RyaWJ1dGlvbiA9IHJlc29sdmUocHJvY2Vzcy5lbnYuV09SS0JFTkNIX0RJU1RSSUJVVElPTl9ST09UID8/IHJvb3QpO1xuICAgIGNvbnN0IGJ1bmRsZWRJbnN0YWxsZXIgPSAhbGlmZWN5Y2xlICYmICF2YWx1ZXNbXCJidWlsZC1vbmx5XCJdICYmIGV4aXN0c1N5bmMoam9pbihkaXN0cmlidXRpb24sIFwiYnVuZGxlL21haW4uY2pzXCIpKTtcbiAgICBjb25zdCBtYW5hZ2VkID1cbiAgICAgIG9mZmxpbmUgJiZcbiAgICAgICFwcmVwYXJlZCAmJlxuICAgICAgYnVuZGxlZEluc3RhbGxlciAmJlxuICAgICAgKGF3YWl0IGltcG9ydChcIi4uL2FwcC9zcmMvY29yZS9leGVjdXRpb24vZW52aXJvbm1lbnRzL21hbmFnZWQtaW5wdXRzLnRzXCIpKS5tYW5hZ2VkSW5wdXRSZXBvc2l0b3J5KHJvb3QpXG4gICAgICAgID8uZGVjbGFyYXRpb24ucmVnaXN0cnk7XG4gICAgY29uc3QgY2FjaGVkU3RvcmUgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQ0FDSEVfSE9NRSAmJiBqb2luKHByb2Nlc3MuZW52LldPUktCRU5DSF9DQUNIRV9IT01FLCBcImRvd25sb2Fkcy9wbnBtXCIpO1xuICAgIC8vIFJlY3JlYXRlIGEgZnJlc2ggY2hlY2tvdXQncyBsaW5rcyBmcm9tIHRoZSBsb2NrZWQgcGFja2FnZSBzdG9yZSB0cmFuc2ZlcnJlZCBieSBwcmVwYXJhdGlvbi5cbiAgICBjb25zdCBuYXRpdmVTdG9yZSA9XG4gICAgICBvZmZsaW5lICYmXG4gICAgICAhcHJlcGFyZWQgJiZcbiAgICAgIGJ1bmRsZWRJbnN0YWxsZXIgJiZcbiAgICAgICFtYW5hZ2VkICYmXG4gICAgICB2YWx1ZXNbXCJyZXVzZS1wcmVwYXJlZFwiXSAmJlxuICAgICAgY2FjaGVkU3RvcmUgJiZcbiAgICAgIGV4aXN0c1N5bmMoY2FjaGVkU3RvcmUpXG4gICAgICAgID8gY2FjaGVkU3RvcmVcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgaWYgKG9mZmxpbmUgJiYgIXByZXBhcmVkICYmICFtYW5hZ2VkICYmICFuYXRpdmVTdG9yZSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJTb3VyY2UgZGVwZW5kZW5jaWVzIGFyZSBub3QgcHJlcGFyZWQ7IHJ1biBzb3VyY2Ugc2V0dXAgb25saW5lIG9yIHN1cHBseSBtYXRjaGluZyBwcmVwYXJlZCBkZXBlbmRlbmNpZXNcIixcbiAgICAgICk7XG4gICAgaWYgKCghb2ZmbGluZSB8fCBtYW5hZ2VkIHx8IG5hdGl2ZVN0b3JlKSAmJiBidW5kbGVkSW5zdGFsbGVyICYmICEodmFsdWVzW1wicmV1c2UtcHJlcGFyZWRcIl0gJiYgcHJlcGFyZWQpKSB7XG4gICAgICBhd2FpdCBydW4oXG4gICAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIFtcbiAgICAgICAgICBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgICBcInBhY2thZ2UtbWFuYWdlci1leGVjXCIsXG4gICAgICAgICAgXCItLVwiLFxuICAgICAgICAgIFwiaW5zdGFsbFwiLFxuICAgICAgICAgIFwiLS1mcm96ZW4tbG9ja2ZpbGVcIixcbiAgICAgICAgICBcIi0taWdub3JlLXNjcmlwdHNcIixcbiAgICAgICAgICAuLi4obmF0aXZlU3RvcmUgPyBbXCItLW9mZmxpbmVcIiwgXCItLXN0b3JlLWRpclwiLCBuYXRpdmVTdG9yZV0gOiBbXSksXG4gICAgICAgIF0sXG4gICAgICAgIHJvb3QsXG4gICAgICAgIHtcbiAgICAgICAgICAuLi5lbnZpcm9ubWVudCxcbiAgICAgICAgICBXT1JLQkVOQ0hfRElTVFJJQlVUSU9OX1JPT1Q6IGRpc3RyaWJ1dGlvbixcbiAgICAgICAgICAuLi4obmF0aXZlU3RvcmUgPyB7IFdPUktCRU5DSF9QUkVQQVJFRDogXCIxXCIgfSA6IHt9KSxcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfSBlbHNlIGlmICghcHJlcGFyZWQpIHtcbiAgICAgIGNvbnN0IG5wbSA9IG5wbUNvbW1hbmQoKTtcbiAgICAgIGNvbnN0IG1hbmFnZXJJbnB1dHMgPSBqb2luKHJvb3QsIFwic2NyaXB0cy9wYWNrYWdlLW1hbmFnZXJcIik7XG4gICAgICBjb25zdCBtYW5pZmVzdCA9IHJlY29yZChKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIFwicGFja2FnZS5qc29uXCIpLCBcInV0ZjhcIikpLCBcIkludmFsaWQgcGFja2FnZSBtZXRhZGF0YVwiKTtcbiAgICAgIGNvbnN0IGxvY2tUZXh0ID0gcmVhZEZpbGVTeW5jKGpvaW4obWFuYWdlcklucHV0cywgXCJwYWNrYWdlLWxvY2suanNvblwiKSwgXCJ1dGY4XCIpO1xuICAgICAgY29uc3QgbG9jayA9IHJlY29yZChKU09OLnBhcnNlKGxvY2tUZXh0KSwgXCJJbnZhbGlkIHBhY2thZ2UtbWFuYWdlciBsb2NrXCIpO1xuICAgICAgY29uc3QgcGFja2FnZXMgPSByZWNvcmQobG9jay5wYWNrYWdlcywgXCJNaXNzaW5nIGJvb3RzdHJhcCBwYWNrYWdlc1wiKTtcbiAgICAgIGNvbnN0IHNlbGVjdGVkID0gcmVjb3JkKHBhY2thZ2VzW1wibm9kZV9tb2R1bGVzL3BucG1cIl0sIFwiTWlzc2luZyBsb2NrZWQgcGFja2FnZSBtYW5hZ2VyXCIpO1xuICAgICAgaWYgKFxuICAgICAgICBsb2NrLmxvY2tmaWxlVmVyc2lvbiAhPT0gMyB8fFxuICAgICAgICBgcG5wbUAke3N0cmluZyhzZWxlY3RlZC52ZXJzaW9uLCBcIk1pc3NpbmcgcGFja2FnZS1tYW5hZ2VyIHZlcnNpb25cIil9YCAhPT0gbWFuaWZlc3QucGFja2FnZU1hbmFnZXJcbiAgICAgIClcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiVGhlIHBhY2thZ2UtbWFuYWdlciBib290c3RyYXAgbG9jayBtdXN0IG1hdGNoIHBhY2thZ2UuanNvblwiKTtcbiAgICAgIGZvciAoY29uc3QgW3BhdGgsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwYWNrYWdlcykpIHtcbiAgICAgICAgaWYgKCFwYXRoKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgZW50cnkgPSByZWNvcmQodmFsdWUsIGBJbnZhbGlkIGJvb3RzdHJhcCBwYWNrYWdlICR7cGF0aH1gKTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHR5cGVvZiBlbnRyeS5yZXNvbHZlZCAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAgICFlbnRyeS5yZXNvbHZlZC5zdGFydHNXaXRoKFwiaHR0cHM6Ly9cIikgfHxcbiAgICAgICAgICB0eXBlb2YgZW50cnkuaW50ZWdyaXR5ICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgICAgIS9ec2hhKD86MjU2fDM4NHw1MTIpLVtBLVphLXowLTkrL10rPXswLDJ9JC8udGVzdChlbnRyeS5pbnRlZ3JpdHkpXG4gICAgICAgIClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJCb290c3RyYXAgcGFja2FnZXMgcmVxdWlyZSBIVFRQUyBhbmQgc3Ryb25nIGludGVncml0eSBoYXNoZXNcIik7XG4gICAgICB9XG4gICAgICB0ZW1wb3JhcnkgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIndvcmtiZW5jaC1zb3VyY2Utc2V0dXAtXCIpKTtcbiAgICAgIGNvbnN0IG1hbmFnZXIgPSBqb2luKHRlbXBvcmFyeSwgXCJtYW5hZ2VyXCIpO1xuICAgICAgbWtkaXJTeW5jKG1hbmFnZXIpO1xuICAgICAgY29weUZpbGVTeW5jKGpvaW4obWFuYWdlcklucHV0cywgXCJwYWNrYWdlLmpzb25cIiksIGpvaW4obWFuYWdlciwgXCJwYWNrYWdlLmpzb25cIikpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKG1hbmFnZXIsIFwicGFja2FnZS1sb2NrLmpzb25cIiksIGxvY2tUZXh0KTtcbiAgICAgIGF3YWl0IHJ1bihucG0uY29tbWFuZCwgW1xuICAgICAgICAuLi5ucG0ucHJlZml4LFxuICAgICAgICBcImNpXCIsXG4gICAgICAgIFwiLS1wcmVmaXhcIixcbiAgICAgICAgbWFuYWdlcixcbiAgICAgICAgXCItLWlnbm9yZS1zY3JpcHRzXCIsXG4gICAgICAgIFwiLS1pbmNsdWRlPW9wdGlvbmFsXCIsXG4gICAgICAgIFwiLS1uby1hdWRpdFwiLFxuICAgICAgICBcIi0tbm8tZnVuZFwiLFxuICAgICAgXSk7XG4gICAgICBhd2FpdCBydW4obnBtLmNvbW1hbmQsIFsuLi5ucG0ucHJlZml4LCBcImF1ZGl0XCIsIFwic2lnbmF0dXJlc1wiLCBcIi0tcHJlZml4XCIsIG1hbmFnZXJdKTtcbiAgICAgIGNvbnN0IHJlcGxhY2UgPSBleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXNcIikpO1xuICAgICAgaWYgKHJlcGxhY2UgJiYgbHN0YXRTeW5jKGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXNcIikpLmlzU3ltYm9saWNMaW5rKCkpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIlByZXNlcnZpbmcgYSBub2RlX21vZHVsZXMgbGluayB3aXRob3V0IHBucG0gbWV0YWRhdGE7IHByZXBhcmUgbWF0Y2hpbmcgZGVwZW5kZW5jaWVzIGJlZm9yZSBzb3VyY2Ugc2V0dXBcIixcbiAgICAgICAgKTtcbiAgICAgIGluaXRpYWxMb2NhbFN0b3JlID0gIWNvbmZpZ3VyZWRWaXJ0dWFsU3RvcmUgJiYgIWV4aXN0c1N5bmMobG9jYWxWaXJ0dWFsU3RvcmUpO1xuICAgICAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtcbiAgICAgICAgam9pbihtYW5hZ2VyLCBcIm5vZGVfbW9kdWxlcy9wbnBtL2Jpbi9wbnBtLm1qc1wiKSxcbiAgICAgICAgXCJpbnN0YWxsXCIsXG4gICAgICAgIFwiLS1mcm96ZW4tbG9ja2ZpbGVcIixcbiAgICAgICAgXCItLWlnbm9yZS1zY3JpcHRzXCIsXG4gICAgICAgIC4uLihyZXBsYWNlID8gW1wiLS1mb3JjZVwiXSA6IFtdKSxcbiAgICAgICAgXCItLXN0b3JlLWRpclwiLFxuICAgICAgICBwcm9jZXNzLmVudi5QTlBNX0NPTkZJR19TVE9SRV9ESVIgPz8gam9pbih0ZW1wb3JhcnksIFwic3RvcmVcIiksXG4gICAgICAgIFwiLS12aXJ0dWFsLXN0b3JlLWRpclwiLFxuICAgICAgICBjb25maWd1cmVkVmlydHVhbFN0b3JlID8/IGxvY2FsVmlydHVhbFN0b3JlLFxuICAgICAgXSk7XG4gICAgfVxuICAgIGlmICghcHJlcGFyZWQpIHtcbiAgICAgIGdyYXBoID0gcHJlcGFyZWRHcmFwaChyb290KTtcbiAgICAgIGlmICghbWF0Y2hlc1ByZXBhcmVkR3JhcGgoZ3JhcGgpKSB0aHJvdyBuZXcgRXJyb3IoXCJQcmVwYXJlZCBzb3VyY2UgZGVwZW5kZW5jaWVzIGRvIG5vdCBtYXRjaCB0aGUgZGVjbGFyZWQgcGluc1wiKTtcbiAgICB9XG4gICAgaWYgKHRlbXBvcmFyeSAmJiAhY29uZmlndXJlZFZpcnR1YWxTdG9yZSAmJiAhdmFsdWVzW1wiYnVpbGQtb25seVwiXSAmJiAhbGlmZWN5Y2xlKSB7XG4gICAgICAvLyBUaGUgY29tcGlsZXIncyBjaGlsZCBwcm9jZXNzIG11c3QgcmVsZWFzZSB0aGUgYm9vdHN0cmFwIGV4ZWN1dGFibGUgYmVmb3JlIHBucG0gY2FuIHJlcGxhY2UgaXQgb24gV2luZG93cy5cbiAgICAgIGF3YWl0IHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbam9pbihyb290LCBcInNjcmlwdHMvc2V0dXAtZGV2ZWxvcG1lbnQubWpzXCIpLCBcIi0tYnVpbGQtb25seVwiXSwgcm9vdCwge1xuICAgICAgICAuLi5lbnZpcm9ubWVudCxcbiAgICAgICAgV09SS0JFTkNIX1NPVVJDRV9TRVRVUDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW1xuICAgICAgICBqb2luKHJvb3QsIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgIFwicGFja2FnZS1tYW5hZ2VyLWV4ZWNcIixcbiAgICAgICAgXCItLVwiLFxuICAgICAgICBcImluc3RhbGxcIixcbiAgICAgICAgXCItLWZyb3plbi1sb2NrZmlsZVwiLFxuICAgICAgICBcIi0taWdub3JlLXNjcmlwdHNcIixcbiAgICAgIF0pO1xuICAgICAgY29uc3QgeyBwYXJzZSB9ID0gYXdhaXQgaW1wb3J0KFwieWFtbFwiKTtcbiAgICAgIGNvbnN0IG1vZHVsZXMgPSBwYXJzZShyZWFkRmlsZVN5bmMoam9pbihyb290LCBcIm5vZGVfbW9kdWxlcy8ubW9kdWxlcy55YW1sXCIpLCBcInV0ZjhcIikpIGFzIHtcbiAgICAgICAgdmlydHVhbFN0b3JlRGlyPzogc3RyaW5nO1xuICAgICAgfTtcbiAgICAgIGlmIChcbiAgICAgICAgaW5pdGlhbExvY2FsU3RvcmUgJiZcbiAgICAgICAgbW9kdWxlcy52aXJ0dWFsU3RvcmVEaXIgJiZcbiAgICAgICAgcmVzb2x2ZShyZWFscGF0aFN5bmMubmF0aXZlKGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXNcIikpLCBtb2R1bGVzLnZpcnR1YWxTdG9yZURpcikgIT09IGxvY2FsVmlydHVhbFN0b3JlICYmXG4gICAgICAgIGV4aXN0c1N5bmMobG9jYWxWaXJ0dWFsU3RvcmUpICYmXG4gICAgICAgICFsc3RhdFN5bmMobG9jYWxWaXJ0dWFsU3RvcmUpLmlzU3ltYm9saWNMaW5rKClcbiAgICAgIClcbiAgICAgICAgcm1TeW5jKGxvY2FsVmlydHVhbFN0b3JlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgeyBidWlsZFRvb2xpbmcsIGNvbGxlY3RUb29saW5nQXJ0aWZhY3RzIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2J1aWxkLXRvb2xpbmcubXRzXCIpO1xuICAgICAgY29uc3Qgc291cmNlSW5wdXRzID0gZGVzdGluYXRpb25JbnB1dHMoKTtcbiAgICAgIGNhbmNlbGxhdGlvbi5zaWduYWwudGhyb3dJZkFib3J0ZWQoKTtcbiAgICAgIGF3YWl0IGJ1aWxkVG9vbGluZyh7IHJvb3QsIG9wZXJhdGlvbjogXCJwcmVwYXJlLWRldmVsb3BtZW50XCIsIHNvdXJjZUlucHV0cywgc2lnbmFsOiBjYW5jZWxsYXRpb24uc2lnbmFsIH0pO1xuICAgICAgY2FuY2VsbGF0aW9uLnNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICAgICAgaWYgKCFyZXVzZUJ1bmRsZXMocm9vdCwgcm9vdCwgYnVuZGxlSW5wdXRzKSkge1xuICAgICAgICBjb25zdCB7IGNvbXBpbGVCdW5kbGVzLCBwdWJsaXNoQnVuZGxlcyB9ID0gYXdhaXQgaW1wb3J0KFwiLi9idW5kbGUtYnVpbGQubWpzXCIpO1xuICAgICAgICBjb25zdCB7IHZlcmlmeVJ1bnRpbWVEZXBlbmRlbmNpZXMgfSA9IGF3YWl0IGltcG9ydChcIi4vcnVudGltZS1kZXBlbmRlbmNpZXMubWpzXCIpO1xuICAgICAgICBjYW5jZWxsYXRpb24uc2lnbmFsLnRocm93SWZBYm9ydGVkKCk7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJCdWlsZGluZyBsb2NhbCBXb3JrYmVuY2ggYnVuZGxlc+KAplwiKTtcbiAgICAgICAgY29uc3QgYnVuZGxlcyA9IGF3YWl0IGNvbXBpbGVCdW5kbGVzKHJvb3QsIGNhbmNlbGxhdGlvbi5zaWduYWwsIHNvdXJjZUlucHV0cyk7XG4gICAgICAgIHZlcmlmeVJ1bnRpbWVEZXBlbmRlbmNpZXMoeyByb290LCBhcnRpZmFjdHM6IGNvbGxlY3RUb29saW5nQXJ0aWZhY3RzKHJvb3QpLCAuLi5idW5kbGVzIH0pO1xuICAgICAgICBwdWJsaXNoQnVuZGxlcyhyb290LCBidW5kbGVzKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHZhbHVlc1tcInByZXBhcmVkLXByb29mLW91dHB1dFwiXSAmJiBncmFwaCkge1xuICAgICAgY29uc3QgY3VycmVudCA9IHByZXBhcmVkR3JhcGgocm9vdCk7XG4gICAgICBpZiAoY3VycmVudD8uaWRlbnRpdHkgIT09IGdyYXBoLmlkZW50aXR5KVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJQcmVwYXJlZCBkZXBlbmRlbmNpZXMgY2hhbmdlZCBkdXJpbmcgc291cmNlIHNldHVwOyByZXRyeVwiKTtcbiAgICAgIHdyaXRlRmlsZVN5bmModmFsdWVzW1wicHJlcGFyZWQtcHJvb2Ytb3V0cHV0XCJdLCBncmFwaC5pZGVudGl0eSwgeyBmbGFnOiBcInd4XCIsIG1vZGU6IDBvNjAwIH0pO1xuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICBjYW5jZWxsYXRpb24uY2xvc2UoKTtcbiAgICBpZiAodGVtcG9yYXJ5KSBybVN5bmModGVtcG9yYXJ5LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn1cblxuaWYgKGlzTWFpblNjcmlwdChpbXBvcnQubWV0YS51cmwpKSB7XG4gIGNvbnN0IHJvb3QgPSByZXNvbHZlKGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKSwgXCIuLlwiKTtcbiAgYXdhaXQgc2V0dXBEZXZlbG9wbWVudChyb290KS5jYXRjaCgoZXJyb3I6IHVua25vd24pID0+IHtcbiAgICBjb25zb2xlLmVycm9yKGB3b3JrYmVuY2g6ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfWApO1xuICAgIHByb2Nlc3MuZXhpdENvZGUgPSAxO1xuICB9KTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsU0FBUyxNQUFNLGVBQWU7QUFDdkMsU0FBUyxxQkFBcUI7QUFDOUI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsbUJBQW1CLGlCQUFpQjtBQUM3QyxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLHlCQUF5QjtBQUNsQyxTQUFTLGVBQWUsMkJBQTJCO0FBQ25ELFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsUUFBUSxjQUFjO0FBRS9CLFNBQVMsYUFBYSxNQUFjLFdBQVcsYUFBYSxJQUFJLEdBQTRCO0FBQzFGLFFBQU0sWUFBWSxrQkFBa0IsU0FBUyxTQUFTLE1BQU0sQ0FBQztBQUM3RCxhQUFXLFlBQVksV0FBVztBQUNoQyxVQUFNLENBQUMsS0FBSyxJQUFJLFNBQVM7QUFDekIsUUFBSSxNQUFPLE9BQU07QUFBQSxFQUNuQjtBQUNBLFNBQU8sT0FBTyxVQUFVLEdB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UUFBUSxlQUFlLE1BQU0scUJBQ3RGLFdBQVcsaUJBQWlCLEtBQzVCLENBQUMsVUFBVSxpQkFBaUIsRUFBRSxlQUFlO0FBRTdDLGVBQU8sbUJBQW1CLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFBQSxJQUNqRCxPQUFPO0FBQ0wsWUFBTSxFQUFFLGNBQWMsd0JBQXdCLElBQUksTUFBTSxPQUFPLHFCQUFxQjtBQUNwRixZQUFNLGVBQWUsa0JBQWtCO0FBQ3ZDLG1CQUFhLE9BQU8sZUFBZTtBQUNuQyxZQUFNLGFBQWEsRUFBRSxNQUFNLFdBQVcsdUJBQXVCLGNBQWMsUUFBUSxhQUFhLE9BQU8sQ0FBQztBQUN4RyxtQkFBYSxPQUFPLGVBQWU7QUFDbkMsVUFBSSxDQUFDLGFBQWEsTUFBTSxNQUFNLFlBQVksR0FBRztBQUMzQyxjQUFNLEVBQUUsZ0JBQWdCLGVBQWUsSUFBSSxNQUFNLE9BQU8sb0JBQW9CO0FBQzVFLGNBQU0sRUFBRSwwQkFBMEIsSUFBSSxNQUFNLE9BQU8sNEJBQTRCO0FBQy9FLHFCQUFhLE9BQU8sZUFBZTtBQUNuQyxnQkFBUSxNQUFNLHdDQUFtQztBQUNqRCxjQUFNLFVBQVUsTUFBTSxlQUFlLE1BQU0sYUFBYSxRQUFRLFlBQVk7QUFDNUUsa0NBQTBCLEVBQUUsTUFBTSxXQUFXLHdCQUF3QixJQUFJLEdBQUcsR0FBRyxRQUFRLENBQUM7QUFDeEYsdUJBQWUsTUFBTSxPQUFPO0FBQUEsTUFDOUI7QUFBQSxJQUNGO0FBQ0EsUUFBSSxPQUFPLHVCQUF1QixLQUFLLE9BQU87QUFDNUMsWUFBTSxVQUFVLGNBQWMsSUFBSTtBQUNsQyxVQUFJLFNBQVMsYUFBYSxNQUFNO0FBQzlCLGNBQU0sSUFBSSxNQUFNLDBEQUEwRDtBQUM1RSxvQkFBYyxPQUFPLHVCQUF1QixHQUFHLE1BQU0sVUFBVSxFQUFFLE1BQU0sTUFBTSxNQUFNLElBQU0sQ0FBQztBQUFBLElBQzVGO0FBQUEsRUFDRixVQUFFO0FBQ0EsaUJBQWEsTUFBTTtBQUNuQixRQUFJLFVBQVcsUUFBTyxXQUFXLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDbkU7QUFDRjtBQUVBLElBQUksYUFBYSxZQUFZLEdBQUcsR0FBRztBQUNqQyxRQUFNLE9BQU8sUUFBUSxRQUFRLGNBQWMsWUFBWSxHQUFHLENBQUMsR0FBRyxJQUFJO0FBQ2xFLFFBQU0saUJBQWlCLElBQUksRUFBRSxNQUFNLENBQUMsVUFBbUI7QUFDckQsWUFBUSxNQUFNLGNBQWMsaUJBQWlCLFFBQVEsTUFBTSxVQUFVLE9BQU8sS0FBSyxDQUFDLEVBQUU7QUFDcEYsWUFBUSxXQUFXO0FBQUEsRUFDckIsQ0FBQztBQUNIOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvc2V0dXAtZGV2ZWxvcG1lbnQubWpzIn0=
