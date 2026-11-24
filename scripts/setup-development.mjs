// Generated from setup-development.mts; edit the TypeScript source.
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdtempSync, rmSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { parseAllDocuments } from "../app/src/core/configuration/runtime-parsers.mjs";
import { runOwnedChild, processCancellation } from "../app/src/core/runtime/owned-child.mjs";
import { processFailure } from "../app/src/core/runtime/process-outcome.mjs";
import { isMainScript } from "./script-entry.mjs";
import { record, string } from "../app/src/core/runtime/values.mjs";
function pnpmDocument(path) {
  const documents = parseAllDocuments(readFileSync(path, "utf8"));
  for (const document of documents) {
    const [error] = document.errors;
    if (error) throw error;
  }
  return record(documents.at(-1)?.toJSON(), `${path}: invalid pnpm metadata`);
}
function preparedDependenciesMatch(root) {
  const metadata = join(root, "node_modules/.modules.yaml");
  if (!existsSync(metadata) || !existsSync(join(root, "node_modules/esbuild"))) return false;
  const manifest = record(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "Invalid package metadata");
  const modules = pnpmDocument(metadata);
  if (modules.packageManager !== manifest.packageManager || typeof modules.virtualStoreDir !== "string") return false;
  const installed = join(resolve(dirname(realpathSync.native(metadata)), modules.virtualStoreDir), "lock.yaml");
  if (!existsSync(installed)) return false;
  const expected = pnpmDocument(join(root, "pnpm-lock.yaml"));
  if (!isDeepStrictEqual(expected, pnpmDocument(installed))) return false;
  const hook = join(root, ".pnpmfile.cjs");
  const checksum = existsSync(hook) ? `sha256-${createHash("sha256").update(readFileSync(hook)).digest("base64")}` : void 0;
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
async function setupDevelopment(root, args = process.argv.slice(2)) {
  if (process.env.WORKBENCH_SOURCE_SETUP === "1") return;
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      dependencies: { type: "string" },
      "build-only": { type: "boolean" },
      "reuse-prepared": { type: "boolean" },
      "verify-prepared": { type: "boolean" }
    }
  });
  if (values["verify-prepared"] || process.env.WORKBENCH_CHECK_SCOPED === "1") {
    if (!preparedDependenciesMatch(root)) throw new Error("Prepare the locked dependencies before running checks");
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
  if (values["build-only"] || lifecycle) {
    const { reuseBundles } = await import("./bundle-cache.mts");
    if (reuseBundles(root)) return;
    if (values.dependencies && reuseBundles(resolve(values.dependencies), root)) return;
  }
  const provider = values.dependencies ? resolve(values.dependencies) : void 0;
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
    const prepared = preparedDependenciesMatch(root);
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
      const manager = join(root, "scripts/package-manager");
      const manifest = record(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "Invalid package metadata");
      const lock = record(
        JSON.parse(readFileSync(join(manager, "package-lock.json"), "utf8")),
        "Invalid package-manager lock"
      );
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
      temporary = mkdtempSync(join(tmpdir(), "workbench-source-setup-"));
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
    if (!prepared && !preparedDependenciesMatch(root))
      throw new Error("Prepared source dependencies do not match the declared pins");
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
      await run(process.execPath, [join(root, "scripts/build-tooling.mts"), "--maintainers-only"]);
      const { reuseBundles } = await import("./bundle-cache.mts");
      if (!reuseBundles(root)) {
        const { compileBundles, publishBundles } = await import("./bundle-build.mjs");
        const { collectToolingArtifacts } = await import("./build-tooling.mts");
        const { verifyRuntimeDependencies } = await import("./runtime-dependencies.mjs");
        cancellation.signal.throwIfAborted();
        console.error("Building local Workbench bundles\u2026");
        const bundles = await compileBundles(root, cancellation.signal);
        verifyRuntimeDependencies({ root, artifacts: collectToolingArtifacts(root), ...bundles });
        publishBundles(root, bundles);
      }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInNldHVwLWRldmVsb3BtZW50Lm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXNvbHZlLCBqb2luLCBkaXJuYW1lIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCBta2R0ZW1wU3luYywgcm1TeW5jLCBsc3RhdFN5bmMsIHJlYWxwYXRoU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgaXNEZWVwU3RyaWN0RXF1YWwsIHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IHBhcnNlQWxsRG9jdW1lbnRzIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9jb25maWd1cmF0aW9uL3J1bnRpbWUtcGFyc2Vycy5tanNcIjtcbmltcG9ydCB7IHJ1bk93bmVkQ2hpbGQsIHByb2Nlc3NDYW5jZWxsYXRpb24gfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL3J1bnRpbWUvb3duZWQtY2hpbGQubWpzXCI7XG5pbXBvcnQgeyBwcm9jZXNzRmFpbHVyZSB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS9wcm9jZXNzLW91dGNvbWUubWpzXCI7XG5pbXBvcnQgeyBpc01haW5TY3JpcHQgfSBmcm9tIFwiLi9zY3JpcHQtZW50cnkubWpzXCI7XG5pbXBvcnQgeyByZWNvcmQsIHN0cmluZyB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS92YWx1ZXMubWpzXCI7XG5cbmZ1bmN0aW9uIHBucG1Eb2N1bWVudChwYXRoOiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IGRvY3VtZW50cyA9IHBhcnNlQWxsRG9jdW1lbnRzKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpO1xuICBmb3IgKGNvbnN0IGRvY3VtZW50IG9mIGRvY3VtZW50cykge1xuICAgIGNvbnN0IFtlcnJvcl0gPSBkb2N1bWVudC5lcnJvcnM7XG4gICAgaWYgKGVycm9yKSB0aHJvdyBlcnJvcjtcbiAgfVxuICByZXR1cm4gcmVjb3JkKGRvY3VtZW50cy5hdCgtMSk/LnRvSlNPTigpLCBgJHtwYXRofTogaW52YWxpZCBwbnBtIG1ldGFkYXRhYCk7XG59XG5cbi8qKiBBIHByZXBhcmVkIHRyZWUgbXVzdCBtYXRjaCB0aGUgcHJvamVjdCBsb2NrLCBub3QganVzdCBjb250YWluIHRoZSBidWlsZCB0b29sLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByZXBhcmVkRGVwZW5kZW5jaWVzTWF0Y2gocm9vdDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IG1ldGFkYXRhID0gam9pbihyb290LCBcIm5vZGVfbW9kdWxlcy8ubW9kdWxlcy55YW1sXCIpO1xuICBpZiAoIWV4aXN0c1N5bmMobWV0YWRhdGEpIHx8ICFleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXMvZXNidWlsZFwiKSkpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgbWFuaWZlc3QgPSByZWNvcmQoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihyb290LCBcInBhY2thZ2UuanNvblwiKSwgXCJ1dGY4XCIpKSwgXCJJbnZhbGlkIHBhY2thZ2UgbWV0YWRhdGFcIik7XG4gIGNvbnN0IG1vZHVsZXMgPSBwbnBtRG9jdW1lbnQobWV0YWRhdGEpO1xuICBpZiAobW9kdWxlcy5wYWNrYWdlTWFuYWdlciAhPT0gbWFuaWZlc3QucGFja2FnZU1hbmFnZXIgfHwgdHlwZW9mIG1vZHVsZXMudmlydHVhbFN0b3JlRGlyICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGluc3RhbGxlZCA9IGpvaW4ocmVzb2x2ZShkaXJuYW1lKHJlYWxwYXRoU3luYy5uYXRpdmUobWV0YWRhdGEpKSwgbW9kdWxlcy52aXJ0dWFsU3RvcmVEaXIpLCBcImxvY2sueWFtbFwiKTtcbiAgaWYgKCFleGlzdHNTeW5jKGluc3RhbGxlZCkpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgZXhwZWN0ZWQgPSBwbnBtRG9jdW1lbnQoam9pbihyb290LCBcInBucG0tbG9jay55YW1sXCIpKTtcbiAgaWYgKCFpc0RlZXBTdHJpY3RFcXVhbChleHBlY3RlZCwgcG5wbURvY3VtZW50KGluc3RhbGxlZCkpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGhvb2sgPSBqb2luKHJvb3QsIFwiLnBucG1maWxlLmNqc1wiKTtcbiAgY29uc3QgY2hlY2tzdW0gPSBleGlzdHNTeW5jKGhvb2spXG4gICAgPyBgc2hhMjU2LSR7Y3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUocmVhZEZpbGVTeW5jKGhvb2spKS5kaWdlc3QoXCJiYXNlNjRcIil9YFxuICAgIDogdW5kZWZpbmVkO1xuICBpZiAoZXhwZWN0ZWQucG5wbWZpbGVDaGVja3N1bSAhPT0gY2hlY2tzdW0pIHJldHVybiBmYWxzZTtcbiAgY29uc3QgaW1wb3J0ZXIgPSByZWNvcmQocmVjb3JkKGV4cGVjdGVkLmltcG9ydGVycywgXCJNaXNzaW5nIHBucG0gaW1wb3J0ZXJzXCIpW1wiLlwiXSwgXCJNaXNzaW5nIHByb2plY3QgaW1wb3J0ZXJcIik7XG4gIGZvciAoY29uc3Qga2luZCBvZiBbXCJkZXBlbmRlbmNpZXNcIiwgXCJkZXZEZXBlbmRlbmNpZXNcIiwgXCJvcHRpb25hbERlcGVuZGVuY2llc1wiXSkge1xuICAgIGNvbnN0IGRlY2xhcmVkID0gcmVjb3JkKG1hbmlmZXN0W2tpbmRdID8/IHt9LCBcIkludmFsaWQgZGVjbGFyZWQgZGVwZW5kZW5jaWVzXCIpO1xuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVjb3JkKGltcG9ydGVyW2tpbmRdID8/IHt9LCBcIkludmFsaWQgaW5zdGFsbGVkIGRlcGVuZGVuY2llc1wiKTtcbiAgICBpZiAoIWlzRGVlcFN0cmljdEVxdWFsKE9iamVjdC5rZXlzKGRlY2xhcmVkKS5zb3J0KCksIE9iamVjdC5rZXlzKHNlbGVjdGVkKS5zb3J0KCkpKSByZXR1cm4gZmFsc2U7XG4gICAgZm9yIChjb25zdCBbbmFtZSwgc3BlY2lmaWVyXSBvZiBPYmplY3QuZW50cmllcyhkZWNsYXJlZCkpXG4gICAgICBpZiAocmVjb3JkKHNlbGVjdGVkW25hbWVdLCBcIkludmFsaWQgaW5zdGFsbGVkIGRlcGVuZGVuY3lcIikuc3BlY2lmaWVyICE9PSBzcGVjaWZpZXIpIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqIFNvdXJjZSBpbnN0YWxsYXRpb24gYnVpbGRzIGRpc3Bvc2FibGUgYnVuZGxlcyBiZWZvcmUgaW52b2tpbmcgdGhlIFdvcmtiZW5jaCBDTEkuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2V0dXBEZXZlbG9wbWVudChyb290OiBzdHJpbmcsIGFyZ3MgPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKHByb2Nlc3MuZW52LldPUktCRU5DSF9TT1VSQ0VfU0VUVVAgPT09IFwiMVwiKSByZXR1cm47XG4gIGNvbnN0IHsgdmFsdWVzIH0gPSBwYXJzZUFyZ3Moe1xuICAgIGFyZ3MsXG4gICAgc3RyaWN0OiB0cnVlLFxuICAgIG9wdGlvbnM6IHtcbiAgICAgIGRlcGVuZGVuY2llczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICBcImJ1aWxkLW9ubHlcIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICAgICAgXCJyZXVzZS1wcmVwYXJlZFwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gICAgICBcInZlcmlmeS1wcmVwYXJlZFwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gICAgfSxcbiAgfSk7XG4gIGlmICh2YWx1ZXNbXCJ2ZXJpZnktcHJlcGFyZWRcIl0gfHwgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NIRUNLX1NDT1BFRCA9PT0gXCIxXCIpIHtcbiAgICBpZiAoIXByZXBhcmVkRGVwZW5kZW5jaWVzTWF0Y2gocm9vdCkpIHRocm93IG5ldyBFcnJvcihcIlByZXBhcmUgdGhlIGxvY2tlZCBkZXBlbmRlbmNpZXMgYmVmb3JlIHJ1bm5pbmcgY2hlY2tzXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBsaWZlY3ljbGUgPSBwcm9jZXNzLmVudi5ucG1fbGlmZWN5Y2xlX2V2ZW50ID09PSBcInByZXBhcmVcIjtcbiAgY29uc3QgcGluID0gcmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCIubm9kZS12ZXJzaW9uXCIpLCBcInV0ZjhcIikudHJpbSgpO1xuICBpZiAoIXByb2Nlc3MuZmVhdHVyZXMudHlwZXNjcmlwdClcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFNvdXJjZSBzZXR1cCByZXF1aXJlcyBuYXRpdmUgVHlwZVNjcmlwdCBzdXBwb3J0OyB1c2UgdGhlIGRldmVsb3BtZW50IE5vZGUuanMgJHtwaW59YCk7XG4gIGNvbnN0IHsgbWluaW11bUNsaU5vZGUgfSA9IGF3YWl0IGltcG9ydChcIi4uL2FwcC9zcmMvY29yZS9kaXN0cmlidXRpb24vbm9kZS1ydW50aW1lcy5tdHNcIik7XG4gIGNvbnN0IHJ1bm5pbmcgPSBwcm9jZXNzLnZlcnNpb25zLm5vZGUuc3BsaXQoXCIuXCIpLm1hcChOdW1iZXIpLFxuICAgIG1pbmltdW0gPSBtaW5pbXVtQ2xpTm9kZS5zcGxpdChcIi5cIikubWFwKE51bWJlcik7XG4gIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCAzOyBpbmRleCsrKSB7XG4gICAgaWYgKChydW5uaW5nW2luZGV4XSA/PyAwKSA+IChtaW5pbXVtW2luZGV4XSA/PyAwKSkgYnJlYWs7XG4gICAgaWYgKChydW5uaW5nW2luZGV4XSA/PyAwKSA8IChtaW5pbXVtW2luZGV4XSA/PyAwKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgU291cmNlIHNldHVwIHJlcXVpcmVzIE5vZGUuanMgJHttaW5pbXVtQ2xpTm9kZX0gb3IgbmV3ZXI7IHVzZSBkZXZlbG9wbWVudCBOb2RlLmpzICR7cGlufWApO1xuICB9XG4gIGlmICh2YWx1ZXNbXCJidWlsZC1vbmx5XCJdIHx8IGxpZmVjeWNsZSkge1xuICAgIGNvbnN0IHsgcmV1c2VCdW5kbGVzIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2J1bmRsZS1jYWNoZS5tdHNcIik7XG4gICAgaWYgKHJldXNlQnVuZGxlcyhyb290KSkgcmV0dXJuO1xuICAgIGlmICh2YWx1ZXMuZGVwZW5kZW5jaWVzICYmIHJldXNlQnVuZGxlcyhyZXNvbHZlKHZhbHVlcy5kZXBlbmRlbmNpZXMpLCByb290KSkgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHByb3ZpZGVyID0gdmFsdWVzLmRlcGVuZGVuY2llcyA/IHJlc29sdmUodmFsdWVzLmRlcGVuZGVuY2llcykgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IGNhbmNlbGxhdGlvbiA9IHByb2Nlc3NDYW5jZWxsYXRpb24oKTtcbiAgY29uc3QgeyBucG1Db21tYW5kLCBucG1SdW50aW1lRW52aXJvbm1lbnQgfSA9IGF3YWl0IGltcG9ydChcIi4uL2FwcC9zcmMvY29yZS90b29sY2hhaW5zL25wbS1jb21tYW5kLnRzXCIpO1xuICBjb25zdCBlbnZpcm9ubWVudDogTm9kZUpTLlByb2Nlc3NFbnYgPSB7XG4gICAgLi4ubnBtUnVudGltZUVudmlyb25tZW50KCksXG4gICAgV09SS0JFTkNIX1NPVVJDRV9TRVRVUDogXCIxXCIsXG4gICAgQ09SRVBBQ0tfRU5BQkxFX05FVFdPUks6IFwiMFwiLFxuICAgIFdPUktCRU5DSF9QUk9KRUNUX1JPT1Q6IHJvb3QsXG4gICAgV09SS0JFTkNIX0RJU1RSSUJVVElPTl9ST09UOiByb290LFxuICAgIFdPUktCRU5DSF9FUEhFTUVSQUxfQ0hFQ0tPVVQ6IFwiMVwiLFxuICAgIFdPUktCRU5DSF9MT0NBTF9DT05GSUdfUk9PVDogcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0xPQ0FMX0NPTkZJR19ST09UID8/IHJvb3QsXG4gIH07XG4gIGZvciAoY29uc3Qga2V5IG9mIFtcIldPUktCRU5DSF9FWEVDVVRJTkdfU1BFQ1wiLCBcIldPUktCRU5DSF9MQVVOQ0hfQ0hBSU5cIl0pIFJlZmxlY3QuZGVsZXRlUHJvcGVydHkoZW52aXJvbm1lbnQsIGtleSk7XG4gIGNvbnN0IHJ1biA9IGFzeW5jIChjb21tYW5kOiBzdHJpbmcsIHBhcmFtZXRlcnM6IHN0cmluZ1tdLCBjd2QgPSByb290LCBlbnYgPSBlbnZpcm9ubWVudCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bk93bmVkQ2hpbGQoY29tbWFuZCwgcGFyYW1ldGVycywgeyBjd2QsIGVudiwgc2lnbmFsOiBjYW5jZWxsYXRpb24uc2lnbmFsIH0pO1xuICAgIGNvbnN0IGZhaWx1cmUgPSBwcm9jZXNzRmFpbHVyZShcImRldmVsb3BtZW50IHNldHVwXCIsIHJlc3VsdCk7XG4gICAgaWYgKGZhaWx1cmUpIHRocm93IGZhaWx1cmU7XG4gIH07XG4gIGxldCB0ZW1wb3Jhcnk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgbGV0IGluaXRpYWxMb2NhbFN0b3JlID0gZmFsc2U7XG4gIGNvbnN0IGNvbmZpZ3VyZWRWaXJ0dWFsU3RvcmUgPSBwcm9jZXNzLmVudi5QTlBNX0NPTkZJR19WSVJUVUFMX1NUT1JFX0RJUjtcbiAgY29uc3QgbG9jYWxWaXJ0dWFsU3RvcmUgPSBqb2luKHJvb3QsIFwibm9kZV9tb2R1bGVzLy5wbnBtXCIpO1xuICB0cnkge1xuICAgIGlmIChwcm92aWRlciAmJiAhZXhpc3RzU3luYyhqb2luKHJvb3QsIFwibm9kZV9tb2R1bGVzXCIpKSkge1xuICAgICAgY29uc3QgbWV0YWRhdGEgPSAoZGlyZWN0b3J5OiBzdHJpbmcpID0+XG4gICAgICAgIHJlY29yZChcbiAgICAgICAgICBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpcmVjdG9yeSwgXCJwYWNrYWdlLmpzb25cIiksIFwidXRmOFwiKSksXG4gICAgICAgICAgYCR7ZGlyZWN0b3J5fTogaW52YWxpZCBwYWNrYWdlIG1ldGFkYXRhYCxcbiAgICAgICAgKTtcbiAgICAgIGNvbnN0IGZyb20gPSBtZXRhZGF0YShwcm92aWRlciksXG4gICAgICAgIHRvID0gbWV0YWRhdGEocm9vdCk7XG4gICAgICBjb25zdCBtYXRjaGluZyA9XG4gICAgICAgIHJlYWRGaWxlU3luYyhqb2luKHByb3ZpZGVyLCBcInBucG0tbG9jay55YW1sXCIpKS5lcXVhbHMocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJwbnBtLWxvY2sueWFtbFwiKSkpICYmXG4gICAgICAgIFtcbiAgICAgICAgICBcImRlcGVuZGVuY2llc1wiLFxuICAgICAgICAgIFwiZGV2RGVwZW5kZW5jaWVzXCIsXG4gICAgICAgICAgXCJvcHRpb25hbERlcGVuZGVuY2llc1wiLFxuICAgICAgICAgIFwicGVlckRlcGVuZGVuY2llc1wiLFxuICAgICAgICAgIFwib3ZlcnJpZGVzXCIsXG4gICAgICAgICAgXCJyZXNvbHV0aW9uc1wiLFxuICAgICAgICAgIFwicG5wbVwiLFxuICAgICAgICAgIFwicGFja2FnZU1hbmFnZXJcIixcbiAgICAgICAgXS5ldmVyeSgoa2V5KSA9PiBpc0RlZXBTdHJpY3RFcXVhbChmcm9tW2tleV0sIHRvW2tleV0pKSAmJlxuICAgICAgICByZWFkRmlsZVN5bmMoam9pbihwcm92aWRlciwgXCJwbnBtLXdvcmtzcGFjZS55YW1sXCIpKS5lcXVhbHMocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJwbnBtLXdvcmtzcGFjZS55YW1sXCIpKSk7XG4gICAgICBpZiAobWF0Y2hpbmcpIHtcbiAgICAgICAgaWYgKCFwcmVwYXJlZERlcGVuZGVuY2llc01hdGNoKHByb3ZpZGVyKSlcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJUaGUgZGVwZW5kZW5jeSBwcm92aWRlciBkb2VzIG5vdCBtYXRjaCBpdHMgc291cmNlIHBpbnM7IHJ1biBzb3VyY2Ugc2V0dXAgaW4gdGhhdCBjaGVja291dFwiKTtcbiAgICAgICAgY29uc3QgeyBsaW5rRGVwZW5kZW5jaWVzIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2xpbmstZGVwZW5kZW5jaWVzLm10c1wiKTtcbiAgICAgICAgbGlua0RlcGVuZGVuY2llcyhqb2luKHByb3ZpZGVyLCBcIm5vZGVfbW9kdWxlc1wiKSwgam9pbihyb290LCBcIm5vZGVfbW9kdWxlc1wiKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGF3YWl0IHJ1bihcbiAgICAgICAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgICAgICBbXG4gICAgICAgICAgICAgIGpvaW4ocHJvdmlkZXIsIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgICAgICAgIFwicGFja2FnZS1tYW5hZ2VyLWV4ZWNcIixcbiAgICAgICAgICAgICAgXCItLVwiLFxuICAgICAgICAgICAgICBcImluc3RhbGxcIixcbiAgICAgICAgICAgICAgXCItLW9mZmxpbmVcIixcbiAgICAgICAgICAgICAgXCItLWZyb3plbi1sb2NrZmlsZVwiLFxuICAgICAgICAgICAgICBcIi0taWdub3JlLXNjcmlwdHNcIixcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICByb290LFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICAuLi5lbnZpcm9ubWVudCxcbiAgICAgICAgICAgICAgV09SS0JFTkNIX0RJU1RSSUJVVElPTl9ST09UOiBwcm92aWRlcixcbiAgICAgICAgICAgICAgV09SS0JFTkNIX0xPQ0FMX0NPTkZJR19ST09UOiBwcm92aWRlcixcbiAgICAgICAgICAgICAgV09SS0JFTkNIX09GRkxJTkU6IFwiMVwiLFxuICAgICAgICAgICAgICBXT1JLQkVOQ0hfU1RPUkFHRV9QUk9KRUNUOiB1bmRlZmluZWQsXG4gICAgICAgICAgICAgIFBOUE1fQ09ORklHX1NUT1JFX0RJUjogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICBQTlBNX0NPTkZJR19WSVJUVUFMX1NUT1JFX0RJUjogdW5kZWZpbmVkLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICApO1xuICAgICAgICB9IGNhdGNoIChjYXVzZSkge1xuICAgICAgICAgIGNhbmNlbGxhdGlvbi5zaWduYWwudGhyb3dJZkFib3J0ZWQoKTtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJUaGUgc3RhZ2VkIGRlcGVuZGVuY3kgaW5wdXRzIGFyZSB1bmF2YWlsYWJsZS4gUnVuICd3b3JrYmVuY2ggcHJlcGFyZSAtLXN0YWdlZCcuXCIsIHsgY2F1c2UgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgcHJlcGFyZWQgPSBwcmVwYXJlZERlcGVuZGVuY2llc01hdGNoKHJvb3QpO1xuICAgIGlmIChcbiAgICAgICFwcmVwYXJlZCAmJlxuICAgICAgW1wibm9kZV9tb2R1bGVzXCIsIFwibm9kZV9tb2R1bGVzLy5tb2R1bGVzLnlhbWxcIl0uc29tZSgocGF0aCkgPT5cbiAgICAgICAgbHN0YXRTeW5jKGpvaW4ocm9vdCwgcGF0aCksIHsgdGhyb3dJZk5vRW50cnk6IGZhbHNlIH0pPy5pc1N5bWJvbGljTGluaygpLFxuICAgICAgKVxuICAgIClcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJUaGUgbGlua2VkIGRlcGVuZGVuY3kgcHJvdmlkZXIgbm8gbG9uZ2VyIG1hdGNoZXMgaXRzIHNvdXJjZSBwaW5zOyByZXBhaXIgdGhlIHByb3ZpZGVyIGJlZm9yZSBydW5uaW5nIHNvdXJjZSBzZXR1cFwiLFxuICAgICAgKTtcbiAgICBjb25zdCBvZmZsaW5lID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX09GRkxJTkUgPT09IFwiMVwiO1xuICAgIGNvbnN0IGRpc3RyaWJ1dGlvbiA9IHJlc29sdmUocHJvY2Vzcy5lbnYuV09SS0JFTkNIX0RJU1RSSUJVVElPTl9ST09UID8/IHJvb3QpO1xuICAgIGNvbnN0IGJ1bmRsZWRJbnN0YWxsZXIgPSAhbGlmZWN5Y2xlICYmICF2YWx1ZXNbXCJidWlsZC1vbmx5XCJdICYmIGV4aXN0c1N5bmMoam9pbihkaXN0cmlidXRpb24sIFwiYnVuZGxlL21haW4uY2pzXCIpKTtcbiAgICBjb25zdCBtYW5hZ2VkID1cbiAgICAgIG9mZmxpbmUgJiZcbiAgICAgICFwcmVwYXJlZCAmJlxuICAgICAgYnVuZGxlZEluc3RhbGxlciAmJlxuICAgICAgKGF3YWl0IGltcG9ydChcIi4uL2FwcC9zcmMvY29yZS9leGVjdXRpb24vZW52aXJvbm1lbnRzL21hbmFnZWQtaW5wdXRzLnRzXCIpKS5tYW5hZ2VkSW5wdXRSZXBvc2l0b3J5KHJvb3QpXG4gICAgICAgID8uZGVjbGFyYXRpb24ucmVnaXN0cnk7XG4gICAgY29uc3QgY2FjaGVkU3RvcmUgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQ0FDSEVfSE9NRSAmJiBqb2luKHByb2Nlc3MuZW52LldPUktCRU5DSF9DQUNIRV9IT01FLCBcImRvd25sb2Fkcy9wbnBtXCIpO1xuICAgIC8vIFJlY3JlYXRlIGEgZnJlc2ggY2hlY2tvdXQncyBsaW5rcyBmcm9tIHRoZSBsb2NrZWQgcGFja2FnZSBzdG9yZSB0cmFuc2ZlcnJlZCBieSBwcmVwYXJhdGlvbi5cbiAgICBjb25zdCBuYXRpdmVTdG9yZSA9XG4gICAgICBvZmZsaW5lICYmXG4gICAgICAhcHJlcGFyZWQgJiZcbiAgICAgIGJ1bmRsZWRJbnN0YWxsZXIgJiZcbiAgICAgICFtYW5hZ2VkICYmXG4gICAgICB2YWx1ZXNbXCJyZXVzZS1wcmVwYXJlZFwiXSAmJlxuICAgICAgY2FjaGVkU3RvcmUgJiZcbiAgICAgIGV4aXN0c1N5bmMoY2FjaGVkU3RvcmUpXG4gICAgICAgID8gY2FjaGVkU3RvcmVcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgaWYgKG9mZmxpbmUgJiYgIXByZXBhcmVkICYmICFtYW5hZ2VkICYmICFuYXRpdmVTdG9yZSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJTb3VyY2UgZGVwZW5kZW5jaWVzIGFyZSBub3QgcHJlcGFyZWQ7IHJ1biBzb3VyY2Ugc2V0dXAgb25saW5lIG9yIHN1cHBseSBtYXRjaGluZyBwcmVwYXJlZCBkZXBlbmRlbmNpZXNcIixcbiAgICAgICk7XG4gICAgaWYgKCghb2ZmbGluZSB8fCBtYW5hZ2VkIHx8IG5hdGl2ZVN0b3JlKSAmJiBidW5kbGVkSW5zdGFsbGVyICYmICEodmFsdWVzW1wicmV1c2UtcHJlcGFyZWRcIl0gJiYgcHJlcGFyZWQpKSB7XG4gICAgICBhd2FpdCBydW4oXG4gICAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIFtcbiAgICAgICAgICBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgICBcInBhY2thZ2UtbWFuYWdlci1leGVjXCIsXG4gICAgICAgICAgXCItLVwiLFxuICAgICAgICAgIFwiaW5zdGFsbFwiLFxuICAgICAgICAgIFwiLS1mcm96ZW4tbG9ja2ZpbGVcIixcbiAgICAgICAgICBcIi0taWdub3JlLXNjcmlwdHNcIixcbiAgICAgICAgICAuLi4obmF0aXZlU3RvcmUgPyBbXCItLW9mZmxpbmVcIiwgXCItLXN0b3JlLWRpclwiLCBuYXRpdmVTdG9yZV0gOiBbXSksXG4gICAgICAgIF0sXG4gICAgICAgIHJvb3QsXG4gICAgICAgIHtcbiAgICAgICAgICAuLi5lbnZpcm9ubWVudCxcbiAgICAgICAgICBXT1JLQkVOQ0hfRElTVFJJQlVUSU9OX1JPT1Q6IGRpc3RyaWJ1dGlvbixcbiAgICAgICAgICAuLi4obmF0aXZlU3RvcmUgPyB7IFdPUktCRU5DSF9QUkVQQVJFRDogXCIxXCIgfSA6IHt9KSxcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfSBlbHNlIGlmICghcHJlcGFyZWQpIHtcbiAgICAgIGNvbnN0IG5wbSA9IG5wbUNvbW1hbmQoKTtcbiAgICAgIGNvbnN0IG1hbmFnZXIgPSBqb2luKHJvb3QsIFwic2NyaXB0cy9wYWNrYWdlLW1hbmFnZXJcIik7XG4gICAgICBjb25zdCBtYW5pZmVzdCA9IHJlY29yZChKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIFwicGFja2FnZS5qc29uXCIpLCBcInV0ZjhcIikpLCBcIkludmFsaWQgcGFja2FnZSBtZXRhZGF0YVwiKTtcbiAgICAgIGNvbnN0IGxvY2sgPSByZWNvcmQoXG4gICAgICAgIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4obWFuYWdlciwgXCJwYWNrYWdlLWxvY2suanNvblwiKSwgXCJ1dGY4XCIpKSxcbiAgICAgICAgXCJJbnZhbGlkIHBhY2thZ2UtbWFuYWdlciBsb2NrXCIsXG4gICAgICApO1xuICAgICAgY29uc3QgcGFja2FnZXMgPSByZWNvcmQobG9jay5wYWNrYWdlcywgXCJNaXNzaW5nIGJvb3RzdHJhcCBwYWNrYWdlc1wiKTtcbiAgICAgIGNvbnN0IHNlbGVjdGVkID0gcmVjb3JkKHBhY2thZ2VzW1wibm9kZV9tb2R1bGVzL3BucG1cIl0sIFwiTWlzc2luZyBsb2NrZWQgcGFja2FnZSBtYW5hZ2VyXCIpO1xuICAgICAgaWYgKFxuICAgICAgICBsb2NrLmxvY2tmaWxlVmVyc2lvbiAhPT0gMyB8fFxuICAgICAgICBgcG5wbUAke3N0cmluZyhzZWxlY3RlZC52ZXJzaW9uLCBcIk1pc3NpbmcgcGFja2FnZS1tYW5hZ2VyIHZlcnNpb25cIil9YCAhPT0gbWFuaWZlc3QucGFja2FnZU1hbmFnZXJcbiAgICAgIClcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiVGhlIHBhY2thZ2UtbWFuYWdlciBib290c3RyYXAgbG9jayBtdXN0IG1hdGNoIHBhY2thZ2UuanNvblwiKTtcbiAgICAgIGZvciAoY29uc3QgW3BhdGgsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwYWNrYWdlcykpIHtcbiAgICAgICAgaWYgKCFwYXRoKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgZW50cnkgPSByZWNvcmQodmFsdWUsIGBJbnZhbGlkIGJvb3RzdHJhcCBwYWNrYWdlICR7cGF0aH1gKTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHR5cGVvZiBlbnRyeS5yZXNvbHZlZCAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAgICFlbnRyeS5yZXNvbHZlZC5zdGFydHNXaXRoKFwiaHR0cHM6Ly9cIikgfHxcbiAgICAgICAgICB0eXBlb2YgZW50cnkuaW50ZWdyaXR5ICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgICAgIS9ec2hhKD86MjU2fDM4NHw1MTIpLVtBLVphLXowLTkrL10rPXswLDJ9JC8udGVzdChlbnRyeS5pbnRlZ3JpdHkpXG4gICAgICAgIClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJCb290c3RyYXAgcGFja2FnZXMgcmVxdWlyZSBIVFRQUyBhbmQgc3Ryb25nIGludGVncml0eSBoYXNoZXNcIik7XG4gICAgICB9XG4gICAgICBhd2FpdCBydW4obnBtLmNvbW1hbmQsIFtcbiAgICAgICAgLi4ubnBtLnByZWZpeCxcbiAgICAgICAgXCJjaVwiLFxuICAgICAgICBcIi0tcHJlZml4XCIsXG4gICAgICAgIG1hbmFnZXIsXG4gICAgICAgIFwiLS1pZ25vcmUtc2NyaXB0c1wiLFxuICAgICAgICBcIi0taW5jbHVkZT1vcHRpb25hbFwiLFxuICAgICAgICBcIi0tbm8tYXVkaXRcIixcbiAgICAgICAgXCItLW5vLWZ1bmRcIixcbiAgICAgIF0pO1xuICAgICAgYXdhaXQgcnVuKG5wbS5jb21tYW5kLCBbLi4ubnBtLnByZWZpeCwgXCJhdWRpdFwiLCBcInNpZ25hdHVyZXNcIiwgXCItLXByZWZpeFwiLCBtYW5hZ2VyXSk7XG4gICAgICB0ZW1wb3JhcnkgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIndvcmtiZW5jaC1zb3VyY2Utc2V0dXAtXCIpKTtcbiAgICAgIGNvbnN0IHJlcGxhY2UgPSBleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXNcIikpO1xuICAgICAgaWYgKHJlcGxhY2UgJiYgbHN0YXRTeW5jKGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXNcIikpLmlzU3ltYm9saWNMaW5rKCkpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIlByZXNlcnZpbmcgYSBub2RlX21vZHVsZXMgbGluayB3aXRob3V0IHBucG0gbWV0YWRhdGE7IHByZXBhcmUgbWF0Y2hpbmcgZGVwZW5kZW5jaWVzIGJlZm9yZSBzb3VyY2Ugc2V0dXBcIixcbiAgICAgICAgKTtcbiAgICAgIGluaXRpYWxMb2NhbFN0b3JlID0gIWNvbmZpZ3VyZWRWaXJ0dWFsU3RvcmUgJiYgIWV4aXN0c1N5bmMobG9jYWxWaXJ0dWFsU3RvcmUpO1xuICAgICAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtcbiAgICAgICAgam9pbihtYW5hZ2VyLCBcIm5vZGVfbW9kdWxlcy9wbnBtL2Jpbi9wbnBtLm1qc1wiKSxcbiAgICAgICAgXCJpbnN0YWxsXCIsXG4gICAgICAgIFwiLS1mcm96ZW4tbG9ja2ZpbGVcIixcbiAgICAgICAgXCItLWlnbm9yZS1zY3JpcHRzXCIsXG4gICAgICAgIC4uLihyZXBsYWNlID8gW1wiLS1mb3JjZVwiXSA6IFtdKSxcbiAgICAgICAgXCItLXN0b3JlLWRpclwiLFxuICAgICAgICBwcm9jZXNzLmVudi5QTlBNX0NPTkZJR19TVE9SRV9ESVIgPz8gam9pbih0ZW1wb3JhcnksIFwic3RvcmVcIiksXG4gICAgICAgIFwiLS12aXJ0dWFsLXN0b3JlLWRpclwiLFxuICAgICAgICBjb25maWd1cmVkVmlydHVhbFN0b3JlID8/IGxvY2FsVmlydHVhbFN0b3JlLFxuICAgICAgXSk7XG4gICAgfVxuICAgIGlmICghcHJlcGFyZWQgJiYgIXByZXBhcmVkRGVwZW5kZW5jaWVzTWF0Y2gocm9vdCkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJQcmVwYXJlZCBzb3VyY2UgZGVwZW5kZW5jaWVzIGRvIG5vdCBtYXRjaCB0aGUgZGVjbGFyZWQgcGluc1wiKTtcbiAgICBpZiAodGVtcG9yYXJ5ICYmICFjb25maWd1cmVkVmlydHVhbFN0b3JlICYmICF2YWx1ZXNbXCJidWlsZC1vbmx5XCJdICYmICFsaWZlY3ljbGUpIHtcbiAgICAgIC8vIFRoZSBjb21waWxlcidzIGNoaWxkIHByb2Nlc3MgbXVzdCByZWxlYXNlIHRoZSBib290c3RyYXAgZXhlY3V0YWJsZSBiZWZvcmUgcG5wbSBjYW4gcmVwbGFjZSBpdCBvbiBXaW5kb3dzLlxuICAgICAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtqb2luKHJvb3QsIFwic2NyaXB0cy9zZXR1cC1kZXZlbG9wbWVudC5tanNcIiksIFwiLS1idWlsZC1vbmx5XCJdLCByb290LCB7XG4gICAgICAgIC4uLmVudmlyb25tZW50LFxuICAgICAgICBXT1JLQkVOQ0hfU09VUkNFX1NFVFVQOiB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbXG4gICAgICAgIGpvaW4ocm9vdCwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgXCJwYWNrYWdlLW1hbmFnZXItZXhlY1wiLFxuICAgICAgICBcIi0tXCIsXG4gICAgICAgIFwiaW5zdGFsbFwiLFxuICAgICAgICBcIi0tZnJvemVuLWxvY2tmaWxlXCIsXG4gICAgICAgIFwiLS1pZ25vcmUtc2NyaXB0c1wiLFxuICAgICAgXSk7XG4gICAgICBjb25zdCB7IHBhcnNlIH0gPSBhd2FpdCBpbXBvcnQoXCJ5YW1sXCIpO1xuICAgICAgY29uc3QgbW9kdWxlcyA9IHBhcnNlKHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIFwibm9kZV9tb2R1bGVzLy5tb2R1bGVzLnlhbWxcIiksIFwidXRmOFwiKSkgYXMge1xuICAgICAgICB2aXJ0dWFsU3RvcmVEaXI/OiBzdHJpbmc7XG4gICAgICB9O1xuICAgICAgaWYgKFxuICAgICAgICBpbml0aWFsTG9jYWxTdG9yZSAmJlxuICAgICAgICBtb2R1bGVzLnZpcnR1YWxTdG9yZURpciAmJlxuICAgICAgICByZXNvbHZlKHJlYWxwYXRoU3luYy5uYXRpdmUoam9pbihyb290LCBcIm5vZGVfbW9kdWxlc1wiKSksIG1vZHVsZXMudmlydHVhbFN0b3JlRGlyKSAhPT0gbG9jYWxWaXJ0dWFsU3RvcmUgJiZcbiAgICAgICAgZXhpc3RzU3luYyhsb2NhbFZpcnR1YWxTdG9yZSkgJiZcbiAgICAgICAgIWxzdGF0U3luYyhsb2NhbFZpcnR1YWxTdG9yZSkuaXNTeW1ib2xpY0xpbmsoKVxuICAgICAgKVxuICAgICAgICBybVN5bmMobG9jYWxWaXJ0dWFsU3RvcmUsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2pvaW4ocm9vdCwgXCJzY3JpcHRzL2J1aWxkLXRvb2xpbmcubXRzXCIpLCBcIi0tbWFpbnRhaW5lcnMtb25seVwiXSk7XG4gICAgICBjb25zdCB7IHJldXNlQnVuZGxlcyB9ID0gYXdhaXQgaW1wb3J0KFwiLi9idW5kbGUtY2FjaGUubXRzXCIpO1xuICAgICAgaWYgKCFyZXVzZUJ1bmRsZXMocm9vdCkpIHtcbiAgICAgICAgY29uc3QgeyBjb21waWxlQnVuZGxlcywgcHVibGlzaEJ1bmRsZXMgfSA9IGF3YWl0IGltcG9ydChcIi4vYnVuZGxlLWJ1aWxkLm1qc1wiKTtcbiAgICAgICAgY29uc3QgeyBjb2xsZWN0VG9vbGluZ0FydGlmYWN0cyB9ID0gYXdhaXQgaW1wb3J0KFwiLi9idWlsZC10b29saW5nLm10c1wiKTtcbiAgICAgICAgY29uc3QgeyB2ZXJpZnlSdW50aW1lRGVwZW5kZW5jaWVzIH0gPSBhd2FpdCBpbXBvcnQoXCIuL3J1bnRpbWUtZGVwZW5kZW5jaWVzLm1qc1wiKTtcbiAgICAgICAgY2FuY2VsbGF0aW9uLnNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiQnVpbGRpbmcgbG9jYWwgV29ya2JlbmNoIGJ1bmRsZXPigKZcIik7XG4gICAgICAgIGNvbnN0IGJ1bmRsZXMgPSBhd2FpdCBjb21waWxlQnVuZGxlcyhyb290LCBjYW5jZWxsYXRpb24uc2lnbmFsKTtcbiAgICAgICAgdmVyaWZ5UnVudGltZURlcGVuZGVuY2llcyh7IHJvb3QsIGFydGlmYWN0czogY29sbGVjdFRvb2xpbmdBcnRpZmFjdHMocm9vdCksIC4uLmJ1bmRsZXMgfSk7XG4gICAgICAgIHB1Ymxpc2hCdW5kbGVzKHJvb3QsIGJ1bmRsZXMpO1xuICAgICAgfVxuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICBjYW5jZWxsYXRpb24uY2xvc2UoKTtcbiAgICBpZiAodGVtcG9yYXJ5KSBybVN5bmModGVtcG9yYXJ5LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn1cblxuaWYgKGlzTWFpblNjcmlwdChpbXBvcnQubWV0YS51cmwpKSB7XG4gIGNvbnN0IHJvb3QgPSByZXNvbHZlKGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKSwgXCIuLlwiKTtcbiAgYXdhaXQgc2V0dXBEZXZlbG9wbWVudChyb290KS5jYXRjaCgoZXJyb3I6IHVua25vd24pID0+IHtcbiAgICBjb25zb2xlLmVycm9yKGB3b3JrYmVuY2g6ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfWApO1xuICAgIHByb2Nlc3MuZXhpdENvZGUgPSAxO1xuICB9KTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsU0FBUyxNQUFNLGVBQWU7QUFDdkMsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxZQUFZLGNBQWMsYUFBYSxRQUFRLFdBQVcsb0JBQW9CO0FBQ3ZGLFNBQVMsY0FBYztBQUN2QixTQUFTLG1CQUFtQixpQkFBaUI7QUFDN0MsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUyxlQUFlLDJCQUEyQjtBQUNuRCxTQUFTLHNCQUFzQjtBQUMvQixTQUFTLG9CQUFvQjtBQUM3QixTQUFTLFFBQVEsY0FBYztBQUUvQixTQUFTLGFBQWEsTUFBdUM7QUFDM0QsUUFBTSxZQUFZLGtCQUFrQixhQUFhLE1BQU0sTUFBTSxDQUFDO0FBQzlELGFBQVcsWUFBWSxXQUFXO0FBQ2hDLFVBQU0sQ0FBQyxLQUFLLElBQUksU0FBUztBQUN6QixRQUFJLE1BQU8sT0FBTTtBQUFBLEVBQ25CO0FBQ0Es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
