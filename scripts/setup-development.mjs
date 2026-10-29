// Generated from setup-development.mts; edit the TypeScript source.
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdtempSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { parseAllDocuments } from "./runtime-parsers.mjs";
import { runOwnedChild, processCancellation } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { isMainScript } from "./script-entry.mjs";
import { record, string } from "./values.mjs";
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
  const installed = join(resolve(root, "node_modules", modules.virtualStoreDir), "lock.yaml");
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
    options: { dependencies: { type: "string" }, "build-only": { type: "boolean" } }
  });
  const lifecycle = process.env.npm_lifecycle_event === "prepare";
  const pin = readFileSync(join(root, ".node-version"), "utf8").trim();
  if (!process.features.typescript)
    throw new Error(`Source setup requires native TypeScript support; use the development Node.js ${pin}`);
  const { minimumCliNode } = await import("./node-runtimes.mts");
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
  const { npmCommand, npmRuntimeEnvironment } = await import("../src/npm-command.ts");
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
      if (!readFileSync(join(provider, "pnpm-lock.yaml")).equals(readFileSync(join(root, "pnpm-lock.yaml"))) || ![
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
        "overrides",
        "resolutions",
        "pnpm",
        "packageManager"
      ].every((key) => isDeepStrictEqual(from[key], to[key])) || !readFileSync(join(provider, "pnpm-workspace.yaml")).equals(readFileSync(join(root, "pnpm-workspace.yaml"))))
        throw new Error(
          "The staged dependency pins differ from the prepared checkout; prepare their locked dependencies before checking this snapshot"
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
        "--ignore-scripts"
      ]);
    } else if (!preparedDependenciesMatch(root)) {
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
    if (!preparedDependenciesMatch(root))
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
      if (initialLocalStore && modules.virtualStoreDir && resolve(root, "node_modules", modules.virtualStoreDir) !== local && existsSync(local) && !lstatSync(local).isSymbolicLink())
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInNldHVwLWRldmVsb3BtZW50Lm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXNvbHZlLCBqb2luLCBkaXJuYW1lIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCBta2R0ZW1wU3luYywgcm1TeW5jLCBsc3RhdFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGlzRGVlcFN0cmljdEVxdWFsLCBwYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBwYXJzZUFsbERvY3VtZW50cyB9IGZyb20gXCIuL3J1bnRpbWUtcGFyc2Vycy5tanNcIjtcbmltcG9ydCB7IHJ1bk93bmVkQ2hpbGQsIHByb2Nlc3NDYW5jZWxsYXRpb24gfSBmcm9tIFwiLi9vd25lZC1jaGlsZC5tanNcIjtcbmltcG9ydCB7IHByb2Nlc3NGYWlsdXJlIH0gZnJvbSBcIi4vcHJvY2Vzcy1vdXRjb21lLm1qc1wiO1xuaW1wb3J0IHsgaXNNYWluU2NyaXB0IH0gZnJvbSBcIi4vc2NyaXB0LWVudHJ5Lm1qc1wiO1xuaW1wb3J0IHsgcmVjb3JkLCBzdHJpbmcgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5cbmZ1bmN0aW9uIHBucG1Eb2N1bWVudChwYXRoOiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IGRvY3VtZW50cyA9IHBhcnNlQWxsRG9jdW1lbnRzKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpO1xuICBmb3IgKGNvbnN0IGRvY3VtZW50IG9mIGRvY3VtZW50cykge1xuICAgIGNvbnN0IFtlcnJvcl0gPSBkb2N1bWVudC5lcnJvcnM7XG4gICAgaWYgKGVycm9yKSB0aHJvdyBlcnJvcjtcbiAgfVxuICByZXR1cm4gcmVjb3JkKGRvY3VtZW50cy5hdCgtMSk/LnRvSlNPTigpLCBgJHtwYXRofTogaW52YWxpZCBwbnBtIG1ldGFkYXRhYCk7XG59XG5cbi8qKiBBIHByZXBhcmVkIHRyZWUgbXVzdCBtYXRjaCB0aGUgcHJvamVjdCBsb2NrLCBub3QganVzdCBjb250YWluIHRoZSBidWlsZCB0b29sLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByZXBhcmVkRGVwZW5kZW5jaWVzTWF0Y2gocm9vdDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IG1ldGFkYXRhID0gam9pbihyb290LCBcIm5vZGVfbW9kdWxlcy8ubW9kdWxlcy55YW1sXCIpO1xuICBpZiAoIWV4aXN0c1N5bmMobWV0YWRhdGEpIHx8ICFleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXMvZXNidWlsZFwiKSkpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgbWFuaWZlc3QgPSByZWNvcmQoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihyb290LCBcInBhY2thZ2UuanNvblwiKSwgXCJ1dGY4XCIpKSwgXCJJbnZhbGlkIHBhY2thZ2UgbWV0YWRhdGFcIik7XG4gIGNvbnN0IG1vZHVsZXMgPSBwbnBtRG9jdW1lbnQobWV0YWRhdGEpO1xuICBpZiAobW9kdWxlcy5wYWNrYWdlTWFuYWdlciAhPT0gbWFuaWZlc3QucGFja2FnZU1hbmFnZXIgfHwgdHlwZW9mIG1vZHVsZXMudmlydHVhbFN0b3JlRGlyICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGluc3RhbGxlZCA9IGpvaW4ocmVzb2x2ZShyb290LCBcIm5vZGVfbW9kdWxlc1wiLCBtb2R1bGVzLnZpcnR1YWxTdG9yZURpciksIFwibG9jay55YW1sXCIpO1xuICBpZiAoIWV4aXN0c1N5bmMoaW5zdGFsbGVkKSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBleHBlY3RlZCA9IHBucG1Eb2N1bWVudChqb2luKHJvb3QsIFwicG5wbS1sb2NrLnlhbWxcIikpO1xuICBpZiAoIWlzRGVlcFN0cmljdEVxdWFsKGV4cGVjdGVkLCBwbnBtRG9jdW1lbnQoaW5zdGFsbGVkKSkpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgaG9vayA9IGpvaW4ocm9vdCwgXCIucG5wbWZpbGUuY2pzXCIpO1xuICBjb25zdCBjaGVja3N1bSA9IGV4aXN0c1N5bmMoaG9vaylcbiAgICA/IGBzaGEyNTYtJHtjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShyZWFkRmlsZVN5bmMoaG9vaykpLmRpZ2VzdChcImJhc2U2NFwiKX1gXG4gICAgOiB1bmRlZmluZWQ7XG4gIGlmIChleHBlY3RlZC5wbnBtZmlsZUNoZWNrc3VtICE9PSBjaGVja3N1bSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBpbXBvcnRlciA9IHJlY29yZChyZWNvcmQoZXhwZWN0ZWQuaW1wb3J0ZXJzLCBcIk1pc3NpbmcgcG5wbSBpbXBvcnRlcnNcIilbXCIuXCJdLCBcIk1pc3NpbmcgcHJvamVjdCBpbXBvcnRlclwiKTtcbiAgZm9yIChjb25zdCBraW5kIG9mIFtcImRlcGVuZGVuY2llc1wiLCBcImRldkRlcGVuZGVuY2llc1wiLCBcIm9wdGlvbmFsRGVwZW5kZW5jaWVzXCJdKSB7XG4gICAgY29uc3QgZGVjbGFyZWQgPSByZWNvcmQobWFuaWZlc3Rba2luZF0gPz8ge30sIFwiSW52YWxpZCBkZWNsYXJlZCBkZXBlbmRlbmNpZXNcIik7XG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZWNvcmQoaW1wb3J0ZXJba2luZF0gPz8ge30sIFwiSW52YWxpZCBpbnN0YWxsZWQgZGVwZW5kZW5jaWVzXCIpO1xuICAgIGlmICghaXNEZWVwU3RyaWN0RXF1YWwoT2JqZWN0LmtleXMoZGVjbGFyZWQpLnNvcnQoKSwgT2JqZWN0LmtleXMoc2VsZWN0ZWQpLnNvcnQoKSkpIHJldHVybiBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IFtuYW1lLCBzcGVjaWZpZXJdIG9mIE9iamVjdC5lbnRyaWVzKGRlY2xhcmVkKSlcbiAgICAgIGlmIChyZWNvcmQoc2VsZWN0ZWRbbmFtZV0sIFwiSW52YWxpZCBpbnN0YWxsZWQgZGVwZW5kZW5jeVwiKS5zcGVjaWZpZXIgIT09IHNwZWNpZmllcikgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKiogU291cmNlIGluc3RhbGxhdGlvbiBidWlsZHMgZGlzcG9zYWJsZSBidW5kbGVzIGJlZm9yZSBpbnZva2luZyB0aGUgV29ya2JlbmNoIENMSS4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZXR1cERldmVsb3BtZW50KHJvb3Q6IHN0cmluZywgYXJncyA9IHByb2Nlc3MuYXJndi5zbGljZSgyKSk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAocHJvY2Vzcy5lbnYuV09SS0JFTkNIX1NPVVJDRV9TRVRVUCA9PT0gXCIxXCIpIHJldHVybjtcbiAgY29uc3QgeyB2YWx1ZXMgfSA9IHBhcnNlQXJncyh7XG4gICAgYXJncyxcbiAgICBzdHJpY3Q6IHRydWUsXG4gICAgb3B0aW9uczogeyBkZXBlbmRlbmNpZXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LCBcImJ1aWxkLW9ubHlcIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9IH0sXG4gIH0pO1xuICBjb25zdCBsaWZlY3ljbGUgPSBwcm9jZXNzLmVudi5ucG1fbGlmZWN5Y2xlX2V2ZW50ID09PSBcInByZXBhcmVcIjtcbiAgY29uc3QgcGluID0gcmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCIubm9kZS12ZXJzaW9uXCIpLCBcInV0ZjhcIikudHJpbSgpO1xuICBpZiAoIXByb2Nlc3MuZmVhdHVyZXMudHlwZXNjcmlwdClcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFNvdXJjZSBzZXR1cCByZXF1aXJlcyBuYXRpdmUgVHlwZVNjcmlwdCBzdXBwb3J0OyB1c2UgdGhlIGRldmVsb3BtZW50IE5vZGUuanMgJHtwaW59YCk7XG4gIGNvbnN0IHsgbWluaW11bUNsaU5vZGUgfSA9IGF3YWl0IGltcG9ydChcIi4vbm9kZS1ydW50aW1lcy5tdHNcIik7XG4gIGNvbnN0IHJ1bm5pbmcgPSBwcm9jZXNzLnZlcnNpb25zLm5vZGUuc3BsaXQoXCIuXCIpLm1hcChOdW1iZXIpLFxuICAgIG1pbmltdW0gPSBtaW5pbXVtQ2xpTm9kZS5zcGxpdChcIi5cIikubWFwKE51bWJlcik7XG4gIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCAzOyBpbmRleCsrKSB7XG4gICAgaWYgKChydW5uaW5nW2luZGV4XSA/PyAwKSA+IChtaW5pbXVtW2luZGV4XSA/PyAwKSkgYnJlYWs7XG4gICAgaWYgKChydW5uaW5nW2luZGV4XSA/PyAwKSA8IChtaW5pbXVtW2luZGV4XSA/PyAwKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgU291cmNlIHNldHVwIHJlcXVpcmVzIE5vZGUuanMgJHttaW5pbXVtQ2xpTm9kZX0gb3IgbmV3ZXI7IHVzZSBkZXZlbG9wbWVudCBOb2RlLmpzICR7cGlufWApO1xuICB9XG4gIGlmICh2YWx1ZXNbXCJidWlsZC1vbmx5XCJdIHx8IGxpZmVjeWNsZSkge1xuICAgIGNvbnN0IHsgcmV1c2VCdW5kbGVzIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2J1bmRsZS1jYWNoZS5tdHNcIik7XG4gICAgaWYgKHJldXNlQnVuZGxlcyhyb290KSkgcmV0dXJuO1xuICAgIGlmICh2YWx1ZXMuZGVwZW5kZW5jaWVzICYmIHJldXNlQnVuZGxlcyhyZXNvbHZlKHZhbHVlcy5kZXBlbmRlbmNpZXMpLCByb290KSkgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHByb3ZpZGVyID0gdmFsdWVzLmRlcGVuZGVuY2llcyA/IHJlc29sdmUodmFsdWVzLmRlcGVuZGVuY2llcykgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IGNhbmNlbGxhdGlvbiA9IHByb2Nlc3NDYW5jZWxsYXRpb24oKTtcbiAgY29uc3QgeyBucG1Db21tYW5kLCBucG1SdW50aW1lRW52aXJvbm1lbnQgfSA9IGF3YWl0IGltcG9ydChcIi4uL3NyYy9ucG0tY29tbWFuZC50c1wiKTtcbiAgY29uc3QgZW52aXJvbm1lbnQ6IE5vZGVKUy5Qcm9jZXNzRW52ID0ge1xuICAgIC4uLm5wbVJ1bnRpbWVFbnZpcm9ubWVudCgpLFxuICAgIFdPUktCRU5DSF9TT1VSQ0VfU0VUVVA6IFwiMVwiLFxuICAgIENPUkVQQUNLX0VOQUJMRV9ORVRXT1JLOiBcIjBcIixcbiAgICBXT1JLQkVOQ0hfUFJPSkVDVF9ST09UOiByb290LFxuICAgIFdPUktCRU5DSF9ESVNUUklCVVRJT05fUk9PVDogcm9vdCxcbiAgICBXT1JLQkVOQ0hfRVBIRU1FUkFMX0NIRUNLT1VUOiBcIjFcIixcbiAgICBXT1JLQkVOQ0hfTE9DQUxfQ09ORklHX1JPT1Q6IHByb2Nlc3MuZW52LldPUktCRU5DSF9MT0NBTF9DT05GSUdfUk9PVCA/PyByb290LFxuICB9O1xuICBmb3IgKGNvbnN0IGtleSBvZiBbXCJXT1JLQkVOQ0hfRVhFQ1VUSU5HX1NQRUNcIiwgXCJXT1JLQkVOQ0hfTEFVTkNIX0NIQUlOXCJdKSBSZWZsZWN0LmRlbGV0ZVByb3BlcnR5KGVudmlyb25tZW50LCBrZXkpO1xuICBjb25zdCBydW4gPSBhc3luYyAoY29tbWFuZDogc3RyaW5nLCBwYXJhbWV0ZXJzOiBzdHJpbmdbXSwgY3dkID0gcm9vdCwgZW52ID0gZW52aXJvbm1lbnQpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5Pd25lZENoaWxkKGNvbW1hbmQsIHBhcmFtZXRlcnMsIHsgY3dkLCBlbnYsIHNpZ25hbDogY2FuY2VsbGF0aW9uLnNpZ25hbCB9KTtcbiAgICBjb25zdCBmYWlsdXJlID0gcHJvY2Vzc0ZhaWx1cmUoXCJkZXZlbG9wbWVudCBzZXR1cFwiLCByZXN1bHQpO1xuICAgIGlmIChmYWlsdXJlKSB0aHJvdyBmYWlsdXJlO1xuICB9O1xuICBsZXQgdGVtcG9yYXJ5OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCBpbml0aWFsTG9jYWxTdG9yZSA9IGZhbHNlO1xuICB0cnkge1xuICAgIGlmIChwcm92aWRlciAmJiAhZXhpc3RzU3luYyhqb2luKHJvb3QsIFwibm9kZV9tb2R1bGVzXCIpKSkge1xuICAgICAgY29uc3QgbWV0YWRhdGEgPSAoZGlyZWN0b3J5OiBzdHJpbmcpID0+XG4gICAgICAgIHJlY29yZChcbiAgICAgICAgICBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpcmVjdG9yeSwgXCJwYWNrYWdlLmpzb25cIiksIFwidXRmOFwiKSksXG4gICAgICAgICAgYCR7ZGlyZWN0b3J5fTogaW52YWxpZCBwYWNrYWdlIG1ldGFkYXRhYCxcbiAgICAgICAgKTtcbiAgICAgIGNvbnN0IGZyb20gPSBtZXRhZGF0YShwcm92aWRlciksXG4gICAgICAgIHRvID0gbWV0YWRhdGEocm9vdCk7XG4gICAgICBpZiAoXG4gICAgICAgICFyZWFkRmlsZVN5bmMoam9pbihwcm92aWRlciwgXCJwbnBtLWxvY2sueWFtbFwiKSkuZXF1YWxzKHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIFwicG5wbS1sb2NrLnlhbWxcIikpKSB8fFxuICAgICAgICAhW1xuICAgICAgICAgIFwiZGVwZW5kZW5jaWVzXCIsXG4gICAgICAgICAgXCJkZXZEZXBlbmRlbmNpZXNcIixcbiAgICAgICAgICBcIm9wdGlvbmFsRGVwZW5kZW5jaWVzXCIsXG4gICAgICAgICAgXCJwZWVyRGVwZW5kZW5jaWVzXCIsXG4gICAgICAgICAgXCJvdmVycmlkZXNcIixcbiAgICAgICAgICBcInJlc29sdXRpb25zXCIsXG4gICAgICAgICAgXCJwbnBtXCIsXG4gICAgICAgICAgXCJwYWNrYWdlTWFuYWdlclwiLFxuICAgICAgICBdLmV2ZXJ5KChrZXkpID0+IGlzRGVlcFN0cmljdEVxdWFsKGZyb21ba2V5XSwgdG9ba2V5XSkpIHx8XG4gICAgICAgICFyZWFkRmlsZVN5bmMoam9pbihwcm92aWRlciwgXCJwbnBtLXdvcmtzcGFjZS55YW1sXCIpKS5lcXVhbHMocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJwbnBtLXdvcmtzcGFjZS55YW1sXCIpKSlcbiAgICAgIClcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiVGhlIHN0YWdlZCBkZXBlbmRlbmN5IHBpbnMgZGlmZmVyIGZyb20gdGhlIHByZXBhcmVkIGNoZWNrb3V0OyBwcmVwYXJlIHRoZWlyIGxvY2tlZCBkZXBlbmRlbmNpZXMgYmVmb3JlIGNoZWNraW5nIHRoaXMgc25hcHNob3RcIixcbiAgICAgICAgKTtcbiAgICAgIGlmICghcHJlcGFyZWREZXBlbmRlbmNpZXNNYXRjaChwcm92aWRlcikpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIlRoZSBkZXBlbmRlbmN5IHByb3ZpZGVyIGRvZXMgbm90IG1hdGNoIGl0cyBzb3VyY2UgcGluczsgcnVuIHNvdXJjZSBzZXR1cCBpbiB0aGF0IGNoZWNrb3V0XCIpO1xuICAgICAgY29uc3QgeyBsaW5rRGVwZW5kZW5jaWVzIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2xpbmstZGVwZW5kZW5jaWVzLm10c1wiKTtcbiAgICAgIGxpbmtEZXBlbmRlbmNpZXMoam9pbihwcm92aWRlciwgXCJub2RlX21vZHVsZXNcIiksIGpvaW4ocm9vdCwgXCJub2RlX21vZHVsZXNcIikpO1xuICAgIH1cbiAgICBpZiAoIWxpZmVjeWNsZSAmJiAhdmFsdWVzW1wiYnVpbGQtb25seVwiXSAmJiBleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCJidW5kbGUvbWFpbi5janNcIikpKSB7XG4gICAgICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW1xuICAgICAgICBqb2luKHJvb3QsIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgIFwicGFja2FnZS1tYW5hZ2VyLWV4ZWNcIixcbiAgICAgICAgXCItLVwiLFxuICAgICAgICBcImluc3RhbGxcIixcbiAgICAgICAgXCItLWZyb3plbi1sb2NrZmlsZVwiLFxuICAgICAgICBcIi0taWdub3JlLXNjcmlwdHNcIixcbiAgICAgIF0pO1xuICAgIH0gZWxzZSBpZiAoIXByZXBhcmVkRGVwZW5kZW5jaWVzTWF0Y2gocm9vdCkpIHtcbiAgICAgIGlmIChwcm9jZXNzLmVudi5XT1JLQkVOQ0hfT0ZGTElORSA9PT0gXCIxXCIpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIlNvdXJjZSBkZXBlbmRlbmNpZXMgYXJlIG5vdCBwcmVwYXJlZDsgcnVuIHNvdXJjZSBzZXR1cCBvbmxpbmUgb3Igc3VwcGx5IG1hdGNoaW5nIHByZXBhcmVkIGRlcGVuZGVuY2llc1wiLFxuICAgICAgICApO1xuICAgICAgY29uc3QgbnBtID0gbnBtQ29tbWFuZCgpO1xuICAgICAgY29uc3QgbWFuYWdlciA9IGpvaW4ocm9vdCwgXCJzY3JpcHRzL3BhY2thZ2UtbWFuYWdlclwiKTtcbiAgICAgIGNvbnN0IG1hbmlmZXN0ID0gcmVjb3JkKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJwYWNrYWdlLmpzb25cIiksIFwidXRmOFwiKSksIFwiSW52YWxpZCBwYWNrYWdlIG1ldGFkYXRhXCIpO1xuICAgICAgY29uc3QgbG9jayA9IHJlY29yZChcbiAgICAgICAgSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihtYW5hZ2VyLCBcInBhY2thZ2UtbG9jay5qc29uXCIpLCBcInV0ZjhcIikpLFxuICAgICAgICBcIkludmFsaWQgcGFja2FnZS1tYW5hZ2VyIGxvY2tcIixcbiAgICAgICk7XG4gICAgICBjb25zdCBwYWNrYWdlcyA9IHJlY29yZChsb2NrLnBhY2thZ2VzLCBcIk1pc3NpbmcgYm9vdHN0cmFwIHBhY2thZ2VzXCIpO1xuICAgICAgY29uc3Qgc2VsZWN0ZWQgPSByZWNvcmQocGFja2FnZXNbXCJub2RlX21vZHVsZXMvcG5wbVwiXSwgXCJNaXNzaW5nIGxvY2tlZCBwYWNrYWdlIG1hbmFnZXJcIik7XG4gICAgICBpZiAoXG4gICAgICAgIGxvY2subG9ja2ZpbGVWZXJzaW9uICE9PSAzIHx8XG4gICAgICAgIGBwbnBtQCR7c3RyaW5nKHNlbGVjdGVkLnZlcnNpb24sIFwiTWlzc2luZyBwYWNrYWdlLW1hbmFnZXIgdmVyc2lvblwiKX1gICE9PSBtYW5pZmVzdC5wYWNrYWdlTWFuYWdlclxuICAgICAgKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJUaGUgcGFja2FnZS1tYW5hZ2VyIGJvb3RzdHJhcCBsb2NrIG11c3QgbWF0Y2ggcGFja2FnZS5qc29uXCIpO1xuICAgICAgZm9yIChjb25zdCBbcGF0aCwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHBhY2thZ2VzKSkge1xuICAgICAgICBpZiAoIXBhdGgpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBlbnRyeSA9IHJlY29yZCh2YWx1ZSwgYEludmFsaWQgYm9vdHN0cmFwIHBhY2thZ2UgJHtwYXRofWApO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdHlwZW9mIGVudHJ5LnJlc29sdmVkICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgICAgIWVudHJ5LnJlc29sdmVkLnN0YXJ0c1dpdGgoXCJodHRwczovL1wiKSB8fFxuICAgICAgICAgIHR5cGVvZiBlbnRyeS5pbnRlZ3JpdHkgIT09IFwic3RyaW5nXCIgfHxcbiAgICAgICAgICAhL15zaGEoPzoyNTZ8Mzg0fDUxMiktW0EtWmEtejAtOSsvXSs9ezAsMn0kLy50ZXN0KGVudHJ5LmludGVncml0eSlcbiAgICAgICAgKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkJvb3RzdHJhcCBwYWNrYWdlcyByZXF1aXJlIEhUVFBTIGFuZCBzdHJvbmcgaW50ZWdyaXR5IGhhc2hlc1wiKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHJ1bihucG0uY29tbWFuZCwgW1xuICAgICAgICAuLi5ucG0ucHJlZml4LFxuICAgICAgICBcImNpXCIsXG4gICAgICAgIFwiLS1wcmVmaXhcIixcbiAgICAgICAgbWFuYWdlcixcbiAgICAgICAgXCItLWlnbm9yZS1zY3JpcHRzXCIsXG4gICAgICAgIFwiLS1pbmNsdWRlPW9wdGlvbmFsXCIsXG4gICAgICAgIFwiLS1uby1hdWRpdFwiLFxuICAgICAgICBcIi0tbm8tZnVuZFwiLFxuICAgICAgXSk7XG4gICAgICBhd2FpdCBydW4obnBtLmNvbW1hbmQsIFsuLi5ucG0ucHJlZml4LCBcImF1ZGl0XCIsIFwic2lnbmF0dXJlc1wiLCBcIi0tcHJlZml4XCIsIG1hbmFnZXJdKTtcbiAgICAgIHRlbXBvcmFyeSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwid29ya2JlbmNoLXNvdXJjZS1zZXR1cC1cIikpO1xuICAgICAgY29uc3QgcmVwbGFjZSA9IGV4aXN0c1N5bmMoam9pbihyb290LCBcIm5vZGVfbW9kdWxlc1wiKSk7XG4gICAgICBpZiAocmVwbGFjZSAmJiBsc3RhdFN5bmMoam9pbihyb290LCBcIm5vZGVfbW9kdWxlc1wiKSkuaXNTeW1ib2xpY0xpbmsoKSlcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiUHJlc2VydmluZyBhIG5vZGVfbW9kdWxlcyBsaW5rIHdpdGhvdXQgcG5wbSBtZXRhZGF0YTsgcHJlcGFyZSBtYXRjaGluZyBkZXBlbmRlbmNpZXMgYmVmb3JlIHNvdXJjZSBzZXR1cFwiLFxuICAgICAgICApO1xuICAgICAgaW5pdGlhbExvY2FsU3RvcmUgPSAhZXhpc3RzU3luYyhqb2luKHJvb3QsIFwibm9kZV9tb2R1bGVzLy5wbnBtXCIpKTtcbiAgICAgIGF3YWl0IHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbXG4gICAgICAgIGpvaW4obWFuYWdlciwgXCJub2RlX21vZHVsZXMvcG5wbS9iaW4vcG5wbS5tanNcIiksXG4gICAgICAgIFwiaW5zdGFsbFwiLFxuICAgICAgICBcIi0tZnJvemVuLWxvY2tmaWxlXCIsXG4gICAgICAgIFwiLS1pZ25vcmUtc2NyaXB0c1wiLFxuICAgICAgICAuLi4ocmVwbGFjZSA/IFtcIi0tZm9yY2VcIl0gOiBbXSksXG4gICAgICAgIFwiLS1zdG9yZS1kaXJcIixcbiAgICAgICAgcHJvY2Vzcy5lbnYuUE5QTV9DT05GSUdfU1RPUkVfRElSID8/IGpvaW4odGVtcG9yYXJ5LCBcInN0b3JlXCIpLFxuICAgICAgICBcIi0tdmlydHVhbC1zdG9yZS1kaXJcIixcbiAgICAgICAgam9pbihyb290LCBcIm5vZGVfbW9kdWxlcy8ucG5wbVwiKSxcbiAgICAgIF0pO1xuICAgIH1cbiAgICBpZiAoIXByZXBhcmVkRGVwZW5kZW5jaWVzTWF0Y2gocm9vdCkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJQcmVwYXJlZCBzb3VyY2UgZGVwZW5kZW5jaWVzIGRvIG5vdCBtYXRjaCB0aGUgZGVjbGFyZWQgcGluc1wiKTtcbiAgICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2pvaW4ocm9vdCwgXCJzY3JpcHRzL2J1aWxkLXRvb2xpbmcubXRzXCIpLCBcIi0tbWFpbnRhaW5lcnMtb25seVwiXSk7XG4gICAgY29uc3QgeyByZXVzZUJ1bmRsZXMgfSA9IGF3YWl0IGltcG9ydChcIi4vYnVuZGxlLWNhY2hlLm10c1wiKTtcbiAgICBpZiAoIXJldXNlQnVuZGxlcyhyb290KSkge1xuICAgICAgY29uc3QgeyBjb21waWxlQnVuZGxlcywgcHVibGlzaEJ1bmRsZXMgfSA9IGF3YWl0IGltcG9ydChcIi4vYnVuZGxlLWJ1aWxkLm1qc1wiKTtcbiAgICAgIGNvbnN0IHsgY29sbGVjdFRvb2xpbmdBcnRpZmFjdHMgfSA9IGF3YWl0IGltcG9ydChcIi4vYnVpbGQtdG9vbGluZy5tdHNcIik7XG4gICAgICBjb25zdCB7IHZlcmlmeVJ1bnRpbWVEZXBlbmRlbmNpZXMgfSA9IGF3YWl0IGltcG9ydChcIi4vcnVudGltZS1kZXBlbmRlbmNpZXMubWpzXCIpO1xuICAgICAgY2FuY2VsbGF0aW9uLnNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICAgICAgY29uc29sZS5lcnJvcihcIkJ1aWxkaW5nIGxvY2FsIFdvcmtiZW5jaCBidW5kbGVz4oCmXCIpO1xuICAgICAgY29uc3QgYnVuZGxlcyA9IGF3YWl0IGNvbXBpbGVCdW5kbGVzKHJvb3QsIGNhbmNlbGxhdGlvbi5zaWduYWwpO1xuICAgICAgdmVyaWZ5UnVudGltZURlcGVuZGVuY2llcyh7IHJvb3QsIGFydGlmYWN0czogY29sbGVjdFRvb2xpbmdBcnRpZmFjdHMocm9vdCksIC4uLmJ1bmRsZXMgfSk7XG4gICAgICBwdWJsaXNoQnVuZGxlcyhyb290LCBidW5kbGVzKTtcbiAgICB9XG4gICAgaWYgKHRlbXBvcmFyeSAmJiAhdmFsdWVzW1wiYnVpbGQtb25seVwiXSAmJiAhbGlmZWN5Y2xlKSB7XG4gICAgICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW1xuICAgICAgICBqb2luKHJvb3QsIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgIFwicGFja2FnZS1tYW5hZ2VyLWV4ZWNcIixcbiAgICAgICAgXCItLVwiLFxuICAgICAgICBcImluc3RhbGxcIixcbiAgICAgICAgXCItLWZyb3plbi1sb2NrZmlsZVwiLFxuICAgICAgICBcIi0taWdub3JlLXNjcmlwdHNcIixcbiAgICAgIF0pO1xuICAgICAgY29uc3QgeyBwYXJzZSB9ID0gYXdhaXQgaW1wb3J0KFwieWFtbFwiKTtcbiAgICAgIGNvbnN0IG1vZHVsZXMgPSBwYXJzZShyZWFkRmlsZVN5bmMoam9pbihyb290LCBcIm5vZGVfbW9kdWxlcy8ubW9kdWxlcy55YW1sXCIpLCBcInV0ZjhcIikpIGFzIHtcbiAgICAgICAgdmlydHVhbFN0b3JlRGlyPzogc3RyaW5nO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IGxvY2FsID0gam9pbihyb290LCBcIm5vZGVfbW9kdWxlcy8ucG5wbVwiKTtcbiAgICAgIGlmIChcbiAgICAgICAgaW5pdGlhbExvY2FsU3RvcmUgJiZcbiAgICAgICAgbW9kdWxlcy52aXJ0dWFsU3RvcmVEaXIgJiZcbiAgICAgICAgcmVzb2x2ZShyb290LCBcIm5vZGVfbW9kdWxlc1wiLCBtb2R1bGVzLnZpcnR1YWxTdG9yZURpcikgIT09IGxvY2FsICYmXG4gICAgICAgIGV4aXN0c1N5bmMobG9jYWwpICYmXG4gICAgICAgICFsc3RhdFN5bmMobG9jYWwpLmlzU3ltYm9saWNMaW5rKClcbiAgICAgIClcbiAgICAgICAgcm1TeW5jKGxvY2FsLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgY2FuY2VsbGF0aW9uLmNsb3NlKCk7XG4gICAgaWYgKHRlbXBvcmFyeSkgcm1TeW5jKHRlbXBvcmFyeSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59XG5cbmlmIChpc01haW5TY3JpcHQoaW1wb3J0Lm1ldGEudXJsKSkge1xuICBjb25zdCByb290ID0gcmVzb2x2ZShkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSksIFwiLi5cIik7XG4gIGF3YWl0IHNldHVwRGV2ZWxvcG1lbnQocm9vdCkuY2F0Y2goKGVycm9yOiB1bmtub3duKSA9PiB7XG4gICAgY29uc29sZS5lcnJvcihgd29ya2JlbmNoOiAke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX1gKTtcbiAgICBwcm9jZXNzLmV4aXRDb2RlID0gMTtcbiAgfSk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFNBQVMsTUFBTSxlQUFlO0FBQ3ZDLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsWUFBWSxjQUFjLGFBQWEsUUFBUSxpQkFBaUI7QUFDekUsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsbUJBQW1CLGlCQUFpQjtBQUM3QyxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLHlCQUF5QjtBQUNsQyxTQUFTLGVBQWUsMkJBQTJCO0FBQ25ELFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsUUFBUSxjQUFjO0FBRS9CLFNBQVMsYUFBYSxNQUF1QztBQUMzRCxRQUFNLFlBQVksa0JBQWtCLGFBQWEsTUFBTSxNQUFNLENBQUM7QUFDOUQsYUFBVyxZQUFZLFdBQVc7QUFDaEMsVUFBTSxDQUFDLEtBQUssSUFBSSxTQUFTO0FBQ3pCLFFBQUksTUFBTyxPQUFNO0FBQUEsRUFDbkI7QUFDQSxTQUFPLE9BQU8sVUFBVSxHQUFHLEVB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
