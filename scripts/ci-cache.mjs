import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ciBuildCachePaths, ciCacheEnvironment } from "./ci-layout.mjs";

const distribution = resolve(import.meta.dirname, "..");
const target = JSON.parse(process.env.CACHE_TARGET ?? "{}");
if (process.env.CHECK_CACHE_ENVIRONMENT) target.environment = process.env.CHECK_CACHE_ENVIRONMENT;
const roots = target.paths ?? ["."];
const base = join(process.env.RUNNER_TEMP, "workbench-ci");
const data = join(base, "data");
const cache = join(base, "cache");
const variables = ciCacheEnvironment(cache, data, true);
for (const path of [data, cache]) mkdirSync(path, { recursive: true });
for (const [key, value] of Object.entries(variables)) appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
const inputs = (files) =>
  roots.flatMap((root) =>
    files.flatMap((name) => {
      const path = join(root, name);
      return existsSync(path) ? [[path, readFileSync(path, "utf8")]] : [];
    }),
  );
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const platform = `${process.platform}-${process.arch}`;
const windows = process.platform === "win32";
// Inspection resolves the same artifacts, trust material and resource policy as installation.
const inspect = (args, cwd = process.cwd()) =>
  JSON.parse(
    execFileSync(process.execPath, [join(distribution, "bin/workbench.mjs"), ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...variables },
    }),
  );
const selection = ["clang", "gcc"].includes(target.runtime)
  ? ["--compiler", target.runtime, "--compiler-version", target.version]
  : [];
const runtimeOnly = ["node", "go", "java", "ruby", "php"].includes(target.runtime);
const managed = target.environment && target.environment !== "devcontainer";
const plan =
  runtimeOnly || managed
    ? []
    : roots
        .flatMap((root) => inspect(["tools", "--json", "--path", root, ...selection]))
        .filter((entry) =>
          target.runtime === "python"
            ? entry.tool === "uv"
            : target.runtime === "rust"
              ? false
              : target.environment === "devcontainer"
                ? entry.tool === "node"
                : true,
        );
if (runtimeOnly) {
  for (const root of roots) {
    const runtime = inspect(["compatibility-exec", root, target.runtime, target.version, "--plan"]);
    if (target.runtime === "java")
      plan.push(...inspect(["tools", "--json", "--path", root]).filter((entry) => entry.tool === "maven"));
    plan.push({
      root,
      tool: runtime.tool.name,
      version: runtime.tool.version,
      directory: runtime.directory,
      filtered: false,
      policy: runtime.policy,
    });
  }
}
const ordinary = plan.filter(
  (entry) =>
    typeof entry.directory === "string" &&
    !entry.filtered &&
    !["llvm-runtime", "llvm-xml-runtime", "gcc"].includes(entry.tool) &&
    (target.runtime !== "python" || entry.tool === "uv"),
);
const policies = (entries) =>
  [
    ...new Map(
      entries
        .filter((entry) => typeof entry.directory === "string")
        .map((entry) => [entry.directory, [entry.tool, entry.version, entry.policy, basename(entry.directory)]]),
    ).values(),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const sourceInputs = (files) => inspect(["distribution-inputs", ...files]);
const acquisitionCode = sourceInputs([
  "src/tool-downloads.ts",
  "src/runtime-builds.ts",
  "src/seven-zip.ts",
  "src/artifact-streams.ts",
  "src/archive-extraction.ts",
  "src/artifact-decoders.ts",
  "src/artifact-signatures.ts",
  "src/artifact-attestations.ts",
  "src/artifact-repositories.ts",
  "src/artifact-policy.ts",
]);
const vcpkg =
  (target.runtime && !["clang", "gcc"].includes(target.runtime)) || managed ? [] : inputs([".vcpkg-version"]);
const vcpkgPaths = [
  ...new Set(vcpkg.map(([, revision]) => join(cache, "toolchains", "vcpkg", revision.trim(), platform))),
];
const pythonPaths =
  !windows && (target.runtime === "python" || (!target.runtime && !managed && inputs([".python-version"]).length))
    ? [join(cache, "uv-python", "python")]
    : [];
const devcontainerRuntimes =
  target.environment === "devcontainer"
    ? roots
        .flatMap((root) => inspect(["tools", "--json", "--path", root]))
        .filter((entry) => !["rust", "miri", "python"].includes(entry.tool))
    : [];
// Guest OS identities are resolved after startup; retain only selected tool versions across those identities.
const devcontainerRuntimePaths = [
  ...new Set(devcontainerRuntimes.map((entry) => join(cache, "toolchains", entry.tool, entry.version))),
];
const tools = hash([
  policies(devcontainerRuntimes),
  target.environment === "devcontainer"
    ? [".devcontainer/Dockerfile", ".devcontainer/devcontainer.json"]
        .filter((file) => existsSync(file))
        .map((file) => [file, readFileSync(file, "utf8")])
    : [],
  devcontainerRuntimePaths,
  inputs([".ruby-version", ".php-version"]),
  devcontainerRuntimes.some((entry) => entry.filtered) ? sourceInputs(["src/filtered-artifacts.ts"]) : [],
  policies(ordinary),
  acquisitionCode,
  vcpkg,
  vcpkg.length ? sourceInputs(["src/vcpkg.ts"]) : [],
  pythonPaths.length
    ? [inputs([".python-version"]), target.runtime === "python" ? target.version : undefined]
    : undefined,
]);
const managers = roots
  .filter(
    (root) => (!target.runtime || target.runtime === "node") && !managed && existsSync(join(root, "package.json")),
  )
  .map((root) => inspect(["package-manager-exec", "--plan"], join(process.cwd(), root)));
const managerKey = hash([
  [...new Set(managers.map((entry) => entry.identity))].sort(),
  inputs(["Gemfile.lock"]),
  sourceInputs(["src/ruby-manager.ts"]),
  sourceInputs(["src/package-manager.ts", "src/toolchains.ts", "src/tool-downloads.ts"]),
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
  ".mvn/jvm.config",
]);
// Download stores validate their contents through their owning package managers.
// Installer edits and runtime patch selections must not invalidate those stores.
const downloads = hash(manifests);
const builds = hash([
  manifests,
  inputs([
    "CMakeLists.txt",
    ".llvm-version",
    ".gcc-version",
    "rust-toolchain.toml",
    "rust-toolchain-miri.toml",
    ".python-version",
    ".go-version",
    ".node-version",
    ".java-version",
    ".ruby-version",
    ".php-version",
    ".composer-version",
    ".xdebug-version",
  ]),
  target.environment ? inputs(["flake.nix", "flake.lock", "channels.scm", "manifest.scm"]) : undefined,
  readFileSync("workbench/projects.toml", "utf8"),
  policies(plan),
  acquisitionCode,
  sourceInputs(["src/builds.ts"]),
  tools,
  target.runtime,
  target.version,
  target.environment,
  inputs([".devcontainer/devcontainer.json", ".devcontainer/Dockerfile"]),
]);
const measuredPlan = {};
const output = (key, value) => {
  measuredPlan[key] = value;
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<WORKBENCH_CACHE\n${value}\nWORKBENCH_CACHE\n`);
};
if (ordinary.length || vcpkgPaths.length || pythonPaths.length || devcontainerRuntimePaths.length)
  output("tools-key", `tools-v${windows ? 7 : 6}-${platform}-${tools}`);
output(
  "tools-paths",
  [
    ...new Set([
      ...ordinary.map((entry) => entry.directory),
      ...devcontainerRuntimePaths,
      ...vcpkgPaths,
      ...pythonPaths,
      ...(inputs([".xdebug-version"]).length ? [join(cache, "toolchains/xdebug")] : []),
    ]),
  ].join("\n"),
);
if (managers.length || inputs(["Gemfile.lock"]).length) {
  output("package-managers-key", `package-managers-v1-${platform}-${managerKey}`);
  output(
    "package-managers-paths",
    [
      ...new Set([
        ...managers.map((entry) => entry.directory),
        ...(inputs(["Gemfile.lock"]).length ? [join(cache, "package-managers/bundler")] : []),
      ]),
    ].join("\n"),
  );
}
output("downloads-key", `downloads-v${windows ? 2 : 1}-${platform}-${downloads}`);
output(
  "downloads-paths",
  [
    ...["uv", "go-mod", "npm", "pip"].map((name) => join(cache, name)),
    join(cache, "downloads", "pnpm"),
    ...(windows ? [join(cache, "downloads", "uv-python")] : []),
    join(cache, "downloads", "maven"),
    join(cache, "downloads", "composer"),
    join(cache, "downloads", "bundler"),
    join(cache, "vcpkg", "downloads"),
    join(variables.CARGO_HOME, "registry"),
    join(variables.CARGO_HOME, "git"),
  ].join("\n"),
);
output("builds-key", `builds-v${windows ? 2 : 1}-${platform}-${builds}`);
output("builds-paths", ciBuildCachePaths(cache, target.environment).join("\n"));
if (target.runtime === "gcc") {
  const gcc = plan.filter((entry) => entry.tool === "gcc");
  output("gcc-key", `gcc-v4-${platform}-${target.version}-${hash([policies(gcc), acquisitionCode])}`);
  output("gcc-path", [...new Set(gcc.map((entry) => entry.directory))].join("\n"));
}
output("guix-key", `guix-source-v1-${platform}-${hash(inputs(["channels.scm"]))}`);
output("guix-paths", ["checkouts", "authentication"].map((name) => join(homedir(), ".cache", "guix", name)).join("\n"));

const llvm = plan.filter((entry) => entry.filtered || ["llvm-runtime", "llvm-xml-runtime"].includes(entry.tool));
if (llvm.length) {
  output(
    "llvm-key",
    `llvm-v2-${platform}-${hash([policies(llvm), acquisitionCode, sourceInputs(["src/filtered-artifacts.ts"])])}`,
  );
  output("llvm-paths", [...new Set(llvm.map((entry) => entry.directory))].join("\n"));
}

const rustPins = managed
  ? []
  : target.runtime === "rust"
    ? [{ channel: target.version, profile: "minimal", components: [], targets: [] }]
    : target.runtime
      ? []
      : roots
          .flatMap((root) => inspect(["tools", "--json", "--path", root]))
          .filter((entry) => ["rust", "miri"].includes(entry.tool))
          .map((entry) => ({ channel: entry.version }));
if (rustPins.length) {
  output(
    "rust-key",
    `rust-v1-${platform}-${hash([rustPins, inputs(["rust-toolchain.toml", "rust-toolchain-miri.toml"]), readFileSync(join(distribution, "scripts/bootstrap-tools.json"), "utf8"), acquisitionCode])}`,
  );
  output(
    "rust-paths",
    [
      ...new Set(rustPins.map((pin) => join(variables.RUSTUP_HOME, "toolchains", `${pin.channel}-*`))),
      join(variables.CARGO_HOME, "bin"),
    ].join("\n"),
  );
}

writeFileSync(join(base, "cache-plan.json"), JSON.stringify(measuredPlan, null, 2) + "\n");
