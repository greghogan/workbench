// Generated from ci-cache.mts; edit the TypeScript source.
import { isCompilerFamily } from "./compiler-catalog.mjs";
import { required, record, records, string, strings, stringRecord } from "./values.mjs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ciBuildCachePaths, ciCacheEnvironment } from "./ci-layout.mjs";
import { guixChannelFile } from "./managed-contract.mjs";
const distribution = resolve(import.meta.dirname, "..");
const rawTarget = record(JSON.parse(process.env.CACHE_TARGET ?? "{}"), "Invalid cache target");
const target = {};
for (const key of ["runtime", "version", "environment"])
  if (rawTarget[key] !== void 0 && rawTarget[key] !== null)
    target[key] = string(rawTarget[key], "Invalid cache target field");
if (rawTarget.paths !== void 0) target.paths = strings(rawTarget.paths, "Invalid cache roots");
if (rawTarget.selections !== void 0)
  target.selections = records(rawTarget.selections, "Invalid cache selections").map((entry) => ({
    path: string(entry.path, "Invalid cache selection path"),
    ...entry.toolchain === void 0 ? {} : { toolchain: string(entry.toolchain, "Invalid cache toolchain") }
  }));
if (process.env.CHECK_CACHE_ENVIRONMENT) target.environment = process.env.CHECK_CACHE_ENVIRONMENT;
const roots = target.paths ?? ["."];
const base = join(required(process.env.RUNNER_TEMP, "RUNNER_TEMP is required"), "workbench-ci");
const data = join(base, "data");
const cache = join(base, "cache");
const variables = ciCacheEnvironment(cache, data, true);
for (const path of [data, cache]) mkdirSync(path, { recursive: true });
for (const [key, value] of Object.entries(variables))
  appendFileSync(required(process.env.GITHUB_ENV, "GITHUB_ENV is required"), `${key}=${value}
`);
const inputs = (files) => roots.flatMap(
  (root) => files.flatMap((name) => {
    const path = join(root, name);
    return existsSync(path) ? [[path, readFileSync(path, "utf8")]] : [];
  })
);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const pinInputs = (files) => [...new Set(inputs(files).map(([path, value]) => JSON.stringify([basename(path), value.trim()])))].sort();
const guixChannels = [
  ...new Set(
    roots.map((root) => guixChannelFile(process.cwd(), resolve(root))).filter(existsSync).map((path) => readFileSync(path, "utf8").trim())
  )
].sort();
const platform = `${process.platform}-${process.arch}`;
const windows = process.platform === "win32";
const redownload = /* @__PURE__ */ new Set([
  "llvm",
  "clang",
  "gcc",
  "java",
  "node",
  "go",
  "cmake",
  "ninja",
  "uv",
  "shfmt",
  "shellcheck",
  "actionlint",
  "cargo-nextest",
  "cargo-llvm-cov"
]);
const sourceGroups = {
  acquisition: [
    "src/tool-downloads.ts",
    "src/tool-host.ts",
    "src/runtime-builds.ts",
    "src/seven-zip.ts",
    "src/artifact-streams.ts",
    "src/archive-extraction.ts",
    "src/artifact-decoders.ts",
    "src/artifact-signatures.ts",
    "src/artifact-attestations.ts",
    "src/attestation-verification.ts",
    "src/artifact-repositories.ts",
    "src/artifact-policy.ts"
  ],
  filtered: ["src/filtered-artifacts.ts"],
  vcpkg: ["src/vcpkg.ts", "src/mvsc.ts"],
  ruby: ["src/ruby-manager.ts"],
  packageManager: ["src/package-manager.ts", "src/toolchains.ts", "src/tool-downloads.ts"],
  builds: ["src/builds.ts"],
  guix: target.environment === "guix" ? ["scripts/ci-guix-bootstrap.mjs", "scripts/ci-guix-bootstrap.scm", "scripts/managed-contract.mjs"] : []
};
const sourceFiles = [...new Set(Object.values(sourceGroups).flat())];
const inspectionData = record(
  JSON.parse(
    execFileSync(
      process.execPath,
      [join(distribution, "bin/workbench.mjs"), "ci-cache-inspect", JSON.stringify({ target, sources: sourceFiles })],
      { encoding: "utf8", env: { ...process.env, ...variables }, maxBuffer: 16 * 1024 * 1024 }
    )
  ),
  "Invalid cache inspection"
);
const tool = (entry) => {
  const value = {
    root: string(entry.root, "Missing tool root"),
    tool: string(entry.tool, "Missing tool name"),
    version: string(entry.version, "Missing tool version")
  };
  for (const key of ["directory", "policy", "manager"])
    if (entry[key] !== void 0) value[key] = string(entry[key], "Invalid tool metadata");
  if (entry.filtered !== void 0) {
    if (typeof entry.filtered !== "boolean") throw new Error("Invalid tool filtering flag");
    value.filtered = entry.filtered;
  }
  return value;
};
const plans = (value) => records(value, "Invalid tool plans").map((entry) => ({
  path: string(entry.path, "Missing plan root"),
  plan: records(entry.plan, "Invalid installation plan").map(tool)
}));
const inspection = {
  retention: stringRecord(inspectionData.retention, "Invalid cache retention"),
  sources: stringRecord(inspectionData.sources, "Invalid cache source identities"),
  native: plans(inspectionData.native),
  defaults: plans(inspectionData.defaults),
  runtimes: records(inspectionData.runtimes, "Invalid runtime plans").map((entry) => {
    const plan2 = record(entry.plan, "Invalid runtime plan"), selected = record(plan2.tool, "Invalid runtime tool");
    return {
      path: string(entry.path, "Missing runtime root"),
      plan: {
        tool: {
          name: string(selected.name, "Missing runtime name"),
          version: string(selected.version, "Missing runtime version")
        },
        directory: string(plan2.directory, "Missing runtime directory"),
        policy: plan2.policy === void 0 ? void 0 : string(plan2.policy, "Invalid runtime policy")
      }
    };
  }),
  managers: records(inspectionData.managers, "Invalid package manager plans").map((entry) => ({
    identity: string(entry.identity, "Missing manager identity"),
    directory: string(entry.directory, "Missing manager directory")
  }))
};
const retained = (tool2) => inspection.retention[tool2] ? inspection.retention[tool2] === "cache" : !redownload.has(tool2);
const runtimeOnly = ["node", "go", "java", "ruby", "php"].includes(target.runtime ?? "");
const managed = target.environment && target.environment !== "devcontainer";
const plan = inspection.native.flatMap(({ plan: plan2 }) => plan2).filter(
  (entry) => target.runtime === "python" ? entry.tool === "uv" : target.runtime === "rust" ? false : target.environment === "devcontainer" ? entry.tool === "node" : true
);
if (runtimeOnly) {
  for (const { path: root, plan: runtime } of inspection.runtimes) {
    if (target.runtime === "java")
      plan.push(
        ...required(
          inspection.defaults.find((entry) => entry.path === root),
          `Missing defaults for ${root}`
        ).plan.filter((entry) => entry.tool === "maven")
      );
    plan.push({
      root,
      tool: runtime.tool.name,
      version: runtime.tool.version,
      directory: runtime.directory,
      filtered: false,
      policy: runtime.policy
    });
  }
}
const ordinary = plan.filter(
  (entry) => typeof entry.directory === "string" && (!entry.filtered || entry.tool === "gcc") && retained(entry.tool) && !["llvm-runtime", "llvm-xml-runtime"].includes(entry.tool) && (target.runtime !== "python" || entry.tool === "uv")
);
const policies = (entries) => [
  ...new Map(
    entries.filter((entry) => typeof entry.directory === "string").map((entry) => [
      entry.directory,
      [entry.tool, entry.version, entry.policy, basename(required(entry.directory, "Missing tool directory"))]
    ])
  ).values()
].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const sourceInputs = (files) => files.map((file) => [file, inspection.sources[file]]);
const acquisitionCode = sourceInputs(sourceGroups.acquisition);
const vcpkg = target.runtime && !isCompilerFamily(target.runtime) || managed ? [] : [...new Set(inputs([".vcpkg-version"]).map(([, revision]) => revision.trim()))].sort();
const vcpkgPaths = [...new Set(vcpkg.map((revision) => join(cache, "toolchains", "vcpkg", revision, platform)))];
const pythonPaths = !windows && (target.runtime === "python" || !target.runtime && !managed && inputs([".python-version"]).length) ? [join(cache, "uv-python", "python")] : [];
const devcontainerRuntimes = target.environment === "devcontainer" ? roots.flatMap(
  (root) => required(
    inspection.defaults.find((entry) => entry.path === root),
    `Missing defaults for ${root}`
  ).plan
).filter((entry) => !["rust", "miri", "python"].includes(entry.tool)) : [];
const cachedDevcontainerRuntimes = devcontainerRuntimes.filter((entry) => retained(entry.tool));
const devcontainerRuntimePaths = [
  ...new Set(
    cachedDevcontainerRuntimes.filter(
      (entry) => (!entry.filtered || entry.tool === "gcc") && !["llvm-runtime", "llvm-xml-runtime"].includes(entry.tool)
    ).map((entry) => entry.tool === "gcc" ? entry.directory : join(cache, "toolchains", entry.tool, entry.version))
  )
].sort();
const tools = hash([
  policies(cachedDevcontainerRuntimes),
  target.environment === "devcontainer" ? [".devcontainer/Dockerfile", ".devcontainer/devcontainer.json"].filter((file) => existsSync(file)).map((file) => [file, readFileSync(file, "utf8")]) : [],
  devcontainerRuntimePaths,
  pinInputs([".ruby-version", ".php-version"]),
  [...ordinary, ...cachedDevcontainerRuntimes].some((entry) => entry.filtered) ? sourceInputs(sourceGroups.filtered) : [],
  policies(ordinary),
  acquisitionCode,
  vcpkg,
  vcpkg.length ? sourceInputs(sourceGroups.vcpkg) : [],
  pythonPaths.length ? [pinInputs([".python-version"]), target.runtime === "python" ? target.version : void 0] : void 0
]);
const managers = inspection.managers;
const managerKey = hash([
  [...new Set(managers.map((entry) => entry.identity))].sort(),
  inputs(["Gemfile.lock"]),
  sourceInputs(sourceGroups.ruby),
  sourceInputs(sourceGroups.packageManager)
]);
const manifests = inputs([
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
  ".composer/checksums.json",
  ".composer/verify/composer.json",
  ".composer/verify/src/VerifyPlugin.php",
  "tools/composer.json",
  "tools/composer.lock",
  "tools/.composer/checksums.json",
  "tools/compat/composer.json",
  "tools/compat/composer.lock",
  "tools/compat/.composer/checksums.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "uv.lock",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "vcpkg-configuration.json",
  "vcpkg.json",
  "pom.xml",
  ".mvn/checksums/checksums.sha256",
  ".mvn/settings.xml",
  ".mvn/maven.config",
  ".mvn/jvm.config"
]);
const downloads = hash(manifests);
const builds = hash([
  manifests,
  inputs([
    "CMakeLists.txt",
    ".llvm-version",
    ".gcc-version",
    ".mvsc-version",
    ".windows-sdk-version",
    "rust-toolchain.toml",
    ".python-version",
    ".go-version",
    ".node-version",
    ".java-version",
    ".ruby-version",
    ".php-version",
    ".composer-version",
    ".xdebug-version"
  ]),
  target.environment ? inputs(["flake.nix", "flake.lock", "manifest.scm"]) : void 0,
  target.environment === "guix" ? guixChannels : void 0,
  readFileSync("workbench/projects.toml", "utf8"),
  // Redownloaded guest tools still determine compiled-output compatibility.
  policies(devcontainerRuntimes),
  policies(plan),
  acquisitionCode,
  sourceInputs(sourceGroups.builds),
  tools,
  target.runtime,
  target.version,
  target.environment,
  inputs([".devcontainer/devcontainer.json", ".devcontainer/Dockerfile"])
]);
const measuredPlan = {};
const compressionLevel = process.env.ZSTD_CLEVEL ?? "3";
if (!/^(?:[1-9]|1[0-9])$/.test(compressionLevel)) throw new Error("ZSTD_CLEVEL must be an integer from 1 to 19");
const output = (key, value) => {
  if (key.endsWith("-key")) {
    output(key.replace(/-key$/, "-restore-keys"), value);
    value += `-zstd${compressionLevel}`;
  }
  measuredPlan[key] = value;
  appendFileSync(
    required(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required"),
    `${key}<<WORKBENCH_CACHE
${value}
WORKBENCH_CACHE
`
  );
};
if (ordinary.length || vcpkgPaths.length || pythonPaths.length || devcontainerRuntimePaths.length)
  output("tools-key", `tools-v8-${platform}-${tools}`);
output(
  "tools-paths",
  [
    .../* @__PURE__ */ new Set([
      ...ordinary.map((entry) => entry.directory),
      ...devcontainerRuntimePaths,
      ...vcpkgPaths,
      ...pythonPaths,
      ...inputs([".xdebug-version"]).length ? [join(cache, "toolchains/xdebug")] : []
    ])
  ].join("\n")
);
if (managers.length || inputs(["Gemfile.lock"]).length) {
  output("package-managers-key", `package-managers-v1-${platform}-${managerKey}`);
  output(
    "package-managers-paths",
    [
      .../* @__PURE__ */ new Set([
        ...managers.map((entry) => entry.directory),
        ...inputs(["Gemfile.lock"]).length ? [join(cache, "package-managers/bundler")] : []
      ])
    ].join("\n")
  );
}
output("downloads-key", `downloads-v${String(windows ? 2 : 1)}-${platform}-${downloads}`);
output(
  "downloads-paths",
  [
    ...["uv", "go-mod", "npm", "pip"].map((name) => join(cache, name)),
    join(cache, "downloads", "pnpm"),
    ...windows ? [join(cache, "downloads", "uv-python")] : [],
    join(cache, "downloads", "maven"),
    join(cache, "downloads", "composer"),
    join(cache, "downloads", "bundler"),
    join(cache, "vcpkg", "downloads"),
    join(required(variables.CARGO_HOME, "Missing CARGO_HOME"), "registry"),
    join(required(variables.CARGO_HOME, "Missing CARGO_HOME"), "git")
  ].join("\n")
);
output("builds-key", `builds-v2-${platform}-${builds}`);
output("builds-paths", ciBuildCachePaths(cache, target.environment).join("\n"));
output("guix-key", `guix-source-v2-${platform}-${hash(guixChannels)}`);
output("guix-paths", ["checkouts", "authentication"].map((name) => join(homedir(), ".cache", "guix", name)).join("\n"));
if (target.environment === "guix") {
  output(
    "guix-bootstrap-key",
    `guix-bootstrap-v1-${platform}-${hash([guixChannels, sourceInputs(sourceGroups.guix)])}`
  );
  output("guix-bootstrap-path", join(cache, "guix-bootstrap"));
}
const llvm = [...plan, ...devcontainerRuntimes].filter(
  (entry) => ["llvm", "clang", "llvm-runtime", "llvm-xml-runtime"].includes(entry.tool)
);
for (const [group, entries] of [
  ["llvm", llvm.filter((entry) => !["clang", "llvm-xml-runtime"].includes(entry.tool))],
  ["clang", llvm.filter((entry) => ["clang", "llvm-xml-runtime"].includes(entry.tool))]
]) {
  if (!entries.length || !retained(group)) continue;
  output(
    `${group}-key`,
    `${group}-v3-${platform}-${hash([policies(entries), acquisitionCode, sourceInputs(sourceGroups.filtered)])}`
  );
  output(`${group}-paths`, [...new Set(entries.map((entry) => entry.directory))].join("\n"));
}
const rustPins = managed ? [] : target.runtime === "rust" ? [{ channel: required(target.version, "Missing Rust version"), profile: "minimal", components: [], targets: [] }] : target.runtime ? [] : roots.flatMap(
  (root) => required(
    inspection.defaults.find((entry) => entry.path === root),
    `Missing defaults for ${root}`
  ).plan
).filter((entry) => entry.tool === "rust").map((entry) => ({ channel: entry.version }));
if (rustPins.length && retained("rust")) {
  output(
    "rust-key",
    `rust-v2-${platform}-${hash([[...new Set(rustPins.map((pin) => JSON.stringify(pin)))].sort(), pinInputs(["rust-toolchain.toml"]), readFileSync(join(distribution, "scripts/bootstrap-tools.json"), "utf8"), acquisitionCode])}`
  );
  output(
    "rust-paths",
    [
      ...new Set(
        rustPins.map(
          (pin) => join(required(variables.RUSTUP_HOME, "Missing RUSTUP_HOME"), "toolchains", `${pin.channel}-*`)
        )
      ),
      join(required(variables.CARGO_HOME, "Missing CARGO_HOME"), "bin")
    ].join("\n")
  );
}
writeFileSync(join(base, "cache-plan.json"), JSON.stringify(measuredPlan, null, 2) + "\n");
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLWNhY2hlLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBpc0NvbXBpbGVyRmFtaWx5IH0gZnJvbSBcIi4vY29tcGlsZXItY2F0YWxvZy5tanNcIjtcbmltcG9ydCB7IHJlcXVpcmVkLCByZWNvcmQsIHJlY29yZHMsIHN0cmluZywgc3RyaW5ncywgc3RyaW5nUmVjb3JkIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHR5cGUgeyBDYWNoZUluc3BlY3Rpb25SZXF1ZXN0IH0gZnJvbSBcIi4uL3NyYy9jaS1jYWNoZS1pbnNwZWN0aW9uLmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBhcHBlbmRGaWxlU3luYywgZXhpc3RzU3luYywgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGNpQnVpbGRDYWNoZVBhdGhzLCBjaUNhY2hlRW52aXJvbm1lbnQgfSBmcm9tIFwiLi9jaS1sYXlvdXQubWpzXCI7XG5pbXBvcnQgeyBndWl4Q2hhbm5lbEZpbGUgfSBmcm9tIFwiLi9tYW5hZ2VkLWNvbnRyYWN0Lm1qc1wiO1xuaW1wb3J0IHR5cGUgeyBQYXRoT3JGaWxlRGVzY3JpcHRvciB9IGZyb20gXCJmc1wiO1xuXG5jb25zdCBkaXN0cmlidXRpb24gPSByZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiLi5cIik7XG5jb25zdCByYXdUYXJnZXQgPSByZWNvcmQoSlNPTi5wYXJzZShwcm9jZXNzLmVudi5DQUNIRV9UQVJHRVQgPz8gXCJ7fVwiKSwgXCJJbnZhbGlkIGNhY2hlIHRhcmdldFwiKTtcbmNvbnN0IHRhcmdldDogQ2FjaGVJbnNwZWN0aW9uUmVxdWVzdFtcInRhcmdldFwiXSA9IHt9O1xuZm9yIChjb25zdCBrZXkgb2YgW1wicnVudGltZVwiLCBcInZlcnNpb25cIiwgXCJlbnZpcm9ubWVudFwiXSBhcyBjb25zdClcbiAgaWYgKHJhd1RhcmdldFtrZXldICE9PSB1bmRlZmluZWQgJiYgcmF3VGFyZ2V0W2tleV0gIT09IG51bGwpXG4gICAgdGFyZ2V0W2tleV0gPSBzdHJpbmcocmF3VGFyZ2V0W2tleV0sIFwiSW52YWxpZCBjYWNoZSB0YXJnZXQgZmllbGRcIik7XG5pZiAocmF3VGFyZ2V0LnBhdGhzICE9PSB1bmRlZmluZWQpIHRhcmdldC5wYXRocyA9IHN0cmluZ3MocmF3VGFyZ2V0LnBhdGhzLCBcIkludmFsaWQgY2FjaGUgcm9vdHNcIik7XG5pZiAocmF3VGFyZ2V0LnNlbGVjdGlvbnMgIT09IHVuZGVmaW5lZClcbiAgdGFyZ2V0LnNlbGVjdGlvbnMgPSByZWNvcmRzKHJhd1RhcmdldC5zZWxlY3Rpb25zLCBcIkludmFsaWQgY2FjaGUgc2VsZWN0aW9uc1wiKS5tYXAoKGVudHJ5KSA9PiAoe1xuICAgIHBhdGg6IHN0cmluZyhlbnRyeS5wYXRoLCBcIkludmFsaWQgY2FjaGUgc2VsZWN0aW9uIHBhdGhcIiksXG4gICAgLi4uKGVudHJ5LnRvb2xjaGFpbiA9PT0gdW5kZWZpbmVkID8ge30gOiB7IHRvb2xjaGFpbjogc3RyaW5nKGVudHJ5LnRvb2xjaGFpbiwgXCJJbnZhbGlkIGNhY2hlIHRvb2xjaGFpblwiKSB9KSxcbiAgfSkpO1xuaWYgKHByb2Nlc3MuZW52LkNIRUNLX0NBQ0hFX0VOVklST05NRU5UKSB0YXJnZXQuZW52aXJvbm1lbnQgPSBwcm9jZXNzLmVudi5DSEVDS19DQUNIRV9FTlZJUk9OTUVOVDtcbmNvbnN0IHJvb3RzID0gdGFyZ2V0LnBhdGhzID8/IFtcIi5cIl07XG5jb25zdCBiYXNlID0gam9pbihyZXF1aXJlZChwcm9jZXNzLmVudi5SVU5ORVJfVEVNUCwgXCJSVU5ORVJfVEVNUCBpcyByZXF1aXJlZFwiKSwgXCJ3b3JrYmVuY2gtY2lcIik7XG5jb25zdCBkYXRhID0gam9pbihiYXNlLCBcImRhdGFcIik7XG5jb25zdCBjYWNoZSA9IGpvaW4oYmFzZSwgXCJjYWNoZVwiKTtcbmNvbnN0IHZhcmlhYmxlcyA9IGNpQ2FjaGVFbnZpcm9ubWVudChjYWNoZSwgZGF0YSwgdHJ1ZSk7XG5mb3IgKGNvbnN0IHBhdGggb2YgW2RhdGEsIGNhY2hlXSkgbWtkaXJTeW5jKHBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXModmFyaWFibGVzKSlcbiAgYXBwZW5kRmlsZVN5bmMocmVxdWlyZWQocHJvY2Vzcy5lbnYuR0lUSFVCX0VOViwgXCJHSVRIVUJfRU5WIGlzIHJlcXVpcmVkXCIpLCBgJHtrZXl9PSR7dmFsdWV9XFxuYCk7XG5jb25zdCBpbnB1dHMgPSAoZmlsZXM6IHN0cmluZ1tdKTogW3N0cmluZywgc3RyaW5nXVtdID0+XG4gIHJvb3RzLmZsYXRNYXAoKHJvb3Q6IHN0cmluZykgPT5cbiAgICBmaWxlcy5mbGF0TWFwKChuYW1lOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHBhdGggPSBqb2luKHJvb3QsIG5hbWUpO1xuICAgICAgcmV0dXJuIGV4aXN0c1N5bmMocGF0aCkgPyBbW3BhdGgsIHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIildIGFzIFtzdHJpbmcsIHN0cmluZ11dIDogW107XG4gICAgfSksXG4gICk7XG5jb25zdCBoYXNoID0gKHZhbHVlOiB1bmtub3duKSA9PiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShKU09OLnN0cmluZ2lmeSh2YWx1ZSkpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCAyNCk7XG4vLyBBbiBpbnN0YWxsZWQgYXJ0aWZhY3QgZGVwZW5kcyBvbiBpdHMgcGluLCBub3Qgd2hpY2ggcm9vdHMgZGVjbGFyZSB0aGUgc2FtZSBwaW4uXG5jb25zdCBwaW5JbnB1dHMgPSAoZmlsZXM6IHN0cmluZ1tdKSA9PlxuICBbLi4ubmV3IFNldChpbnB1dHMoZmlsZXMpLm1hcCgoW3BhdGgsIHZhbHVlXSkgPT4gSlNPTi5zdHJpbmdpZnkoW2Jhc2VuYW1lKHBhdGgpLCB2YWx1ZS50cmltKCldKSkpXS5zb3J0KCk7XG5jb25zdCBndWl4Q2hhbm5lbHMgPSBbXG4gIC4uLm5ldyBTZXQoXG4gICAgcm9vdHNcbiAgICAgIC5tYXAoKHJvb3Q6IHN0cmluZykgPT4gZ3VpeENoYW5uZWxGaWxlKHByb2Nlc3MuY3dkKCksIHJlc29sdmUocm9vdCkpKVxuICAgICAgLmZpbHRlcihleGlzdHNTeW5jKVxuICAgICAgLm1hcCgocGF0aDogUGF0aE9yRmlsZURlc2NyaXB0b3IpID0+IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikudHJpbSgpKSxcbiAgKSxcbl0uc29ydCgpO1xuY29uc3QgcGxhdGZvcm0gPSBgJHtwcm9jZXNzLnBsYXRmb3JtfS0ke3Byb2Nlc3MuYXJjaH1gO1xuY29uc3Qgd2luZG93cyA9IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIjtcbi8vIFJlYWNxdWlyZSB0aGVzZSBwcmVidWlsdCB0b29scyB0aHJvdWdoIHRoZSB2ZXJpZmllZCBpbnN0YWxsZXIgb24gZWFjaCBob3N0ZWQgam9iLlxuLy8gS2VlcCBsb2NhbCByZXVzZSBhbmQgcmV1c2UgYmV0d2VlbiByb290cyB3aXRoaW4gdGhlIGpvYjsgcmVzZXJ2ZSBBY3Rpb25zIHN0b3JhZ2Vcbi8vIGZvciBleHBlbnNpdmUgYnVpbGRzIHJhdGhlciB0aGFuIHByZWJ1aWx0IFNESyBpbnN0YWxsYXRpb25zLlxuY29uc3QgcmVkb3dubG9hZCA9IG5ldyBTZXQoW1xuICBcImxsdm1cIixcbiAgXCJjbGFuZ1wiLFxuICBcImdjY1wiLFxuICBcImphdmFcIixcbiAgXCJub2RlXCIsXG4gIFwiZ29cIixcbiAgXCJjbWFrZVwiLFxuICBcIm5pbmphXCIsXG4gIFwidXZcIixcbiAgXCJzaGZtdFwiLFxuICBcInNoZWxsY2hlY2tcIixcbiAgXCJhY3Rpb25saW50XCIsXG4gIFwiY2FyZ28tbmV4dGVzdFwiLFxuICBcImNhcmdvLWxsdm0tY292XCIsXG5dKTtcbi8vIFByb2plY3QgcG9saWN5IGNvbnRyb2xzIGhvc3RlZCByZXRlbnRpb24gb25seTsgaW5zdGFsbGVycyBzdGlsbCByZXVzZSB2ZXJpZmllZCBsb2NhbCBmaWxlcy5cbi8vIENvbGxlY3QgZXZlcnkgc291cmNlIGlkZW50aXR5IGluIHRoZSBzYW1lIHByb2Nlc3MgYXMgdG9vbCBhbmQgcGFja2FnZS1tYW5hZ2VyIHBsYW5uaW5nLlxuY29uc3Qgc291cmNlR3JvdXBzID0ge1xuICBhY3F1aXNpdGlvbjogW1xuICAgIFwic3JjL3Rvb2wtZG93bmxvYWRzLnRzXCIsXG4gICAgXCJzcmMvdG9vbC1ob3N0LnRzXCIsXG4gICAgXCJzcmMvcnVudGltZS1idWlsZHMudHNcIixcbiAgICBcInNyYy9zZXZlbi16aXAudHNcIixcbiAgICBcInNyYy9hcnRpZmFjdC1zdHJlYW1zLnRzXCIsXG4gICAgXCJzcmMvYXJjaGl2ZS1leHRyYWN0aW9uLnRzXCIsXG4gICAgXCJzcmMvYXJ0aWZhY3QtZGVjb2RlcnMudHNcIixcbiAgICBcInNyYy9hcnRpZmFjdC1zaWduYXR1cmVzLnRzXCIsXG4gICAgXCJzcmMvYXJ0aWZhY3QtYXR0ZXN0YXRpb25zLnRzXCIsXG4gICAgXCJzcmMvYXR0ZXN0YXRpb24tdmVyaWZpY2F0aW9uLnRzXCIsXG4gICAgXCJzcmMvYXJ0aWZhY3QtcmVwb3NpdG9yaWVzLnRzXCIsXG4gICAgXCJzcmMvYXJ0aWZhY3QtcG9saWN5LnRzXCIsXG4gIF0sXG4gIGZpbHRlcmVkOiBbXCJzcmMvZmlsdGVyZWQtYXJ0aWZhY3RzLnRzXCJdLFxuICB2Y3BrZzogW1wic3JjL3ZjcGtnLnRzXCIsIFwic3JjL212c2MudHNcIl0sXG4gIHJ1Ynk6IFtcInNyYy9ydWJ5LW1hbmFnZXIudHNcIl0sXG4gIHBhY2thZ2VNYW5hZ2VyOiBbXCJzcmMvcGFja2FnZS1tYW5hZ2VyLnRzXCIsIFwic3JjL3Rvb2xjaGFpbnMudHNcIiwgXCJzcmMvdG9vbC1kb3dubG9hZHMudHNcIl0sXG4gIGJ1aWxkczogW1wic3JjL2J1aWxkcy50c1wiXSxcbiAgZ3VpeDpcbiAgICB0YXJnZXQuZW52aXJvbm1lbnQgPT09IFwiZ3VpeFwiXG4gICAgICA/IFtcInNjcmlwdHMvY2ktZ3VpeC1ib290c3RyYXAubWpzXCIsIFwic2NyaXB0cy9jaS1ndWl4LWJvb3RzdHJhcC5zY21cIiwgXCJzY3JpcHRzL21hbmFnZWQtY29udHJhY3QubWpzXCJdXG4gICAgICA6IFtdLFxufTtcbmNvbnN0IHNvdXJjZUZpbGVzID0gWy4uLm5ldyBTZXQoT2JqZWN0LnZhbHVlcyhzb3VyY2VHcm91cHMpLmZsYXQoKSldO1xuY29uc3QgaW5zcGVjdGlvbkRhdGEgPSByZWNvcmQoXG4gIEpTT04ucGFyc2UoXG4gICAgZXhlY0ZpbGVTeW5jKFxuICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgIFtqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSwgXCJjaS1jYWNoZS1pbnNwZWN0XCIsIEpTT04uc3RyaW5naWZ5KHsgdGFyZ2V0LCBzb3VyY2VzOiBzb3VyY2VGaWxlcyB9KV0sXG4gICAgICB7IGVuY29kaW5nOiBcInV0ZjhcIiwgZW52OiB7IC4uLnByb2Nlc3MuZW52LCAuLi52YXJpYWJsZXMgfSwgbWF4QnVmZmVyOiAxNiAqIDEwMjQgKiAxMDI0IH0sXG4gICAgKSxcbiAgKSxcbiAgXCJJbnZhbGlkIGNhY2hlIGluc3BlY3Rpb25cIixcbik7XG5jb25zdCB0b29sID0gKGVudHJ5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFBsYW5uZWRUb29sID0+IHtcbiAgY29uc3QgdmFsdWU6IFBsYW5uZWRUb29sID0ge1xuICAgIHJvb3Q6IHN0cmluZyhlbnRyeS5yb290LCBcIk1pc3NpbmcgdG9vbCByb290XCIpLFxuICAgIHRvb2w6IHN0cmluZyhlbnRyeS50b29sLCBcIk1pc3NpbmcgdG9vbCBuYW1lXCIpLFxuICAgIHZlcnNpb246IHN0cmluZyhlbnRyeS52ZXJzaW9uLCBcIk1pc3NpbmcgdG9vbCB2ZXJzaW9uXCIpLFxuICB9O1xuICBmb3IgKGNvbnN0IGtleSBvZiBbXCJkaXJlY3RvcnlcIiwgXCJwb2xpY3lcIiwgXCJtYW5hZ2VyXCJdIGFzIGNvbnN0KVxuICAgIGlmIChlbnRyeVtrZXldICE9PSB1bmRlZmluZWQpIHZhbHVlW2tleV0gPSBzdHJpbmcoZW50cnlba2V5XSwgXCJJbnZhbGlkIHRvb2wgbWV0YWRhdGFcIik7XG4gIGlmIChlbnRyeS5maWx0ZXJlZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBlbnRyeS5maWx0ZXJlZCAhPT0gXCJib29sZWFuXCIpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgdG9vbCBmaWx0ZXJpbmcgZmxhZ1wiKTtcbiAgICB2YWx1ZS5maWx0ZXJlZCA9IGVudHJ5LmZpbHRlcmVkO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn07XG5jb25zdCBwbGFucyA9ICh2YWx1ZTogdW5rbm93bikgPT5cbiAgcmVjb3Jkcyh2YWx1ZSwgXCJJbnZhbGlkIHRvb2wgcGxhbnNcIikubWFwKChlbnRyeSkgPT4gKHtcbiAgICBwYXRoOiBzdHJpbmcoZW50cnkucGF0aCwgXCJNaXNzaW5nIHBsYW4gcm9vdFwiKSxcbiAgICBwbGFuOiByZWNvcmRzKGVudHJ5LnBsYW4sIFwiSW52YWxpZCBpbnN0YWxsYXRpb24gcGxhblwiKS5tYXAodG9vbCksXG4gIH0pKTtcbmNvbnN0IGluc3BlY3Rpb24gPSB7XG4gIHJldGVudGlvbjogc3RyaW5nUmVjb3JkKGluc3BlY3Rpb25EYXRhLnJldGVudGlvbiwgXCJJbnZhbGlkIGNhY2hlIHJldGVudGlvblwiKSxcbiAgc291cmNlczogc3RyaW5nUmVjb3JkKGluc3BlY3Rpb25EYXRhLnNvdXJjZXMsIFwiSW52YWxpZCBjYWNoZSBzb3VyY2UgaWRlbnRpdGllc1wiKSxcbiAgbmF0aXZlOiBwbGFucyhpbnNwZWN0aW9uRGF0YS5uYXRpdmUpLFxuICBkZWZhdWx0czogcGxhbnMoaW5zcGVjdGlvbkRhdGEuZGVmYXVsdHMpLFxuICBydW50aW1lczogcmVjb3JkcyhpbnNwZWN0aW9uRGF0YS5ydW50aW1lcywgXCJJbnZhbGlkIHJ1bnRpbWUgcGxhbnNcIikubWFwKChlbnRyeSkgPT4ge1xuICAgIGNvbnN0IHBsYW4gPSByZWNvcmQoZW50cnkucGxhbiwgXCJJbnZhbGlkIHJ1bnRpbWUgcGxhblwiKSxcbiAgICAgIHNlbGVjdGVkID0gcmVjb3JkKHBsYW4udG9vbCwgXCJJbnZhbGlkIHJ1bnRpbWUgdG9vbFwiKTtcbiAgICByZXR1cm4ge1xuICAgICAgcGF0aDogc3RyaW5nKGVudHJ5LnBhdGgsIFwiTWlzc2luZyBydW50aW1lIHJvb3RcIiksXG4gICAgICBwbGFuOiB7XG4gICAgICAgIHRvb2w6IHtcbiAgICAgICAgICBuYW1lOiBzdHJpbmcoc2VsZWN0ZWQubmFtZSwgXCJNaXNzaW5nIHJ1bnRpbWUgbmFtZVwiKSxcbiAgICAgICAgICB2ZXJzaW9uOiBzdHJpbmcoc2VsZWN0ZWQudmVyc2lvbiwgXCJNaXNzaW5nIHJ1bnRpbWUgdmVyc2lvblwiKSxcbiAgICAgICAgfSxcbiAgICAgICAgZGlyZWN0b3J5OiBzdHJpbmcocGxhbi5kaXJlY3RvcnksIFwiTWlzc2luZyBydW50aW1lIGRpcmVjdG9yeVwiKSxcbiAgICAgICAgcG9saWN5OiBwbGFuLnBvbGljeSA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogc3RyaW5nKHBsYW4ucG9saWN5LCBcIkludmFsaWQgcnVudGltZSBwb2xpY3lcIiksXG4gICAgICB9LFxuICAgIH07XG4gIH0pLFxuICBtYW5hZ2VyczogcmVjb3JkcyhpbnNwZWN0aW9uRGF0YS5tYW5hZ2VycywgXCJJbnZhbGlkIHBhY2thZ2UgbWFuYWdlciBwbGFuc1wiKS5tYXAoKGVudHJ5KSA9PiAoe1xuICAgIGlkZW50aXR5OiBzdHJpbmcoZW50cnkuaWRlbnRpdHksIFwiTWlzc2luZyBtYW5hZ2VyIGlkZW50aXR5XCIpLFxuICAgIGRpcmVjdG9yeTogc3RyaW5nKGVudHJ5LmRpcmVjdG9yeSwgXCJNaXNzaW5nIG1hbmFnZXIgZGlyZWN0b3J5XCIpLFxuICB9KSksXG59O1xuY29uc3QgcmV0YWluZWQgPSAodG9vbDogc3RyaW5nKSA9PlxuICBpbnNwZWN0aW9uLnJldGVudGlvblt0b29sXSA/IGluc3BlY3Rpb24ucmV0ZW50aW9uW3Rvb2xdID09PSBcImNhY2hlXCIgOiAhcmVkb3dubG9hZC5oYXModG9vbCk7XG5jb25zdCBydW50aW1lT25seSA9IFtcIm5vZGVcIiwgXCJnb1wiLCBcImphdmFcIiwgXCJydWJ5XCIsIFwicGhwXCJdLmluY2x1ZGVzKHRhcmdldC5ydW50aW1lID8/IFwiXCIpO1xuY29uc3QgbWFuYWdlZCA9IHRhcmdldC5lbnZpcm9ubWVudCAmJiB0YXJnZXQuZW52aXJvbm1lbnQgIT09IFwiZGV2Y29udGFpbmVyXCI7XG5pbnRlcmZhY2UgUGxhbm5lZFRvb2wge1xuICByb290OiBzdHJpbmc7XG4gIHRvb2w6IHN0cmluZztcbiAgdmVyc2lvbjogc3RyaW5nO1xuICBkaXJlY3Rvcnk/OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGZpbHRlcmVkPzogYm9vbGVhbjtcbiAgcG9saWN5Pzogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBtYW5hZ2VyPzogc3RyaW5nO1xufVxuY29uc3QgcGxhbjogUGxhbm5lZFRvb2xbXSA9IGluc3BlY3Rpb24ubmF0aXZlXG4gIC5mbGF0TWFwKCh7IHBsYW4gfSkgPT4gcGxhbilcbiAgLmZpbHRlcigoZW50cnk6IHsgdG9vbDogc3RyaW5nIH0pID0+XG4gICAgdGFyZ2V0LnJ1bnRpbWUgPT09IFwicHl0aG9uXCJcbiAgICAgID8gZW50cnkudG9vbCA9PT0gXCJ1dlwiXG4gICAgICA6IHRhcmdldC5ydW50aW1lID09PSBcInJ1c3RcIlxuICAgICAgICA/IGZhbHNlXG4gICAgICAgIDogdGFyZ2V0LmVudmlyb25tZW50ID09PSBcImRldmNvbnRhaW5lclwiXG4gICAgICAgICAgPyBlbnRyeS50b29sID09PSBcIm5vZGVcIlxuICAgICAgICAgIDogdHJ1ZSxcbiAgKTtcbmlmIChydW50aW1lT25seSkge1xuICBmb3IgKGNvbnN0IHsgcGF0aDogcm9vdCwgcGxhbjogcnVudGltZSB9IG9mIGluc3BlY3Rpb24ucnVudGltZXMpIHtcbiAgICBpZiAodGFyZ2V0LnJ1bnRpbWUgPT09IFwiamF2YVwiKVxuICAgICAgcGxhbi5wdXNoKFxuICAgICAgICAuLi5yZXF1aXJlZChcbiAgICAgICAgICBpbnNwZWN0aW9uLmRlZmF1bHRzLmZpbmQoKGVudHJ5KSA9PiBlbnRyeS5wYXRoID09PSByb290KSxcbiAgICAgICAgICBgTWlzc2luZyBkZWZhdWx0cyBmb3IgJHtyb290fWAsXG4gICAgICAgICkucGxhbi5maWx0ZXIoKGVudHJ5OiB7IHRvb2w6IHN0cmluZyB9KSA9PiBlbnRyeS50b29sID09PSBcIm1hdmVuXCIpLFxuICAgICAgKTtcbiAgICBwbGFuLnB1c2goe1xuICAgICAgcm9vdCxcbiAgICAgIHRvb2w6IHJ1bnRpbWUudG9vbC5uYW1lLFxuICAgICAgdmVyc2lvbjogcnVudGltZS50b29sLnZlcnNpb24sXG4gICAgICBkaXJlY3Rvcnk6IHJ1bnRpbWUuZGlyZWN0b3J5LFxuICAgICAgZmlsdGVyZWQ6IGZhbHNlLFxuICAgICAgcG9saWN5OiBydW50aW1lLnBvbGljeSxcbiAgICB9KTtcbiAgfVxufVxuY29uc3Qgb3JkaW5hcnkgPSBwbGFuLmZpbHRlcihcbiAgKGVudHJ5KSA9PlxuICAgIHR5cGVvZiBlbnRyeS5kaXJlY3RvcnkgPT09IFwic3RyaW5nXCIgJiZcbiAgICAoIWVudHJ5LmZpbHRlcmVkIHx8IGVudHJ5LnRvb2wgPT09IFwiZ2NjXCIpICYmXG4gICAgcmV0YWluZWQoZW50cnkudG9vbCkgJiZcbiAgICAhW1wibGx2bS1ydW50aW1lXCIsIFwibGx2bS14bWwtcnVudGltZVwiXS5pbmNsdWRlcyhlbnRyeS50b29sKSAmJlxuICAgICh0YXJnZXQucnVudGltZSAhPT0gXCJweXRob25cIiB8fCBlbnRyeS50b29sID09PSBcInV2XCIpLFxuKTtcbmNvbnN0IHBvbGljaWVzID0gKGVudHJpZXM6IHR5cGVvZiBwbGFuKSA9PlxuICBbXG4gICAgLi4ubmV3IE1hcChcbiAgICAgIGVudHJpZXNcbiAgICAgICAgLmZpbHRlcigoZW50cnkpID0+IHR5cGVvZiBlbnRyeS5kaXJlY3RvcnkgPT09IFwic3RyaW5nXCIpXG4gICAgICAgIC5tYXAoKGVudHJ5KSA9PiBbXG4gICAgICAgICAgZW50cnkuZGlyZWN0b3J5LFxuICAgICAgICAgIFtlbnRyeS50b29sLCBlbnRyeS52ZXJzaW9uLCBlbnRyeS5wb2xpY3ksIGJhc2VuYW1lKHJlcXVpcmVkKGVudHJ5LmRpcmVjdG9yeSwgXCJNaXNzaW5nIHRvb2wgZGlyZWN0b3J5XCIpKV0sXG4gICAgICAgIF0pLFxuICAgICkudmFsdWVzKCksXG4gIF0uc29ydCgoYSwgYikgPT4gSlNPTi5zdHJpbmdpZnkoYSkubG9jYWxlQ29tcGFyZShKU09OLnN0cmluZ2lmeShiKSkpO1xuY29uc3Qgc291cmNlSW5wdXRzID0gKGZpbGVzOiBzdHJpbmdbXSkgPT4gZmlsZXMubWFwKChmaWxlOiBzdHJpbmcgfCBudW1iZXIpID0+IFtmaWxlLCBpbnNwZWN0aW9uLnNvdXJjZXNbZmlsZV1dKTtcbmNvbnN0IGFjcXVpc2l0aW9uQ29kZSA9IHNvdXJjZUlucHV0cyhzb3VyY2VHcm91cHMuYWNxdWlzaXRpb24pO1xuY29uc3QgdmNwa2cgPVxuICAodGFyZ2V0LnJ1bnRpbWUgJiYgIWlzQ29tcGlsZXJGYW1pbHkodGFyZ2V0LnJ1bnRpbWUpKSB8fCBtYW5hZ2VkXG4gICAgPyBbXVxuICAgIDogWy4uLm5ldyBTZXQoaW5wdXRzKFtcIi52Y3BrZy12ZXJzaW9uXCJdKS5tYXAoKFssIHJldmlzaW9uXSkgPT4gcmV2aXNpb24udHJpbSgpKSldLnNvcnQoKTtcbmNvbnN0IHZjcGtnUGF0aHMgPSBbLi4ubmV3IFNldCh2Y3BrZy5tYXAoKHJldmlzaW9uKSA9PiBqb2luKGNhY2hlLCBcInRvb2xjaGFpbnNcIiwgXCJ2Y3BrZ1wiLCByZXZpc2lvbiwgcGxhdGZvcm0pKSldO1xuY29uc3QgcHl0aG9uUGF0aHMgPVxuICAhd2luZG93cyAmJiAodGFyZ2V0LnJ1bnRpbWUgPT09IFwicHl0aG9uXCIgfHwgKCF0YXJnZXQucnVudGltZSAmJiAhbWFuYWdlZCAmJiBpbnB1dHMoW1wiLnB5dGhvbi12ZXJzaW9uXCJdKS5sZW5ndGgpKVxuICAgID8gW2pvaW4oY2FjaGUsIFwidXYtcHl0aG9uXCIsIFwicHl0aG9uXCIpXVxuICAgIDogW107XG5jb25zdCBkZXZjb250YWluZXJSdW50aW1lczogUGxhbm5lZFRvb2xbXSA9XG4gIHRhcmdldC5lbnZpcm9ubWVudCA9PT0gXCJkZXZjb250YWluZXJcIlxuICAgID8gcm9vdHNcbiAgICAgICAgLmZsYXRNYXAoXG4gICAgICAgICAgKHJvb3QpID0+XG4gICAgICAgICAgICByZXF1aXJlZChcbiAgICAgICAgICAgICAgaW5zcGVjdGlvbi5kZWZhdWx0cy5maW5kKChlbnRyeSkgPT4gZW50cnkucGF0aCA9PT0gcm9vdCksXG4gICAgICAgICAgICAgIGBNaXNzaW5nIGRlZmF1bHRzIGZvciAke3Jvb3R9YCxcbiAgICAgICAgICAgICkucGxhbixcbiAgICAgICAgKVxuICAgICAgICAuZmlsdGVyKChlbnRyeTogeyB0b29sOiBzdHJpbmcgfSkgPT4gIVtcInJ1c3RcIiwgXCJtaXJpXCIsIFwicHl0aG9uXCJdLmluY2x1ZGVzKGVudHJ5LnRvb2wpKVxuICAgIDogW107XG5jb25zdCBjYWNoZWREZXZjb250YWluZXJSdW50aW1lcyA9IGRldmNvbnRhaW5lclJ1bnRpbWVzLmZpbHRlcigoZW50cnkpID0+IHJldGFpbmVkKGVudHJ5LnRvb2wpKTtcbi8vIEd1ZXN0IE9TIGlkZW50aXRpZXMgYXJlIHJlc29sdmVkIGFmdGVyIHN0YXJ0dXA7IHJldGFpbiBvbmx5IHNlbGVjdGVkIHRvb2wgdmVyc2lvbnMgYWNyb3NzIHRob3NlIGlkZW50aXRpZXMuXG5jb25zdCBkZXZjb250YWluZXJSdW50aW1lUGF0aHMgPSBbXG4gIC4uLm5ldyBTZXQoXG4gICAgY2FjaGVkRGV2Y29udGFpbmVyUnVudGltZXNcbiAgICAgIC5maWx0ZXIoXG4gICAgICAgIChlbnRyeSkgPT5cbiAgICAgICAgICAoIWVudHJ5LmZpbHRlcmVkIHx8IGVudHJ5LnRvb2wgPT09IFwiZ2NjXCIpICYmICFbXCJsbHZtLXJ1bnRpbWVcIiwgXCJsbHZtLXhtbC1ydW50aW1lXCJdLmluY2x1ZGVzKGVudHJ5LnRvb2wpLFxuICAgICAgKVxuICAgICAgLm1hcCgoZW50cnkpID0+IChlbnRyeS50b29sID09PSBcImdjY1wiID8gZW50cnkuZGlyZWN0b3J5IDogam9pbihjYWNoZSwgXCJ0b29sY2hhaW5zXCIsIGVudHJ5LnRvb2wsIGVudHJ5LnZlcnNpb24pKSksXG4gICksXG5dLnNvcnQoKTtcbmNvbnN0IHRvb2xzID0gaGFzaChbXG4gIHBvbGljaWVzKGNhY2hlZERldmNvbnRhaW5lclJ1bnRpbWVzKSxcbiAgdGFyZ2V0LmVudmlyb25tZW50ID09PSBcImRldmNvbnRhaW5lclwiXG4gICAgPyBbXCIuZGV2Y29udGFpbmVyL0RvY2tlcmZpbGVcIiwgXCIuZGV2Y29udGFpbmVyL2RldmNvbnRhaW5lci5qc29uXCJdXG4gICAgICAgIC5maWx0ZXIoKGZpbGUpID0+IGV4aXN0c1N5bmMoZmlsZSkpXG4gICAgICAgIC5tYXAoKGZpbGUpID0+IFtmaWxlLCByZWFkRmlsZVN5bmMoZmlsZSwgXCJ1dGY4XCIpXSlcbiAgICA6IFtdLFxuICBkZXZjb250YWluZXJSdW50aW1lUGF0aHMsXG4gIHBpbklucHV0cyhbXCIucnVieS12ZXJzaW9uXCIsIFwiLnBocC12ZXJzaW9uXCJdKSxcbiAgWy4uLm9yZGluYXJ5LCAuLi5jYWNoZWREZXZjb250YWluZXJSdW50aW1lc10uc29tZSgoZW50cnkpID0+IGVudHJ5LmZpbHRlcmVkKVxuICAgID8gc291cmNlSW5wdXRzKHNvdXJjZUdyb3Vwcy5maWx0ZXJlZClcbiAgICA6IFtdLFxuICBwb2xpY2llcyhvcmRpbmFyeSksXG4gIGFjcXVpc2l0aW9uQ29kZSxcbiAgdmNwa2csXG4gIHZjcGtnLmxlbmd0aCA/IHNvdXJjZUlucHV0cyhzb3VyY2VHcm91cHMudmNwa2cpIDogW10sXG4gIHB5dGhvblBhdGhzLmxlbmd0aFxuICAgID8gW3BpbklucHV0cyhbXCIucHl0aG9uLXZlcnNpb25cIl0pLCB0YXJnZXQucnVudGltZSA9PT0gXCJweXRob25cIiA/IHRhcmdldC52ZXJzaW9uIDogdW5kZWZpbmVkXVxuICAgIDogdW5kZWZpbmVkLFxuXSk7XG5jb25zdCBtYW5hZ2VycyA9IGluc3BlY3Rpb24ubWFuYWdlcnM7XG5jb25zdCBtYW5hZ2VyS2V5ID0gaGFzaChbXG4gIFsuLi5uZXcgU2V0KG1hbmFnZXJzLm1hcCgoZW50cnkpID0+IGVudHJ5LmlkZW50aXR5KSldLnNvcnQoKSxcbiAgaW5wdXRzKFtcIkdlbWZpbGUubG9ja1wiXSksXG4gIHNvdXJjZUlucHV0cyhzb3VyY2VHcm91cHMucnVieSksXG4gIHNvdXJjZUlucHV0cyhzb3VyY2VHcm91cHMucGFja2FnZU1hbmFnZXIpLFxuXSk7XG5jb25zdCBtYW5pZmVzdHMgPSBpbnB1dHMoW1xuICBcIkdlbWZpbGVcIixcbiAgXCJHZW1maWxlLmxvY2tcIixcbiAgXCJjb21wb3Nlci5qc29uXCIsXG4gIFwiY29tcG9zZXIubG9ja1wiLFxuICBcIi5jb21wb3Nlci9jaGVja3N1bXMuanNvblwiLFxuICBcIi5jb21wb3Nlci92ZXJpZnkvY29tcG9zZXIuanNvblwiLFxuICBcIi5jb21wb3Nlci92ZXJpZnkvc3JjL1ZlcmlmeVBsdWdpbi5waHBcIixcbiAgXCJ0b29scy9jb21wb3Nlci5qc29uXCIsXG4gIFwidG9vbHMvY29tcG9zZXIubG9ja1wiLFxuICBcInRvb2xzLy5jb21wb3Nlci9jaGVja3N1bXMuanNvblwiLFxuICBcInRvb2xzL2NvbXBhdC9jb21wb3Nlci5qc29uXCIsXG4gIFwidG9vbHMvY29tcGF0L2NvbXBvc2VyLmxvY2tcIixcbiAgXCJ0b29scy9jb21wYXQvLmNvbXBvc2VyL2NoZWNrc3Vtcy5qc29uXCIsXG4gIFwicGFja2FnZS5qc29uXCIsXG4gIFwicG5wbS1sb2NrLnlhbWxcIixcbiAgXCJwbnBtLXdvcmtzcGFjZS55YW1sXCIsXG4gIFwicHlwcm9qZWN0LnRvbWxcIixcbiAgXCJ1di5sb2NrXCIsXG4gIFwiZ28ubW9kXCIsXG4gIFwiZ28uc3VtXCIsXG4gIFwiQ2FyZ28udG9tbFwiLFxuICBcIkNhcmdvLmxvY2tcIixcbiAgXCJ2Y3BrZy1jb25maWd1cmF0aW9uLmpzb25cIixcbiAgXCJ2Y3BrZy5qc29uXCIsXG4gIFwicG9tLnhtbFwiLFxuICBcIi5tdm4vY2hlY2tzdW1zL2NoZWNrc3Vtcy5zaGEyNTZcIixcbiAgXCIubXZuL3NldHRpbmdzLnhtbFwiLFxuICBcIi5tdm4vbWF2ZW4uY29uZmlnXCIsXG4gIFwiLm12bi9qdm0uY29uZmlnXCIsXG5dKTtcbi8vIERvd25sb2FkIHN0b3JlcyB2YWxpZGF0ZSB0aGVpciBjb250ZW50cyB0aHJvdWdoIHRoZWlyIG93bmluZyBwYWNrYWdlIG1hbmFnZXJzLlxuLy8gSW5zdGFsbGVyIGVkaXRzIGFuZCBydW50aW1lIHBhdGNoIHNlbGVjdGlvbnMgbXVzdCBub3QgaW52YWxpZGF0ZSB0aG9zZSBzdG9yZXMuXG5jb25zdCBkb3dubG9hZHMgPSBoYXNoKG1hbmlmZXN0cyk7XG5jb25zdCBidWlsZHMgPSBoYXNoKFtcbiAgbWFuaWZlc3RzLFxuICBpbnB1dHMoW1xuICAgIFwiQ01ha2VMaXN0cy50eHRcIixcbiAgICBcIi5sbHZtLXZlcnNpb25cIixcbiAgICBcIi5nY2MtdmVyc2lvblwiLFxuICAgIFwiLm12c2MtdmVyc2lvblwiLFxuICAgIFwiLndpbmRvd3Mtc2RrLXZlcnNpb25cIixcbiAgICBcInJ1c3QtdG9vbGNoYWluLnRvbWxcIixcbiAgICBcIi5weXRob24tdmVyc2lvblwiLFxuICAgIFwiLmdvLXZlcnNpb25cIixcbiAgICBcIi5ub2RlLXZlcnNpb25cIixcbiAgICBcIi5qYXZhLXZlcnNpb25cIixcbiAgICBcIi5ydWJ5LXZlcnNpb25cIixcbiAgICBcIi5waHAtdmVyc2lvblwiLFxuICAgIFwiLmNvbXBvc2VyLXZlcnNpb25cIixcbiAgICBcIi54ZGVidWctdmVyc2lvblwiLFxuICBdKSxcbiAgdGFyZ2V0LmVudmlyb25tZW50ID8gaW5wdXRzKFtcImZsYWtlLm5peFwiLCBcImZsYWtlLmxvY2tcIiwgXCJtYW5pZmVzdC5zY21cIl0pIDogdW5kZWZpbmVkLFxuICB0YXJnZXQuZW52aXJvbm1lbnQgPT09IFwiZ3VpeFwiID8gZ3VpeENoYW5uZWxzIDogdW5kZWZpbmVkLFxuICByZWFkRmlsZVN5bmMoXCJ3b3JrYmVuY2gvcHJvamVjdHMudG9tbFwiLCBcInV0ZjhcIiksXG4gIC8vIFJlZG93bmxvYWRlZCBndWVzdCB0b29scyBzdGlsbCBkZXRlcm1pbmUgY29tcGlsZWQtb3V0cHV0IGNvbXBhdGliaWxpdHkuXG4gIHBvbGljaWVzKGRldmNvbnRhaW5lclJ1bnRpbWVzKSxcbiAgcG9saWNpZXMocGxhbiksXG4gIGFjcXVpc2l0aW9uQ29kZSxcbiAgc291cmNlSW5wdXRzKHNvdXJjZUdyb3Vwcy5idWlsZHMpLFxuICB0b29scyxcbiAgdGFyZ2V0LnJ1bnRpbWUsXG4gIHRhcmdldC52ZXJzaW9uLFxuICB0YXJnZXQuZW52aXJvbm1lbnQsXG4gIGlucHV0cyhbXCIuZGV2Y29udGFpbmVyL2RldmNvbnRhaW5lci5qc29uXCIsIFwiLmRldmNvbnRhaW5lci9Eb2NrZXJmaWxlXCJdKSxcbl0pO1xuY29uc3QgbWVhc3VyZWRQbGFuOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4vLyBDYWNoZSBlbnRyaWVzIGFyZSBpbW11dGFibGU6IGNoYW5naW5nIHRoZSBlbmNvZGVyIGxldmVsIG11c3QgY3JlYXRlIGEgbmV3IGlkZW50aXR5LlxuY29uc3QgY29tcHJlc3Npb25MZXZlbCA9IHByb2Nlc3MuZW52LlpTVERfQ0xFVkVMID8/IFwiM1wiO1xuaWYgKCEvXig/OlsxLTldfDFbMC05XSkkLy50ZXN0KGNvbXByZXNzaW9uTGV2ZWwpKSB0aHJvdyBuZXcgRXJyb3IoXCJaU1REX0NMRVZFTCBtdXN0IGJlIGFuIGludGVnZXIgZnJvbSAxIHRvIDE5XCIpO1xuY29uc3Qgb3V0cHV0ID0gKGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKSA9PiB7XG4gIGlmIChrZXkuZW5kc1dpdGgoXCIta2V5XCIpKSB7XG4gICAgLy8gUmV1c2UgaWRlbnRpY2FsIGNvbnRlbnRzIHNhdmVkIHdpdGggYW4gb2xkZXIgY29tcHJlc3Npb24gcG9saWN5IGJlZm9yZSBzYXZpbmcgdGhlIG5ldyBrZXkuXG4gICAgb3V0cHV0KGtleS5yZXBsYWNlKC8ta2V5JC8sIFwiLXJlc3RvcmUta2V5c1wiKSwgdmFsdWUpO1xuICAgIHZhbHVlICs9IGAtenN0ZCR7Y29tcHJlc3Npb25MZXZlbH1gO1xuICB9XG4gIG1lYXN1cmVkUGxhbltrZXldID0gdmFsdWU7XG4gIGFwcGVuZEZpbGVTeW5jKFxuICAgIHJlcXVpcmVkKHByb2Nlc3MuZW52LkdJVEhVQl9PVVRQVVQsIFwiR0lUSFVCX09VVFBVVCBpcyByZXF1aXJlZFwiKSxcbiAgICBgJHtrZXl9PDxXT1JLQkVOQ0hfQ0FDSEVcXG4ke3ZhbHVlfVxcbldPUktCRU5DSF9DQUNIRVxcbmAsXG4gICk7XG59O1xuaWYgKG9yZGluYXJ5Lmxlbmd0aCB8fCB2Y3BrZ1BhdGhzLmxlbmd0aCB8fCBweXRob25QYXRocy5sZW5ndGggfHwgZGV2Y29udGFpbmVyUnVudGltZVBhdGhzLmxlbmd0aClcbiAgLy8gRG8gbm90IHJlc3RvcmUgdGhlIGJyb2FkZXIgaW5zdGFsbGF0aW9uIGFyY2hpdmVzIGZyb20gZWFybGllciBsYXlvdXRzLlxuICBvdXRwdXQoXCJ0b29scy1rZXlcIiwgYHRvb2xzLXY4LSR7cGxhdGZvcm19LSR7dG9vbHN9YCk7XG5vdXRwdXQoXG4gIFwidG9vbHMtcGF0aHNcIixcbiAgW1xuICAgIC4uLm5ldyBTZXQoW1xuICAgICAgLi4ub3JkaW5hcnkubWFwKChlbnRyeSkgPT4gZW50cnkuZGlyZWN0b3J5KSxcbiAgICAgIC4uLmRldmNvbnRhaW5lclJ1bnRpbWVQYXRocyxcbiAgICAgIC4uLnZjcGtnUGF0aHMsXG4gICAgICAuLi5weXRob25QYXRocyxcbiAgICAgIC4uLihpbnB1dHMoW1wiLnhkZWJ1Zy12ZXJzaW9uXCJdKS5sZW5ndGggPyBbam9pbihjYWNoZSwgXCJ0b29sY2hhaW5zL3hkZWJ1Z1wiKV0gOiBbXSksXG4gICAgXSksXG4gIF0uam9pbihcIlxcblwiKSxcbik7XG5pZiAobWFuYWdlcnMubGVuZ3RoIHx8IGlucHV0cyhbXCJHZW1maWxlLmxvY2tcIl0pLmxlbmd0aCkge1xuICBvdXRwdXQoXCJwYWNrYWdlLW1hbmFnZXJzLWtleVwiLCBgcGFja2FnZS1tYW5hZ2Vycy12MS0ke3BsYXRmb3JtfS0ke21hbmFnZXJLZXl9YCk7XG4gIG91dHB1dChcbiAgICBcInBhY2thZ2UtbWFuYWdlcnMtcGF0aHNcIixcbiAgICBbXG4gICAgICAuLi5uZXcgU2V0KFtcbiAgICAgICAgLi4ubWFuYWdlcnMubWFwKChlbnRyeSkgPT4gZW50cnkuZGlyZWN0b3J5KSxcbiAgICAgICAgLi4uKGlucHV0cyhbXCJHZW1maWxlLmxvY2tcIl0pLmxlbmd0aCA/IFtqb2luKGNhY2hlLCBcInBhY2thZ2UtbWFuYWdlcnMvYnVuZGxlclwiKV0gOiBbXSksXG4gICAgICBdKSxcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICk7XG59XG5vdXRwdXQoXCJkb3dubG9hZHMta2V5XCIsIGBkb3dubG9hZHMtdiR7U3RyaW5nKHdpbmRvd3MgPyAyIDogMSl9LSR7cGxhdGZvcm19LSR7ZG93bmxvYWRzfWApO1xub3V0cHV0KFxuICBcImRvd25sb2Fkcy1wYXRoc1wiLFxuICBbXG4gICAgLi4uW1widXZcIiwgXCJnby1tb2RcIiwgXCJucG1cIiwgXCJwaXBcIl0ubWFwKChuYW1lKSA9PiBqb2luKGNhY2hlLCBuYW1lKSksXG4gICAgam9pbihjYWNoZSwgXCJkb3dubG9hZHNcIiwgXCJwbnBtXCIpLFxuICAgIC4uLih3aW5kb3dzID8gW2pvaW4oY2FjaGUsIFwiZG93bmxvYWRzXCIsIFwidXYtcHl0aG9uXCIpXSA6IFtdKSxcbiAgICBqb2luKGNhY2hlLCBcImRvd25sb2Fkc1wiLCBcIm1hdmVuXCIpLFxuICAgIGpvaW4oY2FjaGUsIFwiZG93bmxvYWRzXCIsIFwiY29tcG9zZXJcIiksXG4gICAgam9pbihjYWNoZSwgXCJkb3dubG9hZHNcIiwgXCJidW5kbGVyXCIpLFxuICAgIGpvaW4oY2FjaGUsIFwidmNwa2dcIiwgXCJkb3dubG9hZHNcIiksXG4gICAgam9pbihyZXF1aXJlZCh2YXJpYWJsZXMuQ0FSR09fSE9NRSwgXCJNaXNzaW5nIENBUkdPX0hPTUVcIiksIFwicmVnaXN0cnlcIiksXG4gICAgam9pbihyZXF1aXJlZCh2YXJpYWJsZXMuQ0FSR09fSE9NRSwgXCJNaXNzaW5nIENBUkdPX0hPTUVcIiksIFwiZ2l0XCIpLFxuICBdLmpvaW4oXCJcXG5cIiksXG4pO1xuLy8gdjIgb21pdHMgaW5zdGFsbGVkIGRlcGVuZGVuY2llczsgZG8gbm90IHJlc3RvcmUgYXJjaGl2ZXMgZnJvbSB0aGUgYnJvYWRlciB2MSBsYXlvdXQuXG5vdXRwdXQoXCJidWlsZHMta2V5XCIsIGBidWlsZHMtdjItJHtwbGF0Zm9ybX0tJHtidWlsZHN9YCk7XG5vdXRwdXQoXCJidWlsZHMtcGF0aHNcIiwgY2lCdWlsZENhY2hlUGF0aHMoY2FjaGUsIHRhcmdldC5lbnZpcm9ubWVudCkuam9pbihcIlxcblwiKSk7XG4vLyBUaGUgc2FtZSBjaGFubmVsIGhpc3RvcnkgaXMgcmV1c2FibGUgYWNyb3NzIGFueSByb290cyBkZWNsYXJpbmcgdGhvc2UgY2hhbm5lbHMuXG5vdXRwdXQoXCJndWl4LWtleVwiLCBgZ3VpeC1zb3VyY2UtdjItJHtwbGF0Zm9ybX0tJHtoYXNoKGd1aXhDaGFubmVscyl9YCk7XG5vdXRwdXQoXCJndWl4LXBhdGhzXCIsIFtcImNoZWNrb3V0c1wiLCBcImF1dGhlbnRpY2F0aW9uXCJdLm1hcCgobmFtZSkgPT4gam9pbihob21lZGlyKCksIFwiLmNhY2hlXCIsIFwiZ3VpeFwiLCBuYW1lKSkuam9pbihcIlxcblwiKSk7XG5pZiAodGFyZ2V0LmVudmlyb25tZW50ID09PSBcImd1aXhcIikge1xuICBvdXRwdXQoXG4gICAgXCJndWl4LWJvb3RzdHJhcC1rZXlcIixcbiAgICBgZ3VpeC1ib290c3RyYXAtdjEtJHtwbGF0Zm9ybX0tJHtoYXNoKFtndWl4Q2hhbm5lbHMsIHNvdXJjZUlucHV0cyhzb3VyY2VHcm91cHMuZ3VpeCldKX1gLFxuICApO1xuICBvdXRwdXQoXCJndWl4LWJvb3RzdHJhcC1wYXRoXCIsIGpvaW4oY2FjaGUsIFwiZ3VpeC1ib290c3RyYXBcIikpO1xufVxuXG4vLyBLZWVwIHRoZSBkZXZlbG9wbWVudCBTREsgcmV1c2FibGUgd2hlbiBhbiBvbGRlciBjb21wYXRpYmlsaXR5IGNvbXBpbGVyIGlzIHNlbGVjdGVkLlxuLy8gRGV2IENvbnRhaW5lcnMgdXNlIHRoZSBzYW1lIGltbXV0YWJsZSBMTFZNIGFydGlmYWN0cyBhbmQgbGFuZ3VhZ2Utb3duZWQgZmlsdGVycy5cbmNvbnN0IGxsdm0gPSBbLi4ucGxhbiwgLi4uZGV2Y29udGFpbmVyUnVudGltZXNdLmZpbHRlcigoZW50cnkpID0+XG4gIFtcImxsdm1cIiwgXCJjbGFuZ1wiLCBcImxsdm0tcnVudGltZVwiLCBcImxsdm0teG1sLXJ1bnRpbWVcIl0uaW5jbHVkZXMoZW50cnkudG9vbCksXG4pO1xuZm9yIChjb25zdCBbZ3JvdXAsIGVudHJpZXNdIG9mIFtcbiAgW1wibGx2bVwiLCBsbHZtLmZpbHRlcigoZW50cnkpID0+ICFbXCJjbGFuZ1wiLCBcImxsdm0teG1sLXJ1bnRpbWVcIl0uaW5jbHVkZXMoZW50cnkudG9vbCkpXSxcbiAgW1wiY2xhbmdcIiwgbGx2bS5maWx0ZXIoKGVudHJ5KSA9PiBbXCJjbGFuZ1wiLCBcImxsdm0teG1sLXJ1bnRpbWVcIl0uaW5jbHVkZXMoZW50cnkudG9vbCkpXSxcbl0gYXMgY29uc3QpIHtcbiAgaWYgKCFlbnRyaWVzLmxlbmd0aCB8fCAhcmV0YWluZWQoZ3JvdXApKSBjb250aW51ZTtcbiAgb3V0cHV0KFxuICAgIGAke2dyb3VwfS1rZXlgLFxuICAgIGAke2dyb3VwfS12My0ke3BsYXRmb3JtfS0ke2hhc2goW3BvbGljaWVzKGVudHJpZXMpLCBhY3F1aXNpdGlvbkNvZGUsIHNvdXJjZUlucHV0cyhzb3VyY2VHcm91cHMuZmlsdGVyZWQpXSl9YCxcbiAgKTtcbiAgb3V0cHV0KGAke2dyb3VwfS1wYXRoc2AsIFsuLi5uZXcgU2V0KGVudHJpZXMubWFwKChlbnRyeSkgPT4gZW50cnkuZGlyZWN0b3J5KSldLmpvaW4oXCJcXG5cIikpO1xufVxuXG5jb25zdCBydXN0UGlucyA9IG1hbmFnZWRcbiAgPyBbXVxuICA6IHRhcmdldC5ydW50aW1lID09PSBcInJ1c3RcIlxuICAgID8gW3sgY2hhbm5lbDogcmVxdWlyZWQodGFyZ2V0LnZlcnNpb24sIFwiTWlzc2luZyBSdXN0IHZlcnNpb25cIiksIHByb2ZpbGU6IFwibWluaW1hbFwiLCBjb21wb25lbnRzOiBbXSwgdGFyZ2V0czogW10gfV1cbiAgICA6IHRhcmdldC5ydW50aW1lXG4gICAgICA/IFtdXG4gICAgICA6IHJvb3RzXG4gICAgICAgICAgLmZsYXRNYXAoXG4gICAgICAgICAgICAocm9vdCkgPT5cbiAgICAgICAgICAgICAgcmVxdWlyZWQoXG4gICAgICAgICAgICAgICAgaW5zcGVjdGlvbi5kZWZhdWx0cy5maW5kKChlbnRyeSkgPT4gZW50cnkucGF0aCA9PT0gcm9vdCksXG4gICAgICAgICAgICAgICAgYE1pc3NpbmcgZGVmYXVsdHMgZm9yICR7cm9vdH1gLFxuICAgICAgICAgICAgICApLnBsYW4sXG4gICAgICAgICAgKVxuICAgICAgICAgIC5maWx0ZXIoKGVudHJ5OiB7IHRvb2w6IHN0cmluZyB9KSA9PiBlbnRyeS50b29sID09PSBcInJ1c3RcIilcbiAgICAgICAgICAubWFwKChlbnRyeSkgPT4gKHsgY2hhbm5lbDogZW50cnkudmVyc2lvbiB9KSk7XG5pZiAocnVzdFBpbnMubGVuZ3RoICYmIHJldGFpbmVkKFwicnVzdFwiKSkge1xuICBvdXRwdXQoXG4gICAgXCJydXN0LWtleVwiLFxuICAgIGBydXN0LXYyLSR7cGxhdGZvcm19LSR7aGFzaChbWy4uLm5ldyBTZXQocnVzdFBpbnMubWFwKChwaW4pID0+IEpTT04uc3RyaW5naWZ5KHBpbikpKV0uc29ydCgpLCBwaW5JbnB1dHMoW1wicnVzdC10b29sY2hhaW4udG9tbFwiXSksIHJlYWRGaWxlU3luYyhqb2luKGRpc3RyaWJ1dGlvbiwgXCJzY3JpcHRzL2Jvb3RzdHJhcC10b29scy5qc29uXCIpLCBcInV0ZjhcIiksIGFjcXVpc2l0aW9uQ29kZV0pfWAsXG4gICk7XG4gIG91dHB1dChcbiAgICBcInJ1c3QtcGF0aHNcIixcbiAgICBbXG4gICAgICAuLi5uZXcgU2V0KFxuICAgICAgICBydXN0UGlucy5tYXAoKHBpbikgPT5cbiAgICAgICAgICBqb2luKHJlcXVpcmVkKHZhcmlhYmxlcy5SVVNUVVBfSE9NRSwgXCJNaXNzaW5nIFJVU1RVUF9IT01FXCIpLCBcInRvb2xjaGFpbnNcIiwgYCR7cGluLmNoYW5uZWx9LSpgKSxcbiAgICAgICAgKSxcbiAgICAgICksXG4gICAgICBqb2luKHJlcXVpcmVkKHZhcmlhYmxlcy5DQVJHT19IT01FLCBcIk1pc3NpbmcgQ0FSR09fSE9NRVwiKSwgXCJiaW5cIiksXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICApO1xufVxuXG53cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCJjYWNoZS1wbGFuLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KG1lYXN1cmVkUGxhbiwgbnVsbCwgMikgKyBcIlxcblwiKTtcbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsd0JBQXdCO0FBQ2pDLFNBQVMsVUFBVSxRQUFRLFNBQVMsUUFBUSxTQUFTLG9CQUFvQjtBQUV6RSxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLG9CQUFvQjtBQUM3QixT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
