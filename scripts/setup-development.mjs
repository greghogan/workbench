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
    if (!lifecycle && !values["build-only"] && !(values["reuse-prepared"] && prepared) && existsSync(join(root, "bundle/main.cjs"))) {
      await run(process.execPath, [
        join(root, "bin/workbench.mjs"),
        "package-manager-exec",
        "--",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts"
      ]);
    } else if (!prepared) {
      if (process.env.WORKBENCH_OFFLINE === "1")
        throw new Error(
          "Source dependencies are not prepared; run source setup online or supply matching prepared dependencies"
        );
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
      initialLocalStore = !existsSync(join(root, "node_modules/.pnpm"));
      await run(process.execPath, [
        join(manager, "node_modules/pnpm/bin/pnpm.mjs"),
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        ...replace ? ["--force"] : [],
        "--store-dir",
        process.env.PNPM_CONFIG_STORE_DIR ?? join(temporary, "store"),
        "--virtual-store-dir",
        join(root, "node_modules/.pnpm")
      ]);
    }
    if (!prepared && !preparedDependenciesMatch(root))
      throw new Error("Prepared source dependencies do not match the declared pins");
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
    if (temporary && !values["build-only"] && !lifecycle) {
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
      const local = join(root, "node_modules/.pnpm");
      if (initialLocalStore && modules.virtualStoreDir && resolve(realpathSync.native(join(root, "node_modules")), modules.virtualStoreDir) !== local && existsSync(local) && !lstatSync(local).isSymbolicLink())
        rmSync(local, { recursive: true });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInNldHVwLWRldmVsb3BtZW50Lm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXNvbHZlLCBqb2luLCBkaXJuYW1lIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCBta2R0ZW1wU3luYywgcm1TeW5jLCBsc3RhdFN5bmMsIHJlYWxwYXRoU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgaXNEZWVwU3RyaWN0RXF1YWwsIHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IHBhcnNlQWxsRG9jdW1lbnRzIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9jb25maWd1cmF0aW9uL3J1bnRpbWUtcGFyc2Vycy5tanNcIjtcbmltcG9ydCB7IHJ1bk93bmVkQ2hpbGQsIHByb2Nlc3NDYW5jZWxsYXRpb24gfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL3J1bnRpbWUvb3duZWQtY2hpbGQubWpzXCI7XG5pbXBvcnQgeyBwcm9jZXNzRmFpbHVyZSB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS9wcm9jZXNzLW91dGNvbWUubWpzXCI7XG5pbXBvcnQgeyBpc01haW5TY3JpcHQgfSBmcm9tIFwiLi9zY3JpcHQtZW50cnkubWpzXCI7XG5pbXBvcnQgeyByZWNvcmQsIHN0cmluZyB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS92YWx1ZXMubWpzXCI7XG5cbmZ1bmN0aW9uIHBucG1Eb2N1bWVudChwYXRoOiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IGRvY3VtZW50cyA9IHBhcnNlQWxsRG9jdW1lbnRzKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpO1xuICBmb3IgKGNvbnN0IGRvY3VtZW50IG9mIGRvY3VtZW50cykge1xuICAgIGNvbnN0IFtlcnJvcl0gPSBkb2N1bWVudC5lcnJvcnM7XG4gICAgaWYgKGVycm9yKSB0aHJvdyBlcnJvcjtcbiAgfVxuICByZXR1cm4gcmVjb3JkKGRvY3VtZW50cy5hdCgtMSk/LnRvSlNPTigpLCBgJHtwYXRofTogaW52YWxpZCBwbnBtIG1ldGFkYXRhYCk7XG59XG5cbi8qKiBBIHByZXBhcmVkIHRyZWUgbXVzdCBtYXRjaCB0aGUgcHJvamVjdCBsb2NrLCBub3QganVzdCBjb250YWluIHRoZSBidWlsZCB0b29sLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByZXBhcmVkRGVwZW5kZW5jaWVzTWF0Y2gocm9vdDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IG1ldGFkYXRhID0gam9pbihyb290LCBcIm5vZGVfbW9kdWxlcy8ubW9kdWxlcy55YW1sXCIpO1xuICBpZiAoIWV4aXN0c1N5bmMobWV0YWRhdGEpIHx8ICFleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXMvZXNidWlsZFwiKSkpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgbWFuaWZlc3QgPSByZWNvcmQoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihyb290LCBcInBhY2thZ2UuanNvblwiKSwgXCJ1dGY4XCIpKSwgXCJJbnZhbGlkIHBhY2thZ2UgbWV0YWRhdGFcIik7XG4gIGNvbnN0IG1vZHVsZXMgPSBwbnBtRG9jdW1lbnQobWV0YWRhdGEpO1xuICBpZiAobW9kdWxlcy5wYWNrYWdlTWFuYWdlciAhPT0gbWFuaWZlc3QucGFja2FnZU1hbmFnZXIgfHwgdHlwZW9mIG1vZHVsZXMudmlydHVhbFN0b3JlRGlyICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGluc3RhbGxlZCA9IGpvaW4ocmVzb2x2ZShkaXJuYW1lKHJlYWxwYXRoU3luYy5uYXRpdmUobWV0YWRhdGEpKSwgbW9kdWxlcy52aXJ0dWFsU3RvcmVEaXIpLCBcImxvY2sueWFtbFwiKTtcbiAgaWYgKCFleGlzdHNTeW5jKGluc3RhbGxlZCkpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgZXhwZWN0ZWQgPSBwbnBtRG9jdW1lbnQoam9pbihyb290LCBcInBucG0tbG9jay55YW1sXCIpKTtcbiAgaWYgKCFpc0RlZXBTdHJpY3RFcXVhbChleHBlY3RlZCwgcG5wbURvY3VtZW50KGluc3RhbGxlZCkpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGhvb2sgPSBqb2luKHJvb3QsIFwiLnBucG1maWxlLmNqc1wiKTtcbiAgY29uc3QgY2hlY2tzdW0gPSBleGlzdHNTeW5jKGhvb2spXG4gICAgPyBgc2hhMjU2LSR7Y3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUocmVhZEZpbGVTeW5jKGhvb2spKS5kaWdlc3QoXCJiYXNlNjRcIil9YFxuICAgIDogdW5kZWZpbmVkO1xuICBpZiAoZXhwZWN0ZWQucG5wbWZpbGVDaGVja3N1bSAhPT0gY2hlY2tzdW0pIHJldHVybiBmYWxzZTtcbiAgY29uc3QgaW1wb3J0ZXIgPSByZWNvcmQocmVjb3JkKGV4cGVjdGVkLmltcG9ydGVycywgXCJNaXNzaW5nIHBucG0gaW1wb3J0ZXJzXCIpW1wiLlwiXSwgXCJNaXNzaW5nIHByb2plY3QgaW1wb3J0ZXJcIik7XG4gIGZvciAoY29uc3Qga2luZCBvZiBbXCJkZXBlbmRlbmNpZXNcIiwgXCJkZXZEZXBlbmRlbmNpZXNcIiwgXCJvcHRpb25hbERlcGVuZGVuY2llc1wiXSkge1xuICAgIGNvbnN0IGRlY2xhcmVkID0gcmVjb3JkKG1hbmlmZXN0W2tpbmRdID8/IHt9LCBcIkludmFsaWQgZGVjbGFyZWQgZGVwZW5kZW5jaWVzXCIpO1xuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVjb3JkKGltcG9ydGVyW2tpbmRdID8/IHt9LCBcIkludmFsaWQgaW5zdGFsbGVkIGRlcGVuZGVuY2llc1wiKTtcbiAgICBpZiAoIWlzRGVlcFN0cmljdEVxdWFsKE9iamVjdC5rZXlzKGRlY2xhcmVkKS5zb3J0KCksIE9iamVjdC5rZXlzKHNlbGVjdGVkKS5zb3J0KCkpKSByZXR1cm4gZmFsc2U7XG4gICAgZm9yIChjb25zdCBbbmFtZSwgc3BlY2lmaWVyXSBvZiBPYmplY3QuZW50cmllcyhkZWNsYXJlZCkpXG4gICAgICBpZiAocmVjb3JkKHNlbGVjdGVkW25hbWVdLCBcIkludmFsaWQgaW5zdGFsbGVkIGRlcGVuZGVuY3lcIikuc3BlY2lmaWVyICE9PSBzcGVjaWZpZXIpIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqIFNvdXJjZSBpbnN0YWxsYXRpb24gYnVpbGRzIGRpc3Bvc2FibGUgYnVuZGxlcyBiZWZvcmUgaW52b2tpbmcgdGhlIFdvcmtiZW5jaCBDTEkuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2V0dXBEZXZlbG9wbWVudChyb290OiBzdHJpbmcsIGFyZ3MgPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKHByb2Nlc3MuZW52LldPUktCRU5DSF9TT1VSQ0VfU0VUVVAgPT09IFwiMVwiKSByZXR1cm47XG4gIGNvbnN0IHsgdmFsdWVzIH0gPSBwYXJzZUFyZ3Moe1xuICAgIGFyZ3MsXG4gICAgc3RyaWN0OiB0cnVlLFxuICAgIG9wdGlvbnM6IHtcbiAgICAgIGRlcGVuZGVuY2llczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICBcImJ1aWxkLW9ubHlcIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICAgICAgXCJyZXVzZS1wcmVwYXJlZFwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gICAgICBcInZlcmlmeS1wcmVwYXJlZFwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gICAgfSxcbiAgfSk7XG4gIGlmICh2YWx1ZXNbXCJ2ZXJpZnktcHJlcGFyZWRcIl0gfHwgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NIRUNLX1NDT1BFRCA9PT0gXCIxXCIpIHtcbiAgICBpZiAoIXByZXBhcmVkRGVwZW5kZW5jaWVzTWF0Y2gocm9vdCkpIHRocm93IG5ldyBFcnJvcihcIlByZXBhcmUgdGhlIGxvY2tlZCBkZXBlbmRlbmNpZXMgYmVmb3JlIHJ1bm5pbmcgY2hlY2tzXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBsaWZlY3ljbGUgPSBwcm9jZXNzLmVudi5ucG1fbGlmZWN5Y2xlX2V2ZW50ID09PSBcInByZXBhcmVcIjtcbiAgY29uc3QgcGluID0gcmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCIubm9kZS12ZXJzaW9uXCIpLCBcInV0ZjhcIikudHJpbSgpO1xuICBpZiAoIXByb2Nlc3MuZmVhdHVyZXMudHlwZXNjcmlwdClcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFNvdXJjZSBzZXR1cCByZXF1aXJlcyBuYXRpdmUgVHlwZVNjcmlwdCBzdXBwb3J0OyB1c2UgdGhlIGRldmVsb3BtZW50IE5vZGUuanMgJHtwaW59YCk7XG4gIGNvbnN0IHsgbWluaW11bUNsaU5vZGUgfSA9IGF3YWl0IGltcG9ydChcIi4uL2FwcC9zcmMvY29yZS9kaXN0cmlidXRpb24vbm9kZS1ydW50aW1lcy5tdHNcIik7XG4gIGNvbnN0IHJ1bm5pbmcgPSBwcm9jZXNzLnZlcnNpb25zLm5vZGUuc3BsaXQoXCIuXCIpLm1hcChOdW1iZXIpLFxuICAgIG1pbmltdW0gPSBtaW5pbXVtQ2xpTm9kZS5zcGxpdChcIi5cIikubWFwKE51bWJlcik7XG4gIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCAzOyBpbmRleCsrKSB7XG4gICAgaWYgKChydW5uaW5nW2luZGV4XSA/PyAwKSA+IChtaW5pbXVtW2luZGV4XSA/PyAwKSkgYnJlYWs7XG4gICAgaWYgKChydW5uaW5nW2luZGV4XSA/PyAwKSA8IChtaW5pbXVtW2luZGV4XSA/PyAwKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgU291cmNlIHNldHVwIHJlcXVpcmVzIE5vZGUuanMgJHttaW5pbXVtQ2xpTm9kZX0gb3IgbmV3ZXI7IHVzZSBkZXZlbG9wbWVudCBOb2RlLmpzICR7cGlufWApO1xuICB9XG4gIGlmICh2YWx1ZXNbXCJidWlsZC1vbmx5XCJdIHx8IGxpZmVjeWNsZSkge1xuICAgIGNvbnN0IHsgcmV1c2VCdW5kbGVzIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2J1bmRsZS1jYWNoZS5tdHNcIik7XG4gICAgaWYgKHJldXNlQnVuZGxlcyhyb290KSkgcmV0dXJuO1xuICAgIGlmICh2YWx1ZXMuZGVwZW5kZW5jaWVzICYmIHJldXNlQnVuZGxlcyhyZXNvbHZlKHZhbHVlcy5kZXBlbmRlbmNpZXMpLCByb290KSkgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHByb3ZpZGVyID0gdmFsdWVzLmRlcGVuZGVuY2llcyA/IHJlc29sdmUodmFsdWVzLmRlcGVuZGVuY2llcykgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IGNhbmNlbGxhdGlvbiA9IHByb2Nlc3NDYW5jZWxsYXRpb24oKTtcbiAgY29uc3QgeyBucG1Db21tYW5kLCBucG1SdW50aW1lRW52aXJvbm1lbnQgfSA9IGF3YWl0IGltcG9ydChcIi4uL2FwcC9zcmMvY29yZS90b29sY2hhaW5zL25wbS1jb21tYW5kLnRzXCIpO1xuICBjb25zdCBlbnZpcm9ubWVudDogTm9kZUpTLlByb2Nlc3NFbnYgPSB7XG4gICAgLi4ubnBtUnVudGltZUVudmlyb25tZW50KCksXG4gICAgV09SS0JFTkNIX1NPVVJDRV9TRVRVUDogXCIxXCIsXG4gICAgQ09SRVBBQ0tfRU5BQkxFX05FVFdPUks6IFwiMFwiLFxuICAgIFdPUktCRU5DSF9QUk9KRUNUX1JPT1Q6IHJvb3QsXG4gICAgV09SS0JFTkNIX0RJU1RSSUJVVElPTl9ST09UOiByb290LFxuICAgIFdPUktCRU5DSF9FUEhFTUVSQUxfQ0hFQ0tPVVQ6IFwiMVwiLFxuICAgIFdPUktCRU5DSF9MT0NBTF9DT05GSUdfUk9PVDogcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0xPQ0FMX0NPTkZJR19ST09UID8/IHJvb3QsXG4gIH07XG4gIGZvciAoY29uc3Qga2V5IG9mIFtcIldPUktCRU5DSF9FWEVDVVRJTkdfU1BFQ1wiLCBcIldPUktCRU5DSF9MQVVOQ0hfQ0hBSU5cIl0pIFJlZmxlY3QuZGVsZXRlUHJvcGVydHkoZW52aXJvbm1lbnQsIGtleSk7XG4gIGNvbnN0IHJ1biA9IGFzeW5jIChjb21tYW5kOiBzdHJpbmcsIHBhcmFtZXRlcnM6IHN0cmluZ1tdLCBjd2QgPSByb290LCBlbnYgPSBlbnZpcm9ubWVudCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bk93bmVkQ2hpbGQoY29tbWFuZCwgcGFyYW1ldGVycywgeyBjd2QsIGVudiwgc2lnbmFsOiBjYW5jZWxsYXRpb24uc2lnbmFsIH0pO1xuICAgIGNvbnN0IGZhaWx1cmUgPSBwcm9jZXNzRmFpbHVyZShcImRldmVsb3BtZW50IHNldHVwXCIsIHJlc3VsdCk7XG4gICAgaWYgKGZhaWx1cmUpIHRocm93IGZhaWx1cmU7XG4gIH07XG4gIGxldCB0ZW1wb3Jhcnk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgbGV0IGluaXRpYWxMb2NhbFN0b3JlID0gZmFsc2U7XG4gIHRyeSB7XG4gICAgaWYgKHByb3ZpZGVyICYmICFleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXNcIikpKSB7XG4gICAgICBjb25zdCBtZXRhZGF0YSA9IChkaXJlY3Rvcnk6IHN0cmluZykgPT5cbiAgICAgICAgcmVjb3JkKFxuICAgICAgICAgIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBcInBhY2thZ2UuanNvblwiKSwgXCJ1dGY4XCIpKSxcbiAgICAgICAgICBgJHtkaXJlY3Rvcnl9OiBpbnZhbGlkIHBhY2thZ2UgbWV0YWRhdGFgLFxuICAgICAgICApO1xuICAgICAgY29uc3QgZnJvbSA9IG1ldGFkYXRhKHByb3ZpZGVyKSxcbiAgICAgICAgdG8gPSBtZXRhZGF0YShyb290KTtcbiAgICAgIGNvbnN0IG1hdGNoaW5nID1cbiAgICAgICAgcmVhZEZpbGVTeW5jKGpvaW4ocHJvdmlkZXIsIFwicG5wbS1sb2NrLnlhbWxcIikpLmVxdWFscyhyZWFkRmlsZVN5bmMoam9pbihyb290LCBcInBucG0tbG9jay55YW1sXCIpKSkgJiZcbiAgICAgICAgW1xuICAgICAgICAgIFwiZGVwZW5kZW5jaWVzXCIsXG4gICAgICAgICAgXCJkZXZEZXBlbmRlbmNpZXNcIixcbiAgICAgICAgICBcIm9wdGlvbmFsRGVwZW5kZW5jaWVzXCIsXG4gICAgICAgICAgXCJwZWVyRGVwZW5kZW5jaWVzXCIsXG4gICAgICAgICAgXCJvdmVycmlkZXNcIixcbiAgICAgICAgICBcInJlc29sdXRpb25zXCIsXG4gICAgICAgICAgXCJwbnBtXCIsXG4gICAgICAgICAgXCJwYWNrYWdlTWFuYWdlclwiLFxuICAgICAgICBdLmV2ZXJ5KChrZXkpID0+IGlzRGVlcFN0cmljdEVxdWFsKGZyb21ba2V5XSwgdG9ba2V5XSkpICYmXG4gICAgICAgIHJlYWRGaWxlU3luYyhqb2luKHByb3ZpZGVyLCBcInBucG0td29ya3NwYWNlLnlhbWxcIikpLmVxdWFscyhyZWFkRmlsZVN5bmMoam9pbihyb290LCBcInBucG0td29ya3NwYWNlLnlhbWxcIikpKTtcbiAgICAgIGlmIChtYXRjaGluZykge1xuICAgICAgICBpZiAoIXByZXBhcmVkRGVwZW5kZW5jaWVzTWF0Y2gocHJvdmlkZXIpKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIlRoZSBkZXBlbmRlbmN5IHByb3ZpZGVyIGRvZXMgbm90IG1hdGNoIGl0cyBzb3VyY2UgcGluczsgcnVuIHNvdXJjZSBzZXR1cCBpbiB0aGF0IGNoZWNrb3V0XCIpO1xuICAgICAgICBjb25zdCB7IGxpbmtEZXBlbmRlbmNpZXMgfSA9IGF3YWl0IGltcG9ydChcIi4vbGluay1kZXBlbmRlbmNpZXMubXRzXCIpO1xuICAgICAgICBsaW5rRGVwZW5kZW5jaWVzKGpvaW4ocHJvdmlkZXIsIFwibm9kZV9tb2R1bGVzXCIpLCBqb2luKHJvb3QsIFwibm9kZV9tb2R1bGVzXCIpKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgcnVuKFxuICAgICAgICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgam9pbihwcm92aWRlciwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgICAgICAgXCJwYWNrYWdlLW1hbmFnZXItZXhlY1wiLFxuICAgICAgICAgICAgICBcIi0tXCIsXG4gICAgICAgICAgICAgIFwiaW5zdGFsbFwiLFxuICAgICAgICAgICAgICBcIi0tb2ZmbGluZVwiLFxuICAgICAgICAgICAgICBcIi0tZnJvemVuLWxvY2tmaWxlXCIsXG4gICAgICAgICAgICAgIFwiLS1pZ25vcmUtc2NyaXB0c1wiLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIC4uLmVudmlyb25tZW50LFxuICAgICAgICAgICAgICBXT1JLQkVOQ0hfRElTVFJJQlVUSU9OX1JPT1Q6IHByb3ZpZGVyLFxuICAgICAgICAgICAgICBXT1JLQkVOQ0hfTE9DQUxfQ09ORklHX1JPT1Q6IHByb3ZpZGVyLFxuICAgICAgICAgICAgICBXT1JLQkVOQ0hfT0ZGTElORTogXCIxXCIsXG4gICAgICAgICAgICAgIFdPUktCRU5DSF9TVE9SQUdFX1BST0pFQ1Q6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgUE5QTV9DT05GSUdfU1RPUkVfRElSOiB1bmRlZmluZWQsXG4gICAgICAgICAgICAgIFBOUE1fQ09ORklHX1ZJUlRVQUxfU1RPUkVfRElSOiB1bmRlZmluZWQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICk7XG4gICAgICAgIH0gY2F0Y2ggKGNhdXNlKSB7XG4gICAgICAgICAgY2FuY2VsbGF0aW9uLnNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIlRoZSBzdGFnZWQgZGVwZW5kZW5jeSBpbnB1dHMgYXJlIHVuYXZhaWxhYmxlLiBSdW4gJ3dvcmtiZW5jaCBwcmVwYXJlIC0tc3RhZ2VkJy5cIiwgeyBjYXVzZSB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBwcmVwYXJlZCA9IHByZXBhcmVkRGVwZW5kZW5jaWVzTWF0Y2gocm9vdCk7XG4gICAgaWYgKFxuICAgICAgIXByZXBhcmVkICYmXG4gICAgICBbXCJub2RlX21vZHVsZXNcIiwgXCJub2RlX21vZHVsZXMvLm1vZHVsZXMueWFtbFwiXS5zb21lKChwYXRoKSA9PlxuICAgICAgICBsc3RhdFN5bmMoam9pbihyb290LCBwYXRoKSwgeyB0aHJvd0lmTm9FbnRyeTogZmFsc2UgfSk/LmlzU3ltYm9saWNMaW5rKCksXG4gICAgICApXG4gICAgKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIlRoZSBsaW5rZWQgZGVwZW5kZW5jeSBwcm92aWRlciBubyBsb25nZXIgbWF0Y2hlcyBpdHMgc291cmNlIHBpbnM7IHJlcGFpciB0aGUgcHJvdmlkZXIgYmVmb3JlIHJ1bm5pbmcgc291cmNlIHNldHVwXCIsXG4gICAgICApO1xuICAgIGlmIChcbiAgICAgICFsaWZlY3ljbGUgJiZcbiAgICAgICF2YWx1ZXNbXCJidWlsZC1vbmx5XCJdICYmXG4gICAgICAhKHZhbHVlc1tcInJldXNlLXByZXBhcmVkXCJdICYmIHByZXBhcmVkKSAmJlxuICAgICAgZXhpc3RzU3luYyhqb2luKHJvb3QsIFwiYnVuZGxlL21haW4uY2pzXCIpKVxuICAgICkge1xuICAgICAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtcbiAgICAgICAgam9pbihyb290LCBcImJpbi93b3JrYmVuY2gubWpzXCIpLFxuICAgICAgICBcInBhY2thZ2UtbWFuYWdlci1leGVjXCIsXG4gICAgICAgIFwiLS1cIixcbiAgICAgICAgXCJpbnN0YWxsXCIsXG4gICAgICAgIFwiLS1mcm96ZW4tbG9ja2ZpbGVcIixcbiAgICAgICAgXCItLWlnbm9yZS1zY3JpcHRzXCIsXG4gICAgICBdKTtcbiAgICB9IGVsc2UgaWYgKCFwcmVwYXJlZCkge1xuICAgICAgaWYgKHByb2Nlc3MuZW52LldPUktCRU5DSF9PRkZMSU5FID09PSBcIjFcIilcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiU291cmNlIGRlcGVuZGVuY2llcyBhcmUgbm90IHByZXBhcmVkOyBydW4gc291cmNlIHNldHVwIG9ubGluZSBvciBzdXBwbHkgbWF0Y2hpbmcgcHJlcGFyZWQgZGVwZW5kZW5jaWVzXCIsXG4gICAgICAgICk7XG4gICAgICBjb25zdCBucG0gPSBucG1Db21tYW5kKCk7XG4gICAgICBjb25zdCBtYW5hZ2VyID0gam9pbihyb290LCBcInNjcmlwdHMvcGFja2FnZS1tYW5hZ2VyXCIpO1xuICAgICAgY29uc3QgbWFuaWZlc3QgPSByZWNvcmQoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihyb290LCBcInBhY2thZ2UuanNvblwiKSwgXCJ1dGY4XCIpKSwgXCJJbnZhbGlkIHBhY2thZ2UgbWV0YWRhdGFcIik7XG4gICAgICBjb25zdCBsb2NrID0gcmVjb3JkKFxuICAgICAgICBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKG1hbmFnZXIsIFwicGFja2FnZS1sb2NrLmpzb25cIiksIFwidXRmOFwiKSksXG4gICAgICAgIFwiSW52YWxpZCBwYWNrYWdlLW1hbmFnZXIgbG9ja1wiLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHBhY2thZ2VzID0gcmVjb3JkKGxvY2sucGFja2FnZXMsIFwiTWlzc2luZyBib290c3RyYXAgcGFja2FnZXNcIik7XG4gICAgICBjb25zdCBzZWxlY3RlZCA9IHJlY29yZChwYWNrYWdlc1tcIm5vZGVfbW9kdWxlcy9wbnBtXCJdLCBcIk1pc3NpbmcgbG9ja2VkIHBhY2thZ2UgbWFuYWdlclwiKTtcbiAgICAgIGlmIChcbiAgICAgICAgbG9jay5sb2NrZmlsZVZlcnNpb24gIT09IDMgfHxcbiAgICAgICAgYHBucG1AJHtzdHJpbmcoc2VsZWN0ZWQudmVyc2lvbiwgXCJNaXNzaW5nIHBhY2thZ2UtbWFuYWdlciB2ZXJzaW9uXCIpfWAgIT09IG1hbmlmZXN0LnBhY2thZ2VNYW5hZ2VyXG4gICAgICApXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIlRoZSBwYWNrYWdlLW1hbmFnZXIgYm9vdHN0cmFwIGxvY2sgbXVzdCBtYXRjaCBwYWNrYWdlLmpzb25cIik7XG4gICAgICBmb3IgKGNvbnN0IFtwYXRoLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocGFja2FnZXMpKSB7XG4gICAgICAgIGlmICghcGF0aCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0gcmVjb3JkKHZhbHVlLCBgSW52YWxpZCBib290c3RyYXAgcGFja2FnZSAke3BhdGh9YCk7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0eXBlb2YgZW50cnkucmVzb2x2ZWQgIT09IFwic3RyaW5nXCIgfHxcbiAgICAgICAgICAhZW50cnkucmVzb2x2ZWQuc3RhcnRzV2l0aChcImh0dHBzOi8vXCIpIHx8XG4gICAgICAgICAgdHlwZW9mIGVudHJ5LmludGVncml0eSAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAgICEvXnNoYSg/OjI1NnwzODR8NTEyKS1bQS1aYS16MC05Ky9dKz17MCwyfSQvLnRlc3QoZW50cnkuaW50ZWdyaXR5KVxuICAgICAgICApXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQm9vdHN0cmFwIHBhY2thZ2VzIHJlcXVpcmUgSFRUUFMgYW5kIHN0cm9uZyBpbnRlZ3JpdHkgaGFzaGVzXCIpO1xuICAgICAgfVxuICAgICAgYXdhaXQgcnVuKG5wbS5jb21tYW5kLCBbXG4gICAgICAgIC4uLm5wbS5wcmVmaXgsXG4gICAgICAgIFwiY2lcIixcbiAgICAgICAgXCItLXByZWZpeFwiLFxuICAgICAgICBtYW5hZ2VyLFxuICAgICAgICBcIi0taWdub3JlLXNjcmlwdHNcIixcbiAgICAgICAgXCItLWluY2x1ZGU9b3B0aW9uYWxcIixcbiAgICAgICAgXCItLW5vLWF1ZGl0XCIsXG4gICAgICAgIFwiLS1uby1mdW5kXCIsXG4gICAgICBdKTtcbiAgICAgIGF3YWl0IHJ1bihucG0uY29tbWFuZCwgWy4uLm5wbS5wcmVmaXgsIFwiYXVkaXRcIiwgXCJzaWduYXR1cmVzXCIsIFwiLS1wcmVmaXhcIiwgbWFuYWdlcl0pO1xuICAgICAgdGVtcG9yYXJ5ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJ3b3JrYmVuY2gtc291cmNlLXNldHVwLVwiKSk7XG4gICAgICBjb25zdCByZXBsYWNlID0gZXhpc3RzU3luYyhqb2luKHJvb3QsIFwibm9kZV9tb2R1bGVzXCIpKTtcbiAgICAgIGlmIChyZXBsYWNlICYmIGxzdGF0U3luYyhqb2luKHJvb3QsIFwibm9kZV9tb2R1bGVzXCIpKS5pc1N5bWJvbGljTGluaygpKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJQcmVzZXJ2aW5nIGEgbm9kZV9tb2R1bGVzIGxpbmsgd2l0aG91dCBwbnBtIG1ldGFkYXRhOyBwcmVwYXJlIG1hdGNoaW5nIGRlcGVuZGVuY2llcyBiZWZvcmUgc291cmNlIHNldHVwXCIsXG4gICAgICAgICk7XG4gICAgICBpbml0aWFsTG9jYWxTdG9yZSA9ICFleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXMvLnBucG1cIikpO1xuICAgICAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtcbiAgICAgICAgam9pbihtYW5hZ2VyLCBcIm5vZGVfbW9kdWxlcy9wbnBtL2Jpbi9wbnBtLm1qc1wiKSxcbiAgICAgICAgXCJpbnN0YWxsXCIsXG4gICAgICAgIFwiLS1mcm96ZW4tbG9ja2ZpbGVcIixcbiAgICAgICAgXCItLWlnbm9yZS1zY3JpcHRzXCIsXG4gICAgICAgIC4uLihyZXBsYWNlID8gW1wiLS1mb3JjZVwiXSA6IFtdKSxcbiAgICAgICAgXCItLXN0b3JlLWRpclwiLFxuICAgICAgICBwcm9jZXNzLmVudi5QTlBNX0NPTkZJR19TVE9SRV9ESVIgPz8gam9pbih0ZW1wb3JhcnksIFwic3RvcmVcIiksXG4gICAgICAgIFwiLS12aXJ0dWFsLXN0b3JlLWRpclwiLFxuICAgICAgICBqb2luKHJvb3QsIFwibm9kZV9tb2R1bGVzLy5wbnBtXCIpLFxuICAgICAgXSk7XG4gICAgfVxuICAgIGlmICghcHJlcGFyZWQgJiYgIXByZXBhcmVkRGVwZW5kZW5jaWVzTWF0Y2gocm9vdCkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJQcmVwYXJlZCBzb3VyY2UgZGVwZW5kZW5jaWVzIGRvIG5vdCBtYXRjaCB0aGUgZGVjbGFyZWQgcGluc1wiKTtcbiAgICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2pvaW4ocm9vdCwgXCJzY3JpcHRzL2J1aWxkLXRvb2xpbmcubXRzXCIpLCBcIi0tbWFpbnRhaW5lcnMtb25seVwiXSk7XG4gICAgY29uc3QgeyByZXVzZUJ1bmRsZXMgfSA9IGF3YWl0IGltcG9ydChcIi4vYnVuZGxlLWNhY2hlLm10c1wiKTtcbiAgICBpZiAoIXJldXNlQnVuZGxlcyhyb290KSkge1xuICAgICAgY29uc3QgeyBjb21waWxlQnVuZGxlcywgcHVibGlzaEJ1bmRsZXMgfSA9IGF3YWl0IGltcG9ydChcIi4vYnVuZGxlLWJ1aWxkLm1qc1wiKTtcbiAgICAgIGNvbnN0IHsgY29sbGVjdFRvb2xpbmdBcnRpZmFjdHMgfSA9IGF3YWl0IGltcG9ydChcIi4vYnVpbGQtdG9vbGluZy5tdHNcIik7XG4gICAgICBjb25zdCB7IHZlcmlmeVJ1bnRpbWVEZXBlbmRlbmNpZXMgfSA9IGF3YWl0IGltcG9ydChcIi4vcnVudGltZS1kZXBlbmRlbmNpZXMubWpzXCIpO1xuICAgICAgY2FuY2VsbGF0aW9uLnNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICAgICAgY29uc29sZS5lcnJvcihcIkJ1aWxkaW5nIGxvY2FsIFdvcmtiZW5jaCBidW5kbGVz4oCmXCIpO1xuICAgICAgY29uc3QgYnVuZGxlcyA9IGF3YWl0IGNvbXBpbGVCdW5kbGVzKHJvb3QsIGNhbmNlbGxhdGlvbi5zaWduYWwpO1xuICAgICAgdmVyaWZ5UnVudGltZURlcGVuZGVuY2llcyh7IHJvb3QsIGFydGlmYWN0czogY29sbGVjdFRvb2xpbmdBcnRpZmFjdHMocm9vdCksIC4uLmJ1bmRsZXMgfSk7XG4gICAgICBwdWJsaXNoQnVuZGxlcyhyb290LCBidW5kbGVzKTtcbiAgICB9XG4gICAgaWYgKHRlbXBvcmFyeSAmJiAhdmFsdWVzW1wiYnVpbGQtb25seVwiXSAmJiAhbGlmZWN5Y2xlKSB7XG4gICAgICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW1xuICAgICAgICBqb2luKHJvb3QsIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgIFwicGFja2FnZS1tYW5hZ2VyLWV4ZWNcIixcbiAgICAgICAgXCItLVwiLFxuICAgICAgICBcImluc3RhbGxcIixcbiAgICAgICAgXCItLWZyb3plbi1sb2NrZmlsZVwiLFxuICAgICAgICBcIi0taWdub3JlLXNjcmlwdHNcIixcbiAgICAgIF0pO1xuICAgICAgY29uc3QgeyBwYXJzZSB9ID0gYXdhaXQgaW1wb3J0KFwieWFtbFwiKTtcbiAgICAgIGNvbnN0IG1vZHVsZXMgPSBwYXJzZShyZWFkRmlsZVN5bmMoam9pbihyb290LCBcIm5vZGVfbW9kdWxlcy8ubW9kdWxlcy55YW1sXCIpLCBcInV0ZjhcIikpIGFzIHtcbiAgICAgICAgdmlydHVhbFN0b3JlRGlyPzogc3RyaW5nO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IGxvY2FsID0gam9pbihyb290LCBcIm5vZGVfbW9kdWxlcy8ucG5wbVwiKTtcbiAgICAgIGlmIChcbiAgICAgICAgaW5pdGlhbExvY2FsU3RvcmUgJiZcbiAgICAgICAgbW9kdWxlcy52aXJ0dWFsU3RvcmVEaXIgJiZcbiAgICAgICAgcmVzb2x2ZShyZWFscGF0aFN5bmMubmF0aXZlKGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXNcIikpLCBtb2R1bGVzLnZpcnR1YWxTdG9yZURpcikgIT09IGxvY2FsICYmXG4gICAgICAgIGV4aXN0c1N5bmMobG9jYWwpICYmXG4gICAgICAgICFsc3RhdFN5bmMobG9jYWwpLmlzU3ltYm9saWNMaW5rKClcbiAgICAgIClcbiAgICAgICAgcm1TeW5jKGxvY2FsLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgY2FuY2VsbGF0aW9uLmNsb3NlKCk7XG4gICAgaWYgKHRlbXBvcmFyeSkgcm1TeW5jKHRlbXBvcmFyeSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59XG5cbmlmIChpc01haW5TY3JpcHQoaW1wb3J0Lm1ldGEudXJsKSkge1xuICBjb25zdCByb290ID0gcmVzb2x2ZShkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSksIFwiLi5cIik7XG4gIGF3YWl0IHNldHVwRGV2ZWxvcG1lbnQocm9vdCkuY2F0Y2goKGVycm9yOiB1bmtub3duKSA9PiB7XG4gICAgY29uc29sZS5lcnJvcihgd29ya2JlbmNoOiAke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX1gKTtcbiAgICBwcm9jZXNzLmV4aXRDb2RlID0gMTtcbiAgfSk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFNBQVMsTUFBTSxlQUFlO0FBQ3ZDLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsWUFBWSxjQUFjLGFBQWEsUUFBUSxXQUFXLG9CQUFvQjtBQUN2RixTQUFTLGNBQWM7QUFDdkIsU0FBUyxtQkFBbUIsaUJBQWlCO0FBQzdDLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMseUJBQXlCO0FBQ2xDLFNBQVMsZUFBZSwyQkFBMkI7QUFDbkQsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxRQUFRLGNBQWM7QUFFL0IsU0FBUyxhQUFhLE1BQXVDO0FBQzNELFFBQU0sWUFBWSxrQkFBa0IsYUFBYSxNQUFNLE1BQU0sQ0FBQztBQUM5RCxhQUFXLFlBQVksV0FBVztBQUNoQyxVQUFNLENB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
