// Generated from ci-cache.mts; edit the TypeScript source.
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
  vcpkg: ["src/vcpkg.ts"],
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
const vcpkg = target.runtime && !["clang", "gcc"].includes(target.runtime ?? "") || managed ? [] : [...new Set(inputs([".vcpkg-version"]).map(([, revision]) => revision.trim()))].sort();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLWNhY2hlLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXF1aXJlZCwgcmVjb3JkLCByZWNvcmRzLCBzdHJpbmcsIHN0cmluZ3MsIHN0cmluZ1JlY29yZCB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB0eXBlIHsgQ2FjaGVJbnNwZWN0aW9uUmVxdWVzdCB9IGZyb20gXCIuLi9zcmMvY2ktY2FjaGUtaW5zcGVjdGlvbi5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgYXBwZW5kRmlsZVN5bmMsIGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBjaUJ1aWxkQ2FjaGVQYXRocywgY2lDYWNoZUVudmlyb25tZW50IH0gZnJvbSBcIi4vY2ktbGF5b3V0Lm1qc1wiO1xuaW1wb3J0IHsgZ3VpeENoYW5uZWxGaWxlIH0gZnJvbSBcIi4vbWFuYWdlZC1jb250cmFjdC5tanNcIjtcbmltcG9ydCB0eXBlIHsgUGF0aE9yRmlsZURlc2NyaXB0b3IgfSBmcm9tIFwiZnNcIjtcblxuY29uc3QgZGlzdHJpYnV0aW9uID0gcmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcIi4uXCIpO1xuY29uc3QgcmF3VGFyZ2V0ID0gcmVjb3JkKEpTT04ucGFyc2UocHJvY2Vzcy5lbnYuQ0FDSEVfVEFSR0VUID8/IFwie31cIiksIFwiSW52YWxpZCBjYWNoZSB0YXJnZXRcIik7XG5jb25zdCB0YXJnZXQ6IENhY2hlSW5zcGVjdGlvblJlcXVlc3RbXCJ0YXJnZXRcIl0gPSB7fTtcbmZvciAoY29uc3Qga2V5IG9mIFtcInJ1bnRpbWVcIiwgXCJ2ZXJzaW9uXCIsIFwiZW52aXJvbm1lbnRcIl0gYXMgY29uc3QpXG4gIGlmIChyYXdUYXJnZXRba2V5XSAhPT0gdW5kZWZpbmVkICYmIHJhd1RhcmdldFtrZXldICE9PSBudWxsKVxuICAgIHRhcmdldFtrZXldID0gc3RyaW5nKHJhd1RhcmdldFtrZXldLCBcIkludmFsaWQgY2FjaGUgdGFyZ2V0IGZpZWxkXCIpO1xuaWYgKHJhd1RhcmdldC5wYXRocyAhPT0gdW5kZWZpbmVkKSB0YXJnZXQucGF0aHMgPSBzdHJpbmdzKHJhd1RhcmdldC5wYXRocywgXCJJbnZhbGlkIGNhY2hlIHJvb3RzXCIpO1xuaWYgKHJhd1RhcmdldC5zZWxlY3Rpb25zICE9PSB1bmRlZmluZWQpXG4gIHRhcmdldC5zZWxlY3Rpb25zID0gcmVjb3JkcyhyYXdUYXJnZXQuc2VsZWN0aW9ucywgXCJJbnZhbGlkIGNhY2hlIHNlbGVjdGlvbnNcIikubWFwKChlbnRyeSkgPT4gKHtcbiAgICBwYXRoOiBzdHJpbmcoZW50cnkucGF0aCwgXCJJbnZhbGlkIGNhY2hlIHNlbGVjdGlvbiBwYXRoXCIpLFxuICAgIC4uLihlbnRyeS50b29sY2hhaW4gPT09IHVuZGVmaW5lZCA/IHt9IDogeyB0b29sY2hhaW46IHN0cmluZyhlbnRyeS50b29sY2hhaW4sIFwiSW52YWxpZCBjYWNoZSB0b29sY2hhaW5cIikgfSksXG4gIH0pKTtcbmlmIChwcm9jZXNzLmVudi5DSEVDS19DQUNIRV9FTlZJUk9OTUVOVCkgdGFyZ2V0LmVudmlyb25tZW50ID0gcHJvY2Vzcy5lbnYuQ0hFQ0tfQ0FDSEVfRU5WSVJPTk1FTlQ7XG5jb25zdCByb290cyA9IHRhcmdldC5wYXRocyA/PyBbXCIuXCJdO1xuY29uc3QgYmFzZSA9IGpvaW4ocmVxdWlyZWQocHJvY2Vzcy5lbnYuUlVOTkVSX1RFTVAsIFwiUlVOTkVSX1RFTVAgaXMgcmVxdWlyZWRcIiksIFwid29ya2JlbmNoLWNpXCIpO1xuY29uc3QgZGF0YSA9IGpvaW4oYmFzZSwgXCJkYXRhXCIpO1xuY29uc3QgY2FjaGUgPSBqb2luKGJhc2UsIFwiY2FjaGVcIik7XG5jb25zdCB2YXJpYWJsZXMgPSBjaUNhY2hlRW52aXJvbm1lbnQoY2FjaGUsIGRhdGEsIHRydWUpO1xuZm9yIChjb25zdCBwYXRoIG9mIFtkYXRhLCBjYWNoZV0pIG1rZGlyU3luYyhwYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbmZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHZhcmlhYmxlcykpXG4gIGFwcGVuZEZpbGVTeW5jKHJlcXVpcmVkKHByb2Nlc3MuZW52LkdJVEhVQl9FTlYsIFwiR0lUSFVCX0VOViBpcyByZXF1aXJlZFwiKSwgYCR7a2V5fT0ke3ZhbHVlfVxcbmApO1xuY29uc3QgaW5wdXRzID0gKGZpbGVzOiBzdHJpbmdbXSk6IFtzdHJpbmcsIHN0cmluZ11bXSA9PlxuICByb290cy5mbGF0TWFwKChyb290OiBzdHJpbmcpID0+XG4gICAgZmlsZXMuZmxhdE1hcCgobmFtZTogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCBwYXRoID0gam9pbihyb290LCBuYW1lKTtcbiAgICAgIHJldHVybiBleGlzdHNTeW5jKHBhdGgpID8gW1twYXRoLCByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpXSBhcyBbc3RyaW5nLCBzdHJpbmddXSA6IFtdO1xuICAgIH0pLFxuICApO1xuY29uc3QgaGFzaCA9ICh2YWx1ZTogdW5rbm93bikgPT4gY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUoSlNPTi5zdHJpbmdpZnkodmFsdWUpKS5kaWdlc3QoXCJoZXhcIikuc2xpY2UoMCwgMjQpO1xuLy8gQW4gaW5zdGFsbGVkIGFydGlmYWN0IGRlcGVuZHMgb24gaXRzIHBpbiwgbm90IHdoaWNoIHJvb3RzIGRlY2xhcmUgdGhlIHNhbWUgcGluLlxuY29uc3QgcGluSW5wdXRzID0gKGZpbGVzOiBzdHJpbmdbXSkgPT5cbiAgWy4uLm5ldyBTZXQoaW5wdXRzKGZpbGVzKS5tYXAoKFtwYXRoLCB2YWx1ZV0pID0+IEpTT04uc3RyaW5naWZ5KFtiYXNlbmFtZShwYXRoKSwgdmFsdWUudHJpbSgpXSkpKV0uc29ydCgpO1xuY29uc3QgZ3VpeENoYW5uZWxzID0gW1xuICAuLi5uZXcgU2V0KFxuICAgIHJvb3RzXG4gICAgICAubWFwKChyb290OiBzdHJpbmcpID0+IGd1aXhDaGFubmVsRmlsZShwcm9jZXNzLmN3ZCgpLCByZXNvbHZlKHJvb3QpKSlcbiAgICAgIC5maWx0ZXIoZXhpc3RzU3luYylcbiAgICAgIC5tYXAoKHBhdGg6IFBhdGhPckZpbGVEZXNjcmlwdG9yKSA9PiByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpLnRyaW0oKSksXG4gICksXG5dLnNvcnQoKTtcbmNvbnN0IHBsYXRmb3JtID0gYCR7cHJvY2Vzcy5wbGF0Zm9ybX0tJHtwcm9jZXNzLmFyY2h9YDtcbmNvbnN0IHdpbmRvd3MgPSBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCI7XG4vLyBSZWFjcXVpcmUgdGhlc2UgcHJlYnVpbHQgdG9vbHMgdGhyb3VnaCB0aGUgdmVyaWZpZWQgaW5zdGFsbGVyIG9uIGVhY2ggaG9zdGVkIGpvYi5cbi8vIEtlZXAgbG9jYWwgcmV1c2UgYW5kIHJldXNlIGJldHdlZW4gcm9vdHMgd2l0aGluIHRoZSBqb2I7IHJlc2VydmUgQWN0aW9ucyBzdG9yYWdlXG4vLyBmb3IgZXhwZW5zaXZlIGJ1aWxkcyByYXRoZXIgdGhhbiBwcmVidWlsdCBTREsgaW5zdGFsbGF0aW9ucy5cbmNvbnN0IHJlZG93bmxvYWQgPSBuZXcgU2V0KFtcbiAgXCJsbHZtXCIsXG4gIFwiY2xhbmdcIixcbiAgXCJnY2NcIixcbiAgXCJqYXZhXCIsXG4gIFwibm9kZVwiLFxuICBcImdvXCIsXG4gIFwiY21ha2VcIixcbiAgXCJuaW5qYVwiLFxuICBcInV2XCIsXG4gIFwic2hmbXRcIixcbiAgXCJzaGVsbGNoZWNrXCIsXG4gIFwiYWN0aW9ubGludFwiLFxuICBcImNhcmdvLW5leHRlc3RcIixcbiAgXCJjYXJnby1sbHZtLWNvdlwiLFxuXSk7XG4vLyBQcm9qZWN0IHBvbGljeSBjb250cm9scyBob3N0ZWQgcmV0ZW50aW9uIG9ubHk7IGluc3RhbGxlcnMgc3RpbGwgcmV1c2UgdmVyaWZpZWQgbG9jYWwgZmlsZXMuXG4vLyBDb2xsZWN0IGV2ZXJ5IHNvdXJjZSBpZGVudGl0eSBpbiB0aGUgc2FtZSBwcm9jZXNzIGFzIHRvb2wgYW5kIHBhY2thZ2UtbWFuYWdlciBwbGFubmluZy5cbmNvbnN0IHNvdXJjZUdyb3VwcyA9IHtcbiAgYWNxdWlzaXRpb246IFtcbiAgICBcInNyYy90b29sLWRvd25sb2Fkcy50c1wiLFxuICAgIFwic3JjL3Rvb2wtaG9zdC50c1wiLFxuICAgIFwic3JjL3J1bnRpbWUtYnVpbGRzLnRzXCIsXG4gICAgXCJzcmMvc2V2ZW4temlwLnRzXCIsXG4gICAgXCJzcmMvYXJ0aWZhY3Qtc3RyZWFtcy50c1wiLFxuICAgIFwic3JjL2FyY2hpdmUtZXh0cmFjdGlvbi50c1wiLFxuICAgIFwic3JjL2FydGlmYWN0LWRlY29kZXJzLnRzXCIsXG4gICAgXCJzcmMvYXJ0aWZhY3Qtc2lnbmF0dXJlcy50c1wiLFxuICAgIFwic3JjL2FydGlmYWN0LWF0dGVzdGF0aW9ucy50c1wiLFxuICAgIFwic3JjL2F0dGVzdGF0aW9uLXZlcmlmaWNhdGlvbi50c1wiLFxuICAgIFwic3JjL2FydGlmYWN0LXJlcG9zaXRvcmllcy50c1wiLFxuICAgIFwic3JjL2FydGlmYWN0LXBvbGljeS50c1wiLFxuICBdLFxuICBmaWx0ZXJlZDogW1wic3JjL2ZpbHRlcmVkLWFydGlmYWN0cy50c1wiXSxcbiAgdmNwa2c6IFtcInNyYy92Y3BrZy50c1wiXSxcbiAgcnVieTogW1wic3JjL3J1YnktbWFuYWdlci50c1wiXSxcbiAgcGFja2FnZU1hbmFnZXI6IFtcInNyYy9wYWNrYWdlLW1hbmFnZXIudHNcIiwgXCJzcmMvdG9vbGNoYWlucy50c1wiLCBcInNyYy90b29sLWRvd25sb2Fkcy50c1wiXSxcbiAgYnVpbGRzOiBbXCJzcmMvYnVpbGRzLnRzXCJdLFxuICBndWl4OlxuICAgIHRhcmdldC5lbnZpcm9ubWVudCA9PT0gXCJndWl4XCJcbiAgICAgID8gW1wic2NyaXB0cy9jaS1ndWl4LWJvb3RzdHJhcC5tanNcIiwgXCJzY3JpcHRzL2NpLWd1aXgtYm9vdHN0cmFwLnNjbVwiLCBcInNjcmlwdHMvbWFuYWdlZC1jb250cmFjdC5tanNcIl1cbiAgICAgIDogW10sXG59O1xuY29uc3Qgc291cmNlRmlsZXMgPSBbLi4ubmV3IFNldChPYmplY3QudmFsdWVzKHNvdXJjZUdyb3VwcykuZmxhdCgpKV07XG5jb25zdCBpbnNwZWN0aW9uRGF0YSA9IHJlY29yZChcbiAgSlNPTi5wYXJzZShcbiAgICBleGVjRmlsZVN5bmMoXG4gICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgW2pvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLCBcImNpLWNhY2hlLWluc3BlY3RcIiwgSlNPTi5zdHJpbmdpZnkoeyB0YXJnZXQsIHNvdXJjZXM6IHNvdXJjZUZpbGVzIH0pXSxcbiAgICAgIHsgZW5jb2Rpbmc6IFwidXRmOFwiLCBlbnY6IHsgLi4ucHJvY2Vzcy5lbnYsIC4uLnZhcmlhYmxlcyB9LCBtYXhCdWZmZXI6IDE2ICogMTAyNCAqIDEwMjQgfSxcbiAgICApLFxuICApLFxuICBcIkludmFsaWQgY2FjaGUgaW5zcGVjdGlvblwiLFxuKTtcbmNvbnN0IHRvb2wgPSAoZW50cnk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUGxhbm5lZFRvb2wgPT4ge1xuICBjb25zdCB2YWx1ZTogUGxhbm5lZFRvb2wgPSB7XG4gICAgcm9vdDogc3RyaW5nKGVudHJ5LnJvb3QsIFwiTWlzc2luZyB0b29sIHJvb3RcIiksXG4gICAgdG9vbDogc3RyaW5nKGVudHJ5LnRvb2wsIFwiTWlzc2luZyB0b29sIG5hbWVcIiksXG4gICAgdmVyc2lvbjogc3RyaW5nKGVudHJ5LnZlcnNpb24sIFwiTWlzc2luZyB0b29sIHZlcnNpb25cIiksXG4gIH07XG4gIGZvciAoY29uc3Qga2V5IG9mIFtcImRpcmVjdG9yeVwiLCBcInBvbGljeVwiLCBcIm1hbmFnZXJcIl0gYXMgY29uc3QpXG4gICAgaWYgKGVudHJ5W2tleV0gIT09IHVuZGVmaW5lZCkgdmFsdWVba2V5XSA9IHN0cmluZyhlbnRyeVtrZXldLCBcIkludmFsaWQgdG9vbCBtZXRhZGF0YVwiKTtcbiAgaWYgKGVudHJ5LmZpbHRlcmVkICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAodHlwZW9mIGVudHJ5LmZpbHRlcmVkICE9PSBcImJvb2xlYW5cIikgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCB0b29sIGZpbHRlcmluZyBmbGFnXCIpO1xuICAgIHZhbHVlLmZpbHRlcmVkID0gZW50cnkuZmlsdGVyZWQ7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufTtcbmNvbnN0IHBsYW5zID0gKHZhbHVlOiB1bmtub3duKSA9PlxuICByZWNvcmRzKHZhbHVlLCBcIkludmFsaWQgdG9vbCBwbGFuc1wiKS5tYXAoKGVudHJ5KSA9PiAoe1xuICAgIHBhdGg6IHN0cmluZyhlbnRyeS5wYXRoLCBcIk1pc3NpbmcgcGxhbiByb290XCIpLFxuICAgIHBsYW46IHJlY29yZHMoZW50cnkucGxhbiwgXCJJbnZhbGlkIGluc3RhbGxhdGlvbiBwbGFuXCIpLm1hcCh0b29sKSxcbiAgfSkpO1xuY29uc3QgaW5zcGVjdGlvbiA9IHtcbiAgcmV0ZW50aW9uOiBzdHJpbmdSZWNvcmQoaW5zcGVjdGlvbkRhdGEucmV0ZW50aW9uLCBcIkludmFsaWQgY2FjaGUgcmV0ZW50aW9uXCIpLFxuICBzb3VyY2VzOiBzdHJpbmdSZWNvcmQoaW5zcGVjdGlvbkRhdGEuc291cmNlcywgXCJJbnZhbGlkIGNhY2hlIHNvdXJjZSBpZGVudGl0aWVzXCIpLFxuICBuYXRpdmU6IHBsYW5zKGluc3BlY3Rpb25EYXRhLm5hdGl2ZSksXG4gIGRlZmF1bHRzOiBwbGFucyhpbnNwZWN0aW9uRGF0YS5kZWZhdWx0cyksXG4gIHJ1bnRpbWVzOiByZWNvcmRzKGluc3BlY3Rpb25EYXRhLnJ1bnRpbWVzLCBcIkludmFsaWQgcnVudGltZSBwbGFuc1wiKS5tYXAoKGVudHJ5KSA9PiB7XG4gICAgY29uc3QgcGxhbiA9IHJlY29yZChlbnRyeS5wbGFuLCBcIkludmFsaWQgcnVudGltZSBwbGFuXCIpLFxuICAgICAgc2VsZWN0ZWQgPSByZWNvcmQocGxhbi50b29sLCBcIkludmFsaWQgcnVudGltZSB0b29sXCIpO1xuICAgIHJldHVybiB7XG4gICAgICBwYXRoOiBzdHJpbmcoZW50cnkucGF0aCwgXCJNaXNzaW5nIHJ1bnRpbWUgcm9vdFwiKSxcbiAgICAgIHBsYW46IHtcbiAgICAgICAgdG9vbDoge1xuICAgICAgICAgIG5hbWU6IHN0cmluZyhzZWxlY3RlZC5uYW1lLCBcIk1pc3NpbmcgcnVudGltZSBuYW1lXCIpLFxuICAgICAgICAgIHZlcnNpb246IHN0cmluZyhzZWxlY3RlZC52ZXJzaW9uLCBcIk1pc3NpbmcgcnVudGltZSB2ZXJzaW9uXCIpLFxuICAgICAgICB9LFxuICAgICAgICBkaXJlY3Rvcnk6IHN0cmluZyhwbGFuLmRpcmVjdG9yeSwgXCJNaXNzaW5nIHJ1bnRpbWUgZGlyZWN0b3J5XCIpLFxuICAgICAgICBwb2xpY3k6IHBsYW4ucG9saWN5ID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiBzdHJpbmcocGxhbi5wb2xpY3ksIFwiSW52YWxpZCBydW50aW1lIHBvbGljeVwiKSxcbiAgICAgIH0sXG4gICAgfTtcbiAgfSksXG4gIG1hbmFnZXJzOiByZWNvcmRzKGluc3BlY3Rpb25EYXRhLm1hbmFnZXJzLCBcIkludmFsaWQgcGFja2FnZSBtYW5hZ2VyIHBsYW5zXCIpLm1hcCgoZW50cnkpID0+ICh7XG4gICAgaWRlbnRpdHk6IHN0cmluZyhlbnRyeS5pZGVudGl0eSwgXCJNaXNzaW5nIG1hbmFnZXIgaWRlbnRpdHlcIiksXG4gICAgZGlyZWN0b3J5OiBzdHJpbmcoZW50cnkuZGlyZWN0b3J5LCBcIk1pc3NpbmcgbWFuYWdlciBkaXJlY3RvcnlcIiksXG4gIH0pKSxcbn07XG5jb25zdCByZXRhaW5lZCA9ICh0b29sOiBzdHJpbmcpID0+XG4gIGluc3BlY3Rpb24ucmV0ZW50aW9uW3Rvb2xdID8gaW5zcGVjdGlvbi5yZXRlbnRpb25bdG9vbF0gPT09IFwiY2FjaGVcIiA6ICFyZWRvd25sb2FkLmhhcyh0b29sKTtcbmNvbnN0IHJ1bnRpbWVPbmx5ID0gW1wibm9kZVwiLCBcImdvXCIsIFwiamF2YVwiLCBcInJ1YnlcIiwgXCJwaHBcIl0uaW5jbHVkZXModGFyZ2V0LnJ1bnRpbWUgPz8gXCJcIik7XG5jb25zdCBtYW5hZ2VkID0gdGFyZ2V0LmVudmlyb25tZW50ICYmIHRhcmdldC5lbnZpcm9ubWVudCAhPT0gXCJkZXZjb250YWluZXJcIjtcbmludGVyZmFjZSBQbGFubmVkVG9vbCB7XG4gIHJvb3Q6IHN0cmluZztcbiAgdG9vbDogc3RyaW5nO1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGRpcmVjdG9yeT86IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgZmlsdGVyZWQ/OiBib29sZWFuO1xuICBwb2xpY3k/OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIG1hbmFnZXI/OiBzdHJpbmc7XG59XG5jb25zdCBwbGFuOiBQbGFubmVkVG9vbFtdID0gaW5zcGVjdGlvbi5uYXRpdmVcbiAgLmZsYXRNYXAoKHsgcGxhbiB9KSA9PiBwbGFuKVxuICAuZmlsdGVyKChlbnRyeTogeyB0b29sOiBzdHJpbmcgfSkgPT5cbiAgICB0YXJnZXQucnVudGltZSA9PT0gXCJweXRob25cIlxuICAgICAgPyBlbnRyeS50b29sID09PSBcInV2XCJcbiAgICAgIDogdGFyZ2V0LnJ1bnRpbWUgPT09IFwicnVzdFwiXG4gICAgICAgID8gZmFsc2VcbiAgICAgICAgOiB0YXJnZXQuZW52aXJvbm1lbnQgPT09IFwiZGV2Y29udGFpbmVyXCJcbiAgICAgICAgICA/IGVudHJ5LnRvb2wgPT09IFwibm9kZVwiXG4gICAgICAgICAgOiB0cnVlLFxuICApO1xuaWYgKHJ1bnRpbWVPbmx5KSB7XG4gIGZvciAoY29uc3QgeyBwYXRoOiByb290LCBwbGFuOiBydW50aW1lIH0gb2YgaW5zcGVjdGlvbi5ydW50aW1lcykge1xuICAgIGlmICh0YXJnZXQucnVudGltZSA9PT0gXCJqYXZhXCIpXG4gICAgICBwbGFuLnB1c2goXG4gICAgICAgIC4uLnJlcXVpcmVkKFxuICAgICAgICAgIGluc3BlY3Rpb24uZGVmYXVsdHMuZmluZCgoZW50cnkpID0+IGVudHJ5LnBhdGggPT09IHJvb3QpLFxuICAgICAgICAgIGBNaXNzaW5nIGRlZmF1bHRzIGZvciAke3Jvb3R9YCxcbiAgICAgICAgKS5wbGFuLmZpbHRlcigoZW50cnk6IHsgdG9vbDogc3RyaW5nIH0pID0+IGVudHJ5LnRvb2wgPT09IFwibWF2ZW5cIiksXG4gICAgICApO1xuICAgIHBsYW4ucHVzaCh7XG4gICAgICByb290LFxuICAgICAgdG9vbDogcnVudGltZS50b29sLm5hbWUsXG4gICAgICB2ZXJzaW9uOiBydW50aW1lLnRvb2wudmVyc2lvbixcbiAgICAgIGRpcmVjdG9yeTogcnVudGltZS5kaXJlY3RvcnksXG4gICAgICBmaWx0ZXJlZDogZmFsc2UsXG4gICAgICBwb2xpY3k6IHJ1bnRpbWUucG9saWN5LFxuICAgIH0pO1xuICB9XG59XG5jb25zdCBvcmRpbmFyeSA9IHBsYW4uZmlsdGVyKFxuICAoZW50cnkpID0+XG4gICAgdHlwZW9mIGVudHJ5LmRpcmVjdG9yeSA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICghZW50cnkuZmlsdGVyZWQgfHwgZW50cnkudG9vbCA9PT0gXCJnY2NcIikgJiZcbiAgICByZXRhaW5lZChlbnRyeS50b29sKSAmJlxuICAgICFbXCJsbHZtLXJ1bnRpbWVcIiwgXCJsbHZtLXhtbC1ydW50aW1lXCJdLmluY2x1ZGVzKGVudHJ5LnRvb2wpICYmXG4gICAgKHRhcmdldC5ydW50aW1lICE9PSBcInB5dGhvblwiIHx8IGVudHJ5LnRvb2wgPT09IFwidXZcIiksXG4pO1xuY29uc3QgcG9saWNpZXMgPSAoZW50cmllczogdHlwZW9mIHBsYW4pID0+XG4gIFtcbiAgICAuLi5uZXcgTWFwKFxuICAgICAgZW50cmllc1xuICAgICAgICAuZmlsdGVyKChlbnRyeSkgPT4gdHlwZW9mIGVudHJ5LmRpcmVjdG9yeSA9PT0gXCJzdHJpbmdcIilcbiAgICAgICAgLm1hcCgoZW50cnkpID0+IFtcbiAgICAgICAgICBlbnRyeS5kaXJlY3RvcnksXG4gICAgICAgICAgW2VudHJ5LnRvb2wsIGVudHJ5LnZlcnNpb24sIGVudHJ5LnBvbGljeSwgYmFzZW5hbWUocmVxdWlyZWQoZW50cnkuZGlyZWN0b3J5LCBcIk1pc3NpbmcgdG9vbCBkaXJlY3RvcnlcIikpXSxcbiAgICAgICAgXSksXG4gICAgKS52YWx1ZXMoKSxcbiAgXS5zb3J0KChhLCBiKSA9PiBKU09OLnN0cmluZ2lmeShhKS5sb2NhbGVDb21wYXJlKEpTT04uc3RyaW5naWZ5KGIpKSk7XG5jb25zdCBzb3VyY2VJbnB1dHMgPSAoZmlsZXM6IHN0cmluZ1tdKSA9PiBmaWxlcy5tYXAoKGZpbGU6IHN0cmluZyB8IG51bWJlcikgPT4gW2ZpbGUsIGluc3BlY3Rpb24uc291cmNlc1tmaWxlXV0pO1xuY29uc3QgYWNxdWlzaXRpb25Db2RlID0gc291cmNlSW5wdXRzKHNvdXJjZUdyb3Vwcy5hY3F1aXNpdGlvbik7XG5jb25zdCB2Y3BrZyA9XG4gICh0YXJnZXQucnVudGltZSAmJiAhW1wiY2xhbmdcIiwgXCJnY2NcIl0uaW5jbHVkZXModGFyZ2V0LnJ1bnRpbWUgPz8gXCJcIikpIHx8IG1hbmFnZWRcbiAgICA/IFtdXG4gICAgOiBbLi4ubmV3IFNldChpbnB1dHMoW1wiLnZjcGtnLXZlcnNpb25cIl0pLm1hcCgoWywgcmV2aXNpb25dKSA9PiByZXZpc2lvbi50cmltKCkpKV0uc29ydCgpO1xuY29uc3QgdmNwa2dQYXRocyA9IFsuLi5uZXcgU2V0KHZjcGtnLm1hcCgocmV2aXNpb24pID0+IGpvaW4oY2FjaGUsIFwidG9vbGNoYWluc1wiLCBcInZjcGtnXCIsIHJldmlzaW9uLCBwbGF0Zm9ybSkpKV07XG5jb25zdCBweXRob25QYXRocyA9XG4gICF3aW5kb3dzICYmICh0YXJnZXQucnVudGltZSA9PT0gXCJweXRob25cIiB8fCAoIXRhcmdldC5ydW50aW1lICYmICFtYW5hZ2VkICYmIGlucHV0cyhbXCIucHl0aG9uLXZlcnNpb25cIl0pLmxlbmd0aCkpXG4gICAgPyBbam9pbihjYWNoZSwgXCJ1di1weXRob25cIiwgXCJweXRob25cIildXG4gICAgOiBbXTtcbmNvbnN0IGRldmNvbnRhaW5lclJ1bnRpbWVzOiBQbGFubmVkVG9vbFtdID1cbiAgdGFyZ2V0LmVudmlyb25tZW50ID09PSBcImRldmNvbnRhaW5lclwiXG4gICAgPyByb290c1xuICAgICAgICAuZmxhdE1hcChcbiAgICAgICAgICAocm9vdCkgPT5cbiAgICAgICAgICAgIHJlcXVpcmVkKFxuICAgICAgICAgICAgICBpbnNwZWN0aW9uLmRlZmF1bHRzLmZpbmQoKGVudHJ5KSA9PiBlbnRyeS5wYXRoID09PSByb290KSxcbiAgICAgICAgICAgICAgYE1pc3NpbmcgZGVmYXVsdHMgZm9yICR7cm9vdH1gLFxuICAgICAgICAgICAgKS5wbGFuLFxuICAgICAgICApXG4gICAgICAgIC5maWx0ZXIoKGVudHJ5OiB7IHRvb2w6IHN0cmluZyB9KSA9PiAhW1wicnVzdFwiLCBcIm1pcmlcIiwgXCJweXRob25cIl0uaW5jbHVkZXMoZW50cnkudG9vbCkpXG4gICAgOiBbXTtcbmNvbnN0IGNhY2hlZERldmNvbnRhaW5lclJ1bnRpbWVzID0gZGV2Y29udGFpbmVyUnVudGltZXMuZmlsdGVyKChlbnRyeSkgPT4gcmV0YWluZWQoZW50cnkudG9vbCkpO1xuLy8gR3Vlc3QgT1MgaWRlbnRpdGllcyBhcmUgcmVzb2x2ZWQgYWZ0ZXIgc3RhcnR1cDsgcmV0YWluIG9ubHkgc2VsZWN0ZWQgdG9vbCB2ZXJzaW9ucyBhY3Jvc3MgdGhvc2UgaWRlbnRpdGllcy5cbmNvbnN0IGRldmNvbnRhaW5lclJ1bnRpbWVQYXRocyA9IFtcbiAgLi4ubmV3IFNldChcbiAgICBjYWNoZWREZXZjb250YWluZXJSdW50aW1lc1xuICAgICAgLmZpbHRlcihcbiAgICAgICAgKGVudHJ5KSA9PlxuICAgICAgICAgICghZW50cnkuZmlsdGVyZWQgfHwgZW50cnkudG9vbCA9PT0gXCJnY2NcIikgJiYgIVtcImxsdm0tcnVudGltZVwiLCBcImxsdm0teG1sLXJ1bnRpbWVcIl0uaW5jbHVkZXMoZW50cnkudG9vbCksXG4gICAgICApXG4gICAgICAubWFwKChlbnRyeSkgPT4gKGVudHJ5LnRvb2wgPT09IFwiZ2NjXCIgPyBlbnRyeS5kaXJlY3RvcnkgOiBqb2luKGNhY2hlLCBcInRvb2xjaGFpbnNcIiwgZW50cnkudG9vbCwgZW50cnkudmVyc2lvbikpKSxcbiAgKSxcbl0uc29ydCgpO1xuY29uc3QgdG9vbHMgPSBoYXNoKFtcbiAgcG9saWNpZXMoY2FjaGVkRGV2Y29udGFpbmVyUnVudGltZXMpLFxuICB0YXJnZXQuZW52aXJvbm1lbnQgPT09IFwiZGV2Y29udGFpbmVyXCJcbiAgICA/IFtcIi5kZXZjb250YWluZXIvRG9ja2VyZmlsZVwiLCBcIi5kZXZjb250YWluZXIvZGV2Y29udGFpbmVyLmpzb25cIl1cbiAgICAgICAgLmZpbHRlcigoZmlsZSkgPT4gZXhpc3RzU3luYyhmaWxlKSlcbiAgICAgICAgLm1hcCgoZmlsZSkgPT4gW2ZpbGUsIHJlYWRGaWxlU3luYyhmaWxlLCBcInV0ZjhcIildKVxuICAgIDogW10sXG4gIGRldmNvbnRhaW5lclJ1bnRpbWVQYXRocyxcbiAgcGluSW5wdXRzKFtcIi5ydWJ5LXZlcnNpb25cIiwgXCIucGhwLXZlcnNpb25cIl0pLFxuICBbLi4ub3JkaW5hcnksIC4uLmNhY2hlZERldmNvbnRhaW5lclJ1bnRpbWVzXS5zb21lKChlbnRyeSkgPT4gZW50cnkuZmlsdGVyZWQpXG4gICAgPyBzb3VyY2VJbnB1dHMoc291cmNlR3JvdXBzLmZpbHRlcmVkKVxuICAgIDogW10sXG4gIHBvbGljaWVzKG9yZGluYXJ5KSxcbiAgYWNxdWlzaXRpb25Db2RlLFxuICB2Y3BrZyxcbiAgdmNwa2cubGVuZ3RoID8gc291cmNlSW5wdXRzKHNvdXJjZUdyb3Vwcy52Y3BrZykgOiBbXSxcbiAgcHl0aG9uUGF0aHMubGVuZ3RoXG4gICAgPyBbcGluSW5wdXRzKFtcIi5weXRob24tdmVyc2lvblwiXSksIHRhcmdldC5ydW50aW1lID09PSBcInB5dGhvblwiID8gdGFyZ2V0LnZlcnNpb24gOiB1bmRlZmluZWRdXG4gICAgOiB1bmRlZmluZWQsXG5dKTtcbmNvbnN0IG1hbmFnZXJzID0gaW5zcGVjdGlvbi5tYW5hZ2VycztcbmNvbnN0IG1hbmFnZXJLZXkgPSBoYXNoKFtcbiAgWy4uLm5ldyBTZXQobWFuYWdlcnMubWFwKChlbnRyeSkgPT4gZW50cnkuaWRlbnRpdHkpKV0uc29ydCgpLFxuICBpbnB1dHMoW1wiR2VtZmlsZS5sb2NrXCJdKSxcbiAgc291cmNlSW5wdXRzKHNvdXJjZUdyb3Vwcy5ydWJ5KSxcbiAgc291cmNlSW5wdXRzKHNvdXJjZUdyb3Vwcy5wYWNrYWdlTWFuYWdlciksXG5dKTtcbmNvbnN0IG1hbmlmZXN0cyA9IGlucHV0cyhbXG4gIFwiR2VtZmlsZVwiLFxuICBcIkdlbWZpbGUubG9ja1wiLFxuICBcImNvbXBvc2VyLmpzb25cIixcbiAgXCJjb21wb3Nlci5sb2NrXCIsXG4gIFwiLmNvbXBvc2VyL2NoZWNrc3Vtcy5qc29uXCIsXG4gIFwiLmNvbXBvc2VyL3ZlcmlmeS9jb21wb3Nlci5qc29uXCIsXG4gIFwiLmNvbXBvc2VyL3ZlcmlmeS9zcmMvVmVyaWZ5UGx1Z2luLnBocFwiLFxuICBcInRvb2xzL2NvbXBvc2VyLmpzb25cIixcbiAgXCJ0b29scy9jb21wb3Nlci5sb2NrXCIsXG4gIFwidG9vbHMvLmNvbXBvc2VyL2NoZWNrc3Vtcy5qc29uXCIsXG4gIFwidG9vbHMvY29tcGF0L2NvbXBvc2VyLmpzb25cIixcbiAgXCJ0b29scy9jb21wYXQvY29tcG9zZXIubG9ja1wiLFxuICBcInRvb2xzL2NvbXBhdC8uY29tcG9zZXIvY2hlY2tzdW1zLmpzb25cIixcbiAgXCJwYWNrYWdlLmpzb25cIixcbiAgXCJwbnBtLWxvY2sueWFtbFwiLFxuICBcInBucG0td29ya3NwYWNlLnlhbWxcIixcbiAgXCJweXByb2plY3QudG9tbFwiLFxuICBcInV2LmxvY2tcIixcbiAgXCJnby5tb2RcIixcbiAgXCJnby5zdW1cIixcbiAgXCJDYXJnby50b21sXCIsXG4gIFwiQ2FyZ28ubG9ja1wiLFxuICBcInZjcGtnLWNvbmZpZ3VyYXRpb24uanNvblwiLFxuICBcInZjcGtnLmpzb25cIixcbiAgXCJwb20ueG1sXCIsXG4gIFwiLm12bi9jaGVja3N1bXMvY2hlY2tzdW1zLnNoYTI1NlwiLFxuICBcIi5tdm4vc2V0dGluZ3MueG1sXCIsXG4gIFwiLm12bi9tYXZlbi5jb25maWdcIixcbiAgXCIubXZuL2p2bS5jb25maWdcIixcbl0pO1xuLy8gRG93bmxvYWQgc3RvcmVzIHZhbGlkYXRlIHRoZWlyIGNvbnRlbnRzIHRocm91Z2ggdGhlaXIgb3duaW5nIHBhY2thZ2UgbWFuYWdlcnMuXG4vLyBJbnN0YWxsZXIgZWRpdHMgYW5kIHJ1bnRpbWUgcGF0Y2ggc2VsZWN0aW9ucyBtdXN0IG5vdCBpbnZhbGlkYXRlIHRob3NlIHN0b3Jlcy5cbmNvbnN0IGRvd25sb2FkcyA9IGhhc2gobWFuaWZlc3RzKTtcbmNvbnN0IGJ1aWxkcyA9IGhhc2goW1xuICBtYW5pZmVzdHMsXG4gIGlucHV0cyhbXG4gICAgXCJDTWFrZUxpc3RzLnR4dFwiLFxuICAgIFwiLmxsdm0tdmVyc2lvblwiLFxuICAgIFwiLmdjYy12ZXJzaW9uXCIsXG4gICAgXCJydXN0LXRvb2xjaGFpbi50b21sXCIsXG4gICAgXCIucHl0aG9uLXZlcnNpb25cIixcbiAgICBcIi5nby12ZXJzaW9uXCIsXG4gICAgXCIubm9kZS12ZXJzaW9uXCIsXG4gICAgXCIuamF2YS12ZXJzaW9uXCIsXG4gICAgXCIucnVieS12ZXJzaW9uXCIsXG4gICAgXCIucGhwLXZlcnNpb25cIixcbiAgICBcIi5jb21wb3Nlci12ZXJzaW9uXCIsXG4gICAgXCIueGRlYnVnLXZlcnNpb25cIixcbiAgXSksXG4gIHRhcmdldC5lbnZpcm9ubWVudCA/IGlucHV0cyhbXCJmbGFrZS5uaXhcIiwgXCJmbGFrZS5sb2NrXCIsIFwibWFuaWZlc3Quc2NtXCJdKSA6IHVuZGVmaW5lZCxcbiAgdGFyZ2V0LmVudmlyb25tZW50ID09PSBcImd1aXhcIiA/IGd1aXhDaGFubmVscyA6IHVuZGVmaW5lZCxcbiAgcmVhZEZpbGVTeW5jKFwid29ya2JlbmNoL3Byb2plY3RzLnRvbWxcIiwgXCJ1dGY4XCIpLFxuICAvLyBSZWRvd25sb2FkZWQgZ3Vlc3QgdG9vbHMgc3RpbGwgZGV0ZXJtaW5lIGNvbXBpbGVkLW91dHB1dCBjb21wYXRpYmlsaXR5LlxuICBwb2xpY2llcyhkZXZjb250YWluZXJSdW50aW1lcyksXG4gIHBvbGljaWVzKHBsYW4pLFxuICBhY3F1aXNpdGlvbkNvZGUsXG4gIHNvdXJjZUlucHV0cyhzb3VyY2VHcm91cHMuYnVpbGRzKSxcbiAgdG9vbHMsXG4gIHRhcmdldC5ydW50aW1lLFxuICB0YXJnZXQudmVyc2lvbixcbiAgdGFyZ2V0LmVudmlyb25tZW50LFxuICBpbnB1dHMoW1wiLmRldmNvbnRhaW5lci9kZXZjb250YWluZXIuanNvblwiLCBcIi5kZXZjb250YWluZXIvRG9ja2VyZmlsZVwiXSksXG5dKTtcbmNvbnN0IG1lYXN1cmVkUGxhbjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuLy8gQ2FjaGUgZW50cmllcyBhcmUgaW1tdXRhYmxlOiBjaGFuZ2luZyB0aGUgZW5jb2RlciBsZXZlbCBtdXN0IGNyZWF0ZSBhIG5ldyBpZGVudGl0eS5cbmNvbnN0IGNvbXByZXNzaW9uTGV2ZWwgPSBwcm9jZXNzLmVudi5aU1REX0NMRVZFTCA/PyBcIjNcIjtcbmlmICghL14oPzpbMS05XXwxWzAtOV0pJC8udGVzdChjb21wcmVzc2lvbkxldmVsKSkgdGhyb3cgbmV3IEVycm9yKFwiWlNURF9DTEVWRUwgbXVzdCBiZSBhbiBpbnRlZ2VyIGZyb20gMSB0byAxOVwiKTtcbmNvbnN0IG91dHB1dCA9IChrZXk6IHN0cmluZywgdmFsdWU6IHN0cmluZykgPT4ge1xuICBpZiAoa2V5LmVuZHNXaXRoKFwiLWtleVwiKSkge1xuICAgIC8vIFJldXNlIGlkZW50aWNhbCBjb250ZW50cyBzYXZlZCB3aXRoIGFuIG9sZGVyIGNvbXByZXNzaW9uIHBvbGljeSBiZWZvcmUgc2F2aW5nIHRoZSBuZXcga2V5LlxuICAgIG91dHB1dChrZXkucmVwbGFjZSgvLWtleSQvLCBcIi1yZXN0b3JlLWtleXNcIiksIHZhbHVlKTtcbiAgICB2YWx1ZSArPSBgLXpzdGQke2NvbXByZXNzaW9uTGV2ZWx9YDtcbiAgfVxuICBtZWFzdXJlZFBsYW5ba2V5XSA9IHZhbHVlO1xuICBhcHBlbmRGaWxlU3luYyhcbiAgICByZXF1aXJlZChwcm9jZXNzLmVudi5HSVRIVUJfT1VUUFVULCBcIkdJVEhVQl9PVVRQVVQgaXMgcmVxdWlyZWRcIiksXG4gICAgYCR7a2V5fTw8V09SS0JFTkNIX0NBQ0hFXFxuJHt2YWx1ZX1cXG5XT1JLQkVOQ0hfQ0FDSEVcXG5gLFxuICApO1xufTtcbmlmIChvcmRpbmFyeS5sZW5ndGggfHwgdmNwa2dQYXRocy5sZW5ndGggfHwgcHl0aG9uUGF0aHMubGVuZ3RoIHx8IGRldmNvbnRhaW5lclJ1bnRpbWVQYXRocy5sZW5ndGgpXG4gIC8vIERvIG5vdCByZXN0b3JlIHRoZSBicm9hZGVyIGluc3RhbGxhdGlvbiBhcmNoaXZlcyBmcm9tIGVhcmxpZXIgbGF5b3V0cy5cbiAgb3V0cHV0KFwidG9vbHMta2V5XCIsIGB0b29scy12OC0ke3BsYXRmb3JtfS0ke3Rvb2xzfWApO1xub3V0cHV0KFxuICBcInRvb2xzLXBhdGhzXCIsXG4gIFtcbiAgICAuLi5uZXcgU2V0KFtcbiAgICAgIC4uLm9yZGluYXJ5Lm1hcCgoZW50cnkpID0+IGVudHJ5LmRpcmVjdG9yeSksXG4gICAgICAuLi5kZXZjb250YWluZXJSdW50aW1lUGF0aHMsXG4gICAgICAuLi52Y3BrZ1BhdGhzLFxuICAgICAgLi4ucHl0aG9uUGF0aHMsXG4gICAgICAuLi4oaW5wdXRzKFtcIi54ZGVidWctdmVyc2lvblwiXSkubGVuZ3RoID8gW2pvaW4oY2FjaGUsIFwidG9vbGNoYWlucy94ZGVidWdcIildIDogW10pLFxuICAgIF0pLFxuICBdLmpvaW4oXCJcXG5cIiksXG4pO1xuaWYgKG1hbmFnZXJzLmxlbmd0aCB8fCBpbnB1dHMoW1wiR2VtZmlsZS5sb2NrXCJdKS5sZW5ndGgpIHtcbiAgb3V0cHV0KFwicGFja2FnZS1tYW5hZ2Vycy1rZXlcIiwgYHBhY2thZ2UtbWFuYWdlcnMtdjEtJHtwbGF0Zm9ybX0tJHttYW5hZ2VyS2V5fWApO1xuICBvdXRwdXQoXG4gICAgXCJwYWNrYWdlLW1hbmFnZXJzLXBhdGhzXCIsXG4gICAgW1xuICAgICAgLi4ubmV3IFNldChbXG4gICAgICAgIC4uLm1hbmFnZXJzLm1hcCgoZW50cnkpID0+IGVudHJ5LmRpcmVjdG9yeSksXG4gICAgICAgIC4uLihpbnB1dHMoW1wiR2VtZmlsZS5sb2NrXCJdKS5sZW5ndGggPyBbam9pbihjYWNoZSwgXCJwYWNrYWdlLW1hbmFnZXJzL2J1bmRsZXJcIildIDogW10pLFxuICAgICAgXSksXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICApO1xufVxub3V0cHV0KFwiZG93bmxvYWRzLWtleVwiLCBgZG93bmxvYWRzLXYke1N0cmluZyh3aW5kb3dzID8gMiA6IDEpfS0ke3BsYXRmb3JtfS0ke2Rvd25sb2Fkc31gKTtcbm91dHB1dChcbiAgXCJkb3dubG9hZHMtcGF0aHNcIixcbiAgW1xuICAgIC4uLltcInV2XCIsIFwiZ28tbW9kXCIsIFwibnBtXCIsIFwicGlwXCJdLm1hcCgobmFtZSkgPT4gam9pbihjYWNoZSwgbmFtZSkpLFxuICAgIGpvaW4oY2FjaGUsIFwiZG93bmxvYWRzXCIsIFwicG5wbVwiKSxcbiAgICAuLi4od2luZG93cyA/IFtqb2luKGNhY2hlLCBcImRvd25sb2Fkc1wiLCBcInV2LXB5dGhvblwiKV0gOiBbXSksXG4gICAgam9pbihjYWNoZSwgXCJkb3dubG9hZHNcIiwgXCJtYXZlblwiKSxcbiAgICBqb2luKGNhY2hlLCBcImRvd25sb2Fkc1wiLCBcImNvbXBvc2VyXCIpLFxuICAgIGpvaW4oY2FjaGUsIFwiZG93bmxvYWRzXCIsIFwiYnVuZGxlclwiKSxcbiAgICBqb2luKGNhY2hlLCBcInZjcGtnXCIsIFwiZG93bmxvYWRzXCIpLFxuICAgIGpvaW4ocmVxdWlyZWQodmFyaWFibGVzLkNBUkdPX0hPTUUsIFwiTWlzc2luZyBDQVJHT19IT01FXCIpLCBcInJlZ2lzdHJ5XCIpLFxuICAgIGpvaW4ocmVxdWlyZWQodmFyaWFibGVzLkNBUkdPX0hPTUUsIFwiTWlzc2luZyBDQVJHT19IT01FXCIpLCBcImdpdFwiKSxcbiAgXS5qb2luKFwiXFxuXCIpLFxuKTtcbi8vIHYyIG9taXRzIGluc3RhbGxlZCBkZXBlbmRlbmNpZXM7IGRvIG5vdCByZXN0b3JlIGFyY2hpdmVzIGZyb20gdGhlIGJyb2FkZXIgdjEgbGF5b3V0Llxub3V0cHV0KFwiYnVpbGRzLWtleVwiLCBgYnVpbGRzLXYyLSR7cGxhdGZvcm19LSR7YnVpbGRzfWApO1xub3V0cHV0KFwiYnVpbGRzLXBhdGhzXCIsIGNpQnVpbGRDYWNoZVBhdGhzKGNhY2hlLCB0YXJnZXQuZW52aXJvbm1lbnQpLmpvaW4oXCJcXG5cIikpO1xuLy8gVGhlIHNhbWUgY2hhbm5lbCBoaXN0b3J5IGlzIHJldXNhYmxlIGFjcm9zcyBhbnkgcm9vdHMgZGVjbGFyaW5nIHRob3NlIGNoYW5uZWxzLlxub3V0cHV0KFwiZ3VpeC1rZXlcIiwgYGd1aXgtc291cmNlLXYyLSR7cGxhdGZvcm19LSR7aGFzaChndWl4Q2hhbm5lbHMpfWApO1xub3V0cHV0KFwiZ3VpeC1wYXRoc1wiLCBbXCJjaGVja291dHNcIiwgXCJhdXRoZW50aWNhdGlvblwiXS5tYXAoKG5hbWUpID0+IGpvaW4oaG9tZWRpcigpLCBcIi5jYWNoZVwiLCBcImd1aXhcIiwgbmFtZSkpLmpvaW4oXCJcXG5cIikpO1xuaWYgKHRhcmdldC5lbnZpcm9ubWVudCA9PT0gXCJndWl4XCIpIHtcbiAgb3V0cHV0KFxuICAgIFwiZ3VpeC1ib290c3RyYXAta2V5XCIsXG4gICAgYGd1aXgtYm9vdHN0cmFwLXYxLSR7cGxhdGZvcm19LSR7aGFzaChbZ3VpeENoYW5uZWxzLCBzb3VyY2VJbnB1dHMoc291cmNlR3JvdXBzLmd1aXgpXSl9YCxcbiAgKTtcbiAgb3V0cHV0KFwiZ3VpeC1ib290c3RyYXAtcGF0aFwiLCBqb2luKGNhY2hlLCBcImd1aXgtYm9vdHN0cmFwXCIpKTtcbn1cblxuLy8gS2VlcCB0aGUgZGV2ZWxvcG1lbnQgU0RLIHJldXNhYmxlIHdoZW4gYW4gb2xkZXIgY29tcGF0aWJpbGl0eSBjb21waWxlciBpcyBzZWxlY3RlZC5cbi8vIERldiBDb250YWluZXJzIHVzZSB0aGUgc2FtZSBpbW11dGFibGUgTExWTSBhcnRpZmFjdHMgYW5kIGxhbmd1YWdlLW93bmVkIGZpbHRlcnMuXG5jb25zdCBsbHZtID0gWy4uLnBsYW4sIC4uLmRldmNvbnRhaW5lclJ1bnRpbWVzXS5maWx0ZXIoKGVudHJ5KSA9PlxuICBbXCJsbHZtXCIsIFwiY2xhbmdcIiwgXCJsbHZtLXJ1bnRpbWVcIiwgXCJsbHZtLXhtbC1ydW50aW1lXCJdLmluY2x1ZGVzKGVudHJ5LnRvb2wpLFxuKTtcbmZvciAoY29uc3QgW2dyb3VwLCBlbnRyaWVzXSBvZiBbXG4gIFtcImxsdm1cIiwgbGx2bS5maWx0ZXIoKGVudHJ5KSA9PiAhW1wiY2xhbmdcIiwgXCJsbHZtLXhtbC1ydW50aW1lXCJdLmluY2x1ZGVzKGVudHJ5LnRvb2wpKV0sXG4gIFtcImNsYW5nXCIsIGxsdm0uZmlsdGVyKChlbnRyeSkgPT4gW1wiY2xhbmdcIiwgXCJsbHZtLXhtbC1ydW50aW1lXCJdLmluY2x1ZGVzKGVudHJ5LnRvb2wpKV0sXG5dIGFzIGNvbnN0KSB7XG4gIGlmICghZW50cmllcy5sZW5ndGggfHwgIXJldGFpbmVkKGdyb3VwKSkgY29udGludWU7XG4gIG91dHB1dChcbiAgICBgJHtncm91cH0ta2V5YCxcbiAgICBgJHtncm91cH0tdjMtJHtwbGF0Zm9ybX0tJHtoYXNoKFtwb2xpY2llcyhlbnRyaWVzKSwgYWNxdWlzaXRpb25Db2RlLCBzb3VyY2VJbnB1dHMoc291cmNlR3JvdXBzLmZpbHRlcmVkKV0pfWAsXG4gICk7XG4gIG91dHB1dChgJHtncm91cH0tcGF0aHNgLCBbLi4ubmV3IFNldChlbnRyaWVzLm1hcCgoZW50cnkpID0+IGVudHJ5LmRpcmVjdG9yeSkpXS5qb2luKFwiXFxuXCIpKTtcbn1cblxuY29uc3QgcnVzdFBpbnMgPSBtYW5hZ2VkXG4gID8gW11cbiAgOiB0YXJnZXQucnVudGltZSA9PT0gXCJydXN0XCJcbiAgICA/IFt7IGNoYW5uZWw6IHJlcXVpcmVkKHRhcmdldC52ZXJzaW9uLCBcIk1pc3NpbmcgUnVzdCB2ZXJzaW9uXCIpLCBwcm9maWxlOiBcIm1pbmltYWxcIiwgY29tcG9uZW50czogW10sIHRhcmdldHM6IFtdIH1dXG4gICAgOiB0YXJnZXQucnVudGltZVxuICAgICAgPyBbXVxuICAgICAgOiByb290c1xuICAgICAgICAgIC5mbGF0TWFwKFxuICAgICAgICAgICAgKHJvb3QpID0+XG4gICAgICAgICAgICAgIHJlcXVpcmVkKFxuICAgICAgICAgICAgICAgIGluc3BlY3Rpb24uZGVmYXVsdHMuZmluZCgoZW50cnkpID0+IGVudHJ5LnBhdGggPT09IHJvb3QpLFxuICAgICAgICAgICAgICAgIGBNaXNzaW5nIGRlZmF1bHRzIGZvciAke3Jvb3R9YCxcbiAgICAgICAgICAgICAgKS5wbGFuLFxuICAgICAgICAgIClcbiAgICAgICAgICAuZmlsdGVyKChlbnRyeTogeyB0b29sOiBzdHJpbmcgfSkgPT4gZW50cnkudG9vbCA9PT0gXCJydXN0XCIpXG4gICAgICAgICAgLm1hcCgoZW50cnkpID0+ICh7IGNoYW5uZWw6IGVudHJ5LnZlcnNpb24gfSkpO1xuaWYgKHJ1c3RQaW5zLmxlbmd0aCAmJiByZXRhaW5lZChcInJ1c3RcIikpIHtcbiAgb3V0cHV0KFxuICAgIFwicnVzdC1rZXlcIixcbiAgICBgcnVzdC12Mi0ke3BsYXRmb3JtfS0ke2hhc2goW1suLi5uZXcgU2V0KHJ1c3RQaW5zLm1hcCgocGluKSA9PiBKU09OLnN0cmluZ2lmeShwaW4pKSldLnNvcnQoKSwgcGluSW5wdXRzKFtcInJ1c3QtdG9vbGNoYWluLnRvbWxcIl0pLCByZWFkRmlsZVN5bmMoam9pbihkaXN0cmlidXRpb24sIFwic2NyaXB0cy9ib290c3RyYXAtdG9vbHMuanNvblwiKSwgXCJ1dGY4XCIpLCBhY3F1aXNpdGlvbkNvZGVdKX1gLFxuICApO1xuICBvdXRwdXQoXG4gICAgXCJydXN0LXBhdGhzXCIsXG4gICAgW1xuICAgICAgLi4ubmV3IFNldChcbiAgICAgICAgcnVzdFBpbnMubWFwKChwaW4pID0+XG4gICAgICAgICAgam9pbihyZXF1aXJlZCh2YXJpYWJsZXMuUlVTVFVQX0hPTUUsIFwiTWlzc2luZyBSVVNUVVBfSE9NRVwiKSwgXCJ0b29sY2hhaW5zXCIsIGAke3Bpbi5jaGFubmVsfS0qYCksXG4gICAgICAgICksXG4gICAgICApLFxuICAgICAgam9pbihyZXF1aXJlZCh2YXJpYWJsZXMuQ0FSR09fSE9NRSwgXCJNaXNzaW5nIENBUkdPX0hPTUVcIiksIFwiYmluXCIpLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcbn1cblxud3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiY2FjaGUtcGxhbi5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShtZWFzdXJlZFBsYW4sIG51bGwsIDIpICsgXCJcXG5cIik7XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFVBQVUsUUFBUSxTQUFTLFFBQVEsU0FBUyxvQkFBb0I7QUFFekUsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxnQkFBZ0IsWUFBWSxXQUFXLGNBQWMscUJBQXFCO0FBQ25GLFNBQVMsZUFBZTtBQUN4QixTQUFTLFVBQVUsTUFBTSxlQUFlO0FBQ3hDLFNBQVMsbUJBQW1CLDBCQUEwQjtBQUN0RCxTQUFTLHVCQUF1QjtBQUdoQyxNQUFNLGVB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
