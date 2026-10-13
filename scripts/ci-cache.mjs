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
// An installed artifact depends on its pin, not which roots declare the same pin.
const pinInputs = (files) =>
  [...new Set(inputs(files).map(([path, value]) => JSON.stringify([basename(path), value.trim()])))].sort();
const platform = `${process.platform}-${process.arch}`;
const windows = process.platform === "win32";
// Reacquire these prebuilt tools through the verified installer on each hosted job.
// Keep local reuse and reuse between roots within the job; reserve Actions storage
// for expensive builds rather than prebuilt SDK installations.
const redownload = new Set([
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
  "cargo-llvm-cov",
]);
// Project policy controls hosted retention only; installers still reuse verified local files.
const configuredCache = execFileSync(
  process.execPath,
  [join(distribution, "bin/workbench.mjs"), "config", "get", "ci.cache", "--scope", "project"],
  { encoding: "utf8" },
).trim();
const retention = configuredCache === "<unset>" ? {} : (JSON.parse(configuredCache).artifacts ?? {});
const retained = (tool) => (retention[tool] ? retention[tool] === "cache" : !redownload.has(tool));
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
    : (target.selections ?? roots.map((path) => ({ path })))
        .flatMap(({ path, toolchain }) =>
          inspect([
            "tools",
            "--json",
            "--path",
            path,
            "--exclude-tool",
            "miri",
            ...selection,
            ...(toolchain ? ["--toolchain", toolchain] : []),
          ]),
        )
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
    (!entry.filtered || entry.tool === "gcc") &&
    retained(entry.tool) &&
    !["llvm-runtime", "llvm-xml-runtime"].includes(entry.tool) &&
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
  "src/tool-host.ts",
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
  (target.runtime && !["clang", "gcc"].includes(target.runtime)) || managed
    ? []
    : [...new Set(inputs([".vcpkg-version"]).map(([, revision]) => revision.trim()))].sort();
const vcpkgPaths = [...new Set(vcpkg.map((revision) => join(cache, "toolchains", "vcpkg", revision, platform)))];
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
const cachedDevcontainerRuntimes = devcontainerRuntimes.filter((entry) => retained(entry.tool));
// Guest OS identities are resolved after startup; retain only selected tool versions across those identities.
const devcontainerRuntimePaths = [
  ...new Set(
    cachedDevcontainerRuntimes
      .filter(
        (entry) =>
          (!entry.filtered || entry.tool === "gcc") && !["llvm-runtime", "llvm-xml-runtime"].includes(entry.tool),
      )
      .map((entry) => (entry.tool === "gcc" ? entry.directory : join(cache, "toolchains", entry.tool, entry.version))),
  ),
].sort();
const tools = hash([
  policies(cachedDevcontainerRuntimes),
  target.environment === "devcontainer"
    ? [".devcontainer/Dockerfile", ".devcontainer/devcontainer.json"]
        .filter((file) => existsSync(file))
        .map((file) => [file, readFileSync(file, "utf8")])
    : [],
  devcontainerRuntimePaths,
  pinInputs([".ruby-version", ".php-version"]),
  [...ordinary, ...cachedDevcontainerRuntimes].some((entry) => entry.filtered)
    ? sourceInputs(["src/filtered-artifacts.ts"])
    : [],
  policies(ordinary),
  acquisitionCode,
  vcpkg,
  vcpkg.length ? sourceInputs(["src/vcpkg.ts"]) : [],
  pythonPaths.length
    ? [pinInputs([".python-version"]), target.runtime === "python" ? target.version : undefined]
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
  // Redownloaded guest tools still determine compiled-output compatibility.
  policies(devcontainerRuntimes),
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
// Cache entries are immutable: changing the encoder level must create a new identity.
const compressionLevel = process.env.ZSTD_CLEVEL ?? "3";
if (!/^(?:[1-9]|1[0-9])$/.test(compressionLevel)) throw new Error("ZSTD_CLEVEL must be an integer from 1 to 19");
const output = (key, value) => {
  if (key.endsWith("-key")) {
    // Reuse identical contents saved with an older compression policy before saving the new key.
    output(key.replace(/-key$/, "-restore-keys"), value);
    value += `-zstd${compressionLevel}`;
  }
  measuredPlan[key] = value;
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<WORKBENCH_CACHE\n${value}\nWORKBENCH_CACHE\n`);
};
if (ordinary.length || vcpkgPaths.length || pythonPaths.length || devcontainerRuntimePaths.length)
  // Do not restore the broader installation archives from earlier layouts.
  output("tools-key", `tools-v8-${platform}-${tools}`);
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
// v2 omits installed dependencies; do not restore archives from the broader v1 layout.
output("builds-key", `builds-v2-${platform}-${builds}`);
output("builds-paths", ciBuildCachePaths(cache, target.environment).join("\n"));
// The same channel history is reusable across any roots declaring those channels.
output("guix-key", `guix-source-v2-${platform}-${hash(pinInputs(["channels.scm"]))}`);
output("guix-paths", ["checkouts", "authentication"].map((name) => join(homedir(), ".cache", "guix", name)).join("\n"));
if (target.environment === "guix") {
  output(
    "guix-bootstrap-key",
    `guix-bootstrap-v1-${platform}-${hash([pinInputs(["channels.scm"]), sourceInputs(["scripts/ci-guix-bootstrap.mjs", "scripts/ci-guix-bootstrap.scm"])])}`,
  );
  output("guix-bootstrap-path", join(cache, "guix-bootstrap"));
}

// Keep the development SDK reusable when an older compatibility compiler is selected.
// Dev Containers use the same immutable LLVM artifacts and language-owned filters.
const llvm = [...plan, ...devcontainerRuntimes].filter((entry) =>
  ["llvm", "clang", "llvm-runtime", "llvm-xml-runtime"].includes(entry.tool),
);
for (const [group, entries] of [
  ["llvm", llvm.filter((entry) => !["clang", "llvm-xml-runtime"].includes(entry.tool))],
  ["clang", llvm.filter((entry) => ["clang", "llvm-xml-runtime"].includes(entry.tool))],
]) {
  if (!entries.length || !retained(group)) continue;
  output(
    `${group}-key`,
    `${group}-v3-${platform}-${hash([policies(entries), acquisitionCode, sourceInputs(["src/filtered-artifacts.ts"])])}`,
  );
  output(`${group}-paths`, [...new Set(entries.map((entry) => entry.directory))].join("\n"));
}

const rustPins = managed
  ? []
  : target.runtime === "rust"
    ? [{ channel: target.version, profile: "minimal", components: [], targets: [] }]
    : target.runtime
      ? []
      : roots
          .flatMap((root) => inspect(["tools", "--json", "--path", root]))
          .filter((entry) => entry.tool === "rust")
          .map((entry) => ({ channel: entry.version }));
if (rustPins.length && retained("rust")) {
  output(
    "rust-key",
    `rust-v2-${platform}-${hash([[...new Set(rustPins.map((pin) => JSON.stringify(pin)))].sort(), pinInputs(["rust-toolchain.toml"]), readFileSync(join(distribution, "scripts/bootstrap-tools.json"), "utf8"), acquisitionCode])}`,
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
