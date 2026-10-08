import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { distributionRoot, readConfig, readLanguageRoots, readText, readToml, type Config } from "./core.js";
import { readChecks } from "./checks.js";
import { coverageApplies, planChecks, selectedValues as selection } from "./check-plan.js";
import { exactVersion as exact, standaloneTools } from "./toolchains.js";
import { devcontainerConfig } from "./devcontainers.js";
import { selectedCompiler } from "./compilers.js";

const runners = {
  linux: { x64: "ubuntu-24.04", arm64: "ubuntu-24.04-arm" },
  macos: { arm64: "macos-15" },
  windows: { x64: "windows-2025" },
} as const;
const environments = ["guix", "nix", "nix-docker", "devcontainer"];

/** CI coverage is independent of the local check default. Roots may narrow the selected environments. */
export function ciCoverage(root: string, config: Pick<Config, "ci"> = readConfig(root)) {
  const roots = readLanguageRoots(root);
  if (config.ci === undefined) {
    if (roots.some((entry) => entry.ci_environments !== undefined || entry.ci_versions !== undefined))
      throw new Error("language_root CI selections require [ci] configuration");
    return undefined;
  }
  const operatingSystems = selection(config.ci.operating_systems, Object.keys(runners), "ci.operating_systems");
  if (!operatingSystems.length) throw new Error("ci.operating_systems must select at least one operating system");
  const selected = selection(config.ci.environments ?? [], environments, "ci.environments");
  const platforms = operatingSystems.flatMap((os) => {
    const system = os as keyof typeof runners;
    const selected = selection(
      config.ci?.architectures?.[system] ?? [system === "macos" ? "arm64" : "x64"],
      Object.keys(runners[system]),
      `ci.architectures.${os}`,
    );
    if (!selected.length) throw new Error(`ci.architectures.${os} must select at least one architecture`);
    return selected.map((architecture) => ({
      os,
      architecture,
      runner: (runners[system] as Record<string, string>)[architecture],
    }));
  });
  const paths = new Map<string, { path: string; languages: string[]; environments: string[] }>();
  for (const entry of roots) {
    const enabled = [
      ...selection(entry.ci_environments ?? selected, selected, `${entry.path}: ci_environments`),
    ].sort();
    const existing = paths.get(entry.path);
    if (existing) {
      if (JSON.stringify(existing.environments) !== JSON.stringify(enabled))
        throw new Error(`${entry.path}: languages sharing a check root must select the same CI environments`);
      existing.languages.push(entry.language);
    } else paths.set(entry.path, { path: entry.path, languages: [entry.language], environments: enabled });
  }
  if (!paths.size) throw new Error("[ci] requires at least one registered language root");
  return { operatingSystems, platforms, roots: [...paths.values()] };
}

function toolVersions(directory: string) {
  const textPin = (file: string) =>
    existsSync(join(directory, file)) ? exact(readText(join(directory, file)).trim(), file) : "";
  const rustPath = join(directory, "rust-toolchain.toml");
  const rust = existsSync(rustPath)
    ? exact((readToml(rustPath) as { toolchain?: { channel?: unknown } }).toolchain?.channel, rustPath)
    : "";
  standaloneTools(directory);
  return {
    node: textPin(".node-version"),
    python: textPin(".python-version"),
    rust,
    go: textPin(".go-version"),
    llvm: textPin(".llvm-version"),
  };
}

/** JSON include matrices are consumed directly by GitHub Actions, without a second language list. */
export function ciMatrix(root: string) {
  const config = readConfig(root);
  const coverage = ciCoverage(root, config);
  if (!coverage) throw new Error("configure [ci].operating_systems before requesting a CI matrix");
  const allChecks = readChecks(root);
  const checks = allChecks.filter((check) => check.stages.includes("ci"));
  for (const check of checks) {
    if (!coverage.roots.some((entry) => resolve(root, entry.path) === resolve(check.directory)))
      throw new Error(`${check.location}: configured check has no registered CI language root`);
  }
  const native = [];
  const managed = [];
  const compatibility: {
    path: string;
    runtime: string;
    version: string;
    node?: string;
    architecture?: string;
    runner?: string;
  }[] = [];
  const roots = readLanguageRoots(root);
  for (const entry of coverage.roots) {
    const directory = resolve(root, entry.path);
    if (!checks.some((check) => resolve(check.directory) === directory && check.role !== "setup"))
      throw new Error(`${entry.path}: CI root has no configured checks`);
    const versions = toolVersions(directory);
    const node =
      versions.node || exact(readText(join(distributionRoot(root), ".node-version")).trim(), ".node-version");
    const compiler = selectedCompiler(directory);
    if (compiler) {
      const policy = roots.find(
        (candidate) => candidate.path === entry.path && (candidate.language === "c" || candidate.language === "cpp"),
      );
      for (const [family, support] of Object.entries(policy?.compilers ?? {}))
        for (const version of new Set([support.minimum, ...support.ci_versions]))
          for (const architecture of support.ci_architectures ?? ["x64"])
            if (
              family !== compiler.family ||
              version !== compiler.version ||
              !coverage.platforms.some((platform) => platform.os === "linux" && platform.architecture === architecture)
            )
              compatibility.push({
                path: entry.path,
                runtime: family,
                version,
                node,
                architecture,
                runner: runners.linux[architecture as keyof typeof runners.linux],
              });
    }
    for (const platform of coverage.platforms) native.push({ path: entry.path, ...platform, ...versions, node });
    for (const environment of entry.environments) {
      if (environment === "devcontainer") devcontainerConfig(root);
      for (const file of environment === "devcontainer"
        ? []
        : environment === "guix"
          ? ["channels.scm", "manifest.scm"]
          : ["flake.nix", "flake.lock"])
        if (!existsSync(join(directory, file))) throw new Error(`${entry.path}: ${environment} needs ${file}`);
      if (environment === "nix-docker" && !config.checks?.nix_docker_image)
        throw new Error("ci.environments: nix-docker needs checks.nix_docker_image");
      managed.push({ path: entry.path, environment, node });
    }
    if (versions.node) {
      const metadata = JSON.parse(readText(join(directory, "package.json"))) as { engines?: { node?: string } };
      const version = /^>=(\d+\.\d+\.\d+)$/.exec(metadata.engines?.node ?? "")?.[1];
      if (!version) throw new Error(`${entry.path}: CI needs engines.node in the form >=major.minor.patch`);
      if (version !== versions.node) compatibility.push({ path: entry.path, runtime: "node", version });
    }
    if (versions.go) {
      const minimumGo = /^go (\d+\.\d+\.\d+)$/m.exec(readText(join(directory, "go.mod")))?.[1];
      if (!minimumGo) throw new Error(`${entry.path}: go.mod needs an exact minimum Go version`);
      if (minimumGo !== versions.go) compatibility.push({ path: entry.path, runtime: "go", version: minimumGo });
    }
    if (versions.python) {
      const manifest = readToml(join(directory, "pyproject.toml")) as { project?: { "requires-python"?: unknown } };
      const requirement = manifest.project?.["requires-python"];
      const match = typeof requirement === "string" ? /^>=(\d+\.\d+(?:\.\d+)?)$/.exec(requirement) : null;
      const declared = match?.[1];
      if (!declared) throw new Error(`${entry.path}: CI needs requires-python in the form >=major.minor[.patch]`);
      const version = declared.split(".").length === 2 ? `${declared}.0` : declared;
      if (version !== versions.python) compatibility.push({ path: entry.path, runtime: "python", version });
    }
    if (versions.rust) {
      const manifest = readToml(join(directory, "Cargo.toml")) as {
        package?: { "rust-version"?: unknown };
        workspace?: { package?: { "rust-version"?: unknown } };
      };
      const declared = manifest.package?.["rust-version"];
      const value = typeof declared === "string" ? declared : manifest.workspace?.package?.["rust-version"];
      const version =
        typeof value === "string" && /^\d+\.\d+(?:\.\d+)?$/.test(value)
          ? exact(value.split(".").length === 2 ? `${value}.0` : value, "rust-version")
          : undefined;
      if (!version) throw new Error(`${entry.path}: CI needs package.rust-version or workspace.package.rust-version`);
      if (version !== versions.rust) compatibility.push({ path: entry.path, runtime: "rust", version });
    }
    for (const languageRoot of roots.filter((candidate) => candidate.path === entry.path)) {
      if (languageRoot.ci_versions === undefined) continue;
      const runtime = { typescript: "node", python: "python", go: "go" }[languageRoot.language];
      if (!runtime) throw new Error(`${entry.path}: ci_versions supports TypeScript, Python, and Go roots`);
      const development = versions[runtime as "node" | "python" | "go"];
      if (!development) throw new Error(`${entry.path}: ci_versions needs a native ${runtime} pin`);
      const selected = languageRoot.ci_versions.map((version) => exact(version, `${entry.path}: ci_versions`));
      if (!selected.length || new Set(selected).size !== selected.length)
        throw new Error(`${entry.path}: ci_versions needs a nonempty list without duplicates`);
      const manifestMinimum = compatibility.find((target) => target.path === entry.path && target.runtime === runtime);
      const floor = manifestMinimum?.version ?? development;
      const compare = (left: string, right: string) => left.localeCompare(right, "en", { numeric: true });
      for (const version of selected) {
        if (compare(version, floor) < 0) throw new Error(`${entry.path}: ci_versions ${version} is below ${floor}`);
        if (
          version !== development &&
          !compatibility.some(
            (target) => target.path === entry.path && target.runtime === runtime && target.version === version,
          )
        )
          compatibility.push({ path: entry.path, runtime, version });
      }
      if (runtime === "python") {
        const covered = [floor, development, ...selected];
        const major = Number(floor.split(".")[0]);
        if (covered.some((version) => Number(version.split(".")[0]) !== major))
          throw new Error(`${entry.path}: ci_versions must use the supported Python major`);
        const minors = [...new Set(covered.map((version) => Number(version.split(".")[1])))].sort((a, b) => a - b);
        for (const [index, minor] of minors.entries()) {
          const previous = minors[index - 1];
          if (previous !== undefined && minor !== previous + 1)
            throw new Error(`${entry.path}: ci_versions omits Python ${String(major)}.${String(previous + 1)}`);
        }
      }
    }
  }
  const targets = [
    ...native.map((target) => ({ path: target.path, os: target.os, environment: "native" })),
    ...managed.map((target) => ({ path: target.path, os: "linux", environment: target.environment })),
  ];
  for (const target of targets)
    planChecks(root, allChecks, {
      stage: "ci",
      path: target.path,
      environment: target.environment,
      operatingSystem: target.os,
    });
  for (const check of checks) {
    if (
      check.coverage?.stages.includes("ci") &&
      !targets.some(
        (target) =>
          resolve(root, target.path) === check.directory && coverageApplies(check, "ci", target.os, target.environment),
      )
    )
      throw new Error(`${check.name}: configured CI coverage has no matching matrix target`);
  }
  return {
    native: { include: native },
    environments: { include: managed.filter((target) => target.environment !== "devcontainer") },
    devcontainer: {
      paths: managed.filter((target) => target.environment === "devcontainer").map((target) => target.path),
    },
    compatibility: { include: compatibility },
  };
}
