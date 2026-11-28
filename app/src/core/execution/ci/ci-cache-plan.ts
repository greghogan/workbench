import { isCompilerFamily } from "../../toolchains/compiler-catalog.mjs";
import { required } from "../../runtime/invariants.js";
import { classifyCICacheTarget, inspectCICache, type CacheInspectionRequest } from "./ci-cache-inspection.js";
import { distributionRoot } from "../../projects/project-context.js";
import { projectPaths } from "../../projects/project-paths.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ciBuildCachePaths, ciCacheEnvironment } from "./support/ci-layout.mjs";
import { guixChannelFile } from "../environments/managed/managed-contract.mjs";

export function planCICache(
  project: string,
  target: CacheInspectionRequest["target"],
  cache: string,
  compressionLevel = "3",
) {
  const source = distributionRoot(project);
  const roots = target.paths ?? ["."];
  const variables = ciCacheEnvironment(cache, join(cache, "..", "data"), true);
  const inputs = (files: string[]): [string, string][] =>
    roots.flatMap((root: string) =>
      files.flatMap((name: string) => {
        const path = join(root, name);
        return existsSync(join(project, path))
          ? [[path, readFileSync(join(project, path), "utf8")] as [string, string]]
          : [];
      }),
    );
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
  // An installed artifact depends on its pin, not which roots declare the same pin.
  const pinInputs = (files: string[]) =>
    [...new Set(inputs(files).map(([path, value]) => JSON.stringify([basename(path), value.trim()])))].sort();
  const guixChannels = [
    ...new Set(
      roots
        .map((root: string) => guixChannelFile(project, resolve(project, root)))
        .filter(existsSync)
        .map((path) => readFileSync(path, "utf8").trim()),
    ),
  ].sort();
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
  // Collect every source identity in the same process as tool and package-manager planning.
  const sourceGroups = {
    acquisition: [
      "app/src/core/toolchains/tool-downloads.ts",
      "app/src/core/toolchains/tool-host.ts",
      "app/src/core/artifacts/runtime-builds.ts",
      "app/src/core/toolchains/seven-zip.ts",
      "app/src/core/toolchains/acquisition/artifact-streams.ts",
      "app/src/core/toolchains/acquisition/archive-extraction.ts",
      "app/src/core/toolchains/acquisition/artifact-decoders.ts",
      "app/src/core/toolchains/acquisition/artifact-signatures.ts",
      "app/src/core/toolchains/acquisition/artifact-attestations.ts",
      "app/src/core/toolchains/acquisition/attestation-verification.ts",
      "app/src/core/toolchains/acquisition/artifact-repositories.ts",
      "app/src/core/toolchains/acquisition/artifact-policy.ts",
    ],
    filtered: ["app/src/core/toolchains/filtered-artifacts.ts"],
    vcpkg: ["app/src/core/toolchains/vcpkg.ts", "app/src/core/toolchains/mvsc.ts"],
    ruby: ["app/src/core/toolchains/ruby-manager.ts"],
    packageManager: [
      "app/src/core/artifacts/package-manager.ts",
      "app/src/core/toolchains/toolchains.ts",
      "app/src/core/toolchains/tool-downloads.ts",
    ],
    container: [
      "app/src/core/artifacts/container-tools.ts",
      "scripts/container-tools/package.json",
      "scripts/container-tools/package-lock.json",
    ],
    builds: ["app/src/core/artifacts/builds.ts"],
    guix:
      target.environment === "guix"
        ? [
            "scripts/ci-guix-bootstrap.mjs",
            "scripts/ci-guix-bootstrap.scm",
            "app/src/core/execution/environments/managed/managed-contract.mjs",
          ]
        : [],
  };
  const sourceFiles = [...new Set(Object.values(sourceGroups).flat())];
  const inspection = inspectCICache(project, { target, sources: sourceFiles });
  const retained = (tool: string) =>
    inspection.retention[tool] ? inspection.retention[tool] === "cache" : !redownload.has(tool);
  const { runtimeOnly, managed } = classifyCICacheTarget(target);
  interface PlannedTool {
    root: string;
    tool: string;
    version: string;
    directory?: string | undefined;
    filtered?: boolean;
    policy?: string | undefined;
    manager?: string;
  }
  const plan: PlannedTool[] = inspection.native
    .flatMap(({ plan }) => plan)
    .filter((entry: { tool: string }) =>
      target.runtime === "python"
        ? entry.tool === "uv"
        : target.runtime === "rust"
          ? false
          : target.environment === "devcontainer"
            ? entry.tool === "node"
            : true,
    );
  if (runtimeOnly) {
    for (const { path: root, plan: runtime } of inspection.runtimes) {
      if (target.runtime === "java")
        plan.push(
          ...required(
            inspection.defaults.find((entry) => entry.path === root),
            `Missing defaults for ${root}`,
          ).plan.filter((entry: { tool: string }) => entry.tool === "maven"),
        );
      plan.push({
        root,
        tool: runtime.tool.name,
        version: runtime.tool.version,
        directory: required(runtime.directory, "Missing runtime directory"),
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
  const policies = (entries: typeof plan) =>
    [
      ...new Map(
        entries
          .filter((entry) => typeof entry.directory === "string")
          .map((entry) => [
            entry.directory,
            [entry.tool, entry.version, entry.policy, basename(required(entry.directory, "Missing tool directory"))],
          ]),
      ).values(),
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const sourceInputs = (files: string[]) => files.map((file: string | number) => [file, inspection.sources[file]]);
  const acquisitionCode = sourceInputs(sourceGroups.acquisition);
  const vcpkg =
    (target.runtime && !isCompilerFamily(target.runtime)) || managed
      ? []
      : [...new Set(inputs([".vcpkg-version"]).map(([, revision]) => revision.trim()))].sort();
  const vcpkgPaths = [...new Set(vcpkg.map((revision) => join(cache, "toolchains", "vcpkg", revision, platform)))];
  const pythonPaths =
    !windows && (target.runtime === "python" || (!target.runtime && !managed && inputs([".python-version"]).length))
      ? [join(cache, "uv-python", "python")]
      : [];
  const devcontainerRuntimes: PlannedTool[] =
    target.environment === "devcontainer"
      ? roots
          .flatMap(
            (root) =>
              required(
                inspection.defaults.find((entry) => entry.path === root),
                `Missing defaults for ${root}`,
              ).plan,
          )
          .filter((entry: { tool: string }) => !["rust", "miri", "python"].includes(entry.tool))
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
        .map((entry) =>
          entry.tool === "gcc" ? entry.directory : join(cache, "toolchains", entry.tool, entry.version),
        ),
    ),
  ].sort();
  const tools = hash([
    policies(cachedDevcontainerRuntimes),
    target.environment === "devcontainer"
      ? [".devcontainer/Dockerfile", ".devcontainer/devcontainer.json"]
          .filter((file) => existsSync(join(project, file)))
          .map((file) => [file, readFileSync(join(project, file), "utf8")])
      : [],
    devcontainerRuntimePaths,
    pinInputs([".ruby-version", ".php-version"]),
    [...ordinary, ...cachedDevcontainerRuntimes].some((entry) => entry.filtered)
      ? sourceInputs(sourceGroups.filtered)
      : [],
    policies(ordinary),
    acquisitionCode,
    vcpkg,
    vcpkg.length ? sourceInputs(sourceGroups.vcpkg) : [],
    pythonPaths.length
      ? [pinInputs([".python-version"]), target.runtime === "python" ? target.version : undefined]
      : undefined,
  ]);
  const managers = inspection.managers;
  const managerKey = hash([
    [...new Set(managers.map((entry) => entry.identity))].sort(),
    inputs(["Gemfile.lock"]),
    sourceInputs(sourceGroups.ruby),
    sourceInputs(sourceGroups.packageManager),
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
      ".xdebug-version",
    ]),
    target.environment ? inputs(["flake.nix", "flake.lock", "manifest.scm"]) : undefined,
    target.environment === "guix" ? guixChannels : undefined,
    readFileSync(join(project, projectPaths.projects), "utf8"),
    // Redownloaded guest tools still determine compiled-output compatibility.
    policies(devcontainerRuntimes),
    policies(plan),
    acquisitionCode,
    sourceInputs(sourceGroups.builds),
    sourceInputs(sourceGroups.container),
    tools,
    target.runtime,
    target.version,
    target.environment,
    inputs([".devcontainer/devcontainer.json", ".devcontainer/Dockerfile"]),
  ]);
  const measuredPlan: Record<string, string> = {};
  // Cache entries are immutable: changing the encoder level must create a new identity.
  if (!/^(?:[1-9]|1[0-9])$/.test(compressionLevel)) throw new Error("ZSTD_CLEVEL must be an integer from 1 to 19");
  const output = (key: string, value: string) => {
    if (key.endsWith("-key")) {
      // Reuse identical contents saved with an older compression policy before saving the new key.
      output(key.replace(/-key$/, "-restore-keys"), value);
      value += `-zstd${compressionLevel}`;
    }
    measuredPlan[key] = value;
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
  output("downloads-key", `downloads-v${String(windows ? 2 : 1)}-${platform}-${downloads}`);
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
      join(required(variables.CARGO_HOME, "Missing CARGO_HOME"), "registry"),
      join(required(variables.CARGO_HOME, "Missing CARGO_HOME"), "git"),
    ].join("\n"),
  );
  // v3 retains the host container runtime without restoring project dependency trees.
  output("builds-key", `builds-v3-${platform}-${builds}`);
  output("builds-paths", ciBuildCachePaths(cache).join("\n"));
  // The same channel history is reusable across any roots declaring those channels.
  output("guix-key", `guix-source-v2-${platform}-${hash(guixChannels)}`);
  output(
    "guix-paths",
    ["checkouts", "authentication"].map((name) => join(homedir(), ".cache", "guix", name)).join("\n"),
  );
  if (target.environment === "guix") {
    output(
      "guix-bootstrap-key",
      `guix-bootstrap-v1-${platform}-${hash([guixChannels, sourceInputs(sourceGroups.guix)])}`,
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
  ] as const) {
    if (!entries.length || !retained(group)) continue;
    output(
      `${group}-key`,
      `${group}-v3-${platform}-${hash([policies(entries), acquisitionCode, sourceInputs(sourceGroups.filtered)])}`,
    );
    output(`${group}-paths`, [...new Set(entries.map((entry) => entry.directory))].join("\n"));
  }

  const rustPins = managed
    ? []
    : target.runtime === "rust"
      ? [{ channel: required(target.version, "Missing Rust version"), profile: "minimal", components: [], targets: [] }]
      : target.runtime
        ? []
        : roots
            .flatMap(
              (root) =>
                required(
                  inspection.defaults.find((entry) => entry.path === root),
                  `Missing defaults for ${root}`,
                ).plan,
            )
            .filter((entry: { tool: string }) => entry.tool === "rust")
            .map((entry) => ({ channel: entry.version }));
  if (rustPins.length && retained("rust")) {
    output(
      "rust-key",
      `rust-v2-${platform}-${hash([[...new Set(rustPins.map((pin) => JSON.stringify(pin)))].sort(), pinInputs(["rust-toolchain.toml"]), readFileSync(join(source, "scripts/bootstrap-tools.json"), "utf8"), acquisitionCode])}`,
    );
    output(
      "rust-paths",
      [
        ...new Set(
          rustPins.map((pin) =>
            join(required(variables.RUSTUP_HOME, "Missing RUSTUP_HOME"), "toolchains", `${pin.channel}-*`),
          ),
        ),
        join(required(variables.CARGO_HOME, "Missing CARGO_HOME"), "bin"),
      ].join("\n"),
    );
  }

  return measuredPlan;
}
