import { mavenVersions, dockerBases, actionPins, goModules, guixCommit } from "./syntax.mjs";
import {
  MaintenanceKind,
  MaintenanceState,
  MaintenanceProvider,
  declaredVersion,
  type MaintenanceTarget,
  type MaintenanceEntry,
  type MaintenancePlan,
  type Release,
} from "./contract.mjs";
import { fileDigest, developmentRoots, targetCollector, locations } from "./workspace.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { compareVersions, latestRelease, MaintenanceSources, ReleaseConstraint } from "./sources.mjs";

import { revisionTarget, releaseEligible, validateMaintenanceRelease } from "./adapters.mjs";
export { revisionTarget, releaseEligible, validateMaintenanceRelease, developmentDiscovery } from "./adapters.mjs";
import { bindPublication } from "./publication.mjs";
import { additionalMaintenanceTargets } from "./inventory.mjs";
import { errorFrom, isRecord, record, records, string, strings } from "../values.mjs";

export { MaintenanceConstraint } from "./adapters.mjs";

export { fileDigest, developmentRoots } from "./workspace.mjs";
export function maintenanceTargets(root: string): MaintenanceTarget[] {
  const result: MaintenanceTarget[] = [];
  const add = targetCollector(result);
  for (const directory of developmentRoots(root)) {
    const path = (name: string) => (directory === "." ? name : `${directory}/${name}`);
    if (existsSync(join(root, path("package.json")))) {
      const manifest = record(
        JSON.parse(readFileSync(join(root, path("package.json")), "utf8")),
        "Invalid npm manifest",
      );
      for (const group of ["dependencies", "devDependencies"])
        for (const [name, raw] of Object.entries(record(manifest[group] ?? {}, "Invalid npm dependencies")))
          add({
            kind: MaintenanceKind.Dependencies,
            provider: MaintenanceProvider.Npm,
            path: path("package.json"),
            name: name,
            current: string(raw, "Invalid npm requirement"),
            locator: locations.group(group),
          });
      if (typeof manifest.packageManager === "string")
        add({
          kind: MaintenanceKind.Toolchains,
          provider: MaintenanceProvider.Npm,
          path: path("package.json"),
          name: "packageManager",
          current: manifest.packageManager,
        });
    }
    if (existsSync(join(root, path("pyproject.toml")))) {
      const manifest = parseToml(readFileSync(join(root, path("pyproject.toml")), "utf8"));
      const groups = record(manifest["dependency-groups"] ?? {}, "Invalid Python dependency groups");
      for (const [group, entries] of Object.entries(groups))
        for (const entry of strings(entries, "Invalid Python dependency group")) {
          const match = /^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*([<>=!~].*)$/.exec(entry);
          if (match?.[1] && match[2])
            add({
              kind: MaintenanceKind.Dependencies,
              provider: MaintenanceProvider.Python,
              path: path("pyproject.toml"),
              name: match[1],
              current: match[2],
              locator: locations.group(group),
            });
        }
      const build = record(manifest["build-system"] ?? {}, "Invalid Python build system");
      for (const entry of strings(build.requires ?? [], "Invalid Python build requirements")) {
        const match = /^([A-Za-z0-9_.-]+)==(.+)$/.exec(entry);
        if (match?.[1] && match[2])
          add({
            kind: MaintenanceKind.Dependencies,
            provider: MaintenanceProvider.Python,
            path: path("pyproject.toml"),
            name: match[1],
            current: `==${match[2]}`,
            locator: locations.group("build-system"),
          });
      }
    }
    if (existsSync(join(root, path("Cargo.toml")))) {
      const manifest = parseToml(readFileSync(join(root, path("Cargo.toml")), "utf8"));
      for (const group of ["dependencies", "dev-dependencies", "build-dependencies"])
        for (const [name, value] of Object.entries(record(manifest[group] ?? {}, "Invalid Cargo dependencies"))) {
          const version =
            typeof value === "string"
              ? value
              : isRecord(value) && typeof value.version === "string"
                ? value.version
                : undefined;
          if (version)
            add({
              kind: MaintenanceKind.Dependencies,
              provider: MaintenanceProvider.Cargo,
              path: path("Cargo.toml"),
              name: name,
              current: version,
              locator: locations.group(group),
            });
        }
    }
    if (existsSync(join(root, path("Gemfile"))))
      for (const match of readFileSync(join(root, path("Gemfile")), "utf8").matchAll(/^gem\s+"([^"]+)",\s*"([^"]+)"/gm))
        if (match[1] && match[2])
          add({
            kind: MaintenanceKind.Dependencies,
            provider: MaintenanceProvider.Ruby,
            path: path("Gemfile"),
            name: match[1],
            current: match[2],
          });
    for (const name of ["composer.json", "tools/composer.json", "tools/compat/composer.json"])
      if (existsSync(join(root, path(name)))) {
        const manifest = record(JSON.parse(readFileSync(join(root, path(name)), "utf8")), "Invalid Composer manifest");
        for (const group of ["require", "require-dev"])
          for (const [packageName, value] of Object.entries(
            record(manifest[group] ?? {}, "Invalid Composer dependencies"),
          ))
            if (packageName.includes("/") && !packageName.startsWith("workbench/"))
              add({
                kind: MaintenanceKind.Dependencies,
                provider: MaintenanceProvider.Composer,
                path: path(name),
                name: packageName,
                current: string(value, "Invalid Composer requirement"),
                locator: locations.group(group),
              });
      }
    if (existsSync(join(root, path("go.mod"))))
      for (const token of goModules(readFileSync(join(root, path("go.mod")), "utf8")))
        add({
          kind: MaintenanceKind.Dependencies,
          provider: MaintenanceProvider.Go,
          path: path("go.mod"),
          name: token.name,
          current: token.current,
        });
    if (existsSync(join(root, path("pom.xml"))))
      for (const token of mavenVersions(readFileSync(join(root, path("pom.xml")), "utf8")))
        add({
          kind: MaintenanceKind.Dependencies,
          provider: MaintenanceProvider.Maven,
          path: path("pom.xml"),
          name: token.name,
          current: token.current,
          ...(token.property ? { locator: locations.property(token.property) } : {}),
        });
    for (const [name, filename] of Object.entries({
      node: ".node-version",
      python: ".python-version",
      go: ".go-version",
      java: ".java-version",
      ruby: ".ruby-version",
      php: ".php-version",
      llvm: ".llvm-version",
      gcc: ".gcc-version",
      mvsc: ".mvsc-version",
      sdk: ".windows-sdk-version",
      vcpkg: ".vcpkg-version",
      composer: ".composer-version",
      xdebug: ".xdebug-version",
    }))
      if (existsSync(join(root, path(filename))))
        add({
          kind: MaintenanceKind.Toolchains,
          provider: MaintenanceProvider.Tool,
          path: path(filename),
          name: name,
          current: readFileSync(join(root, path(filename)), "utf8").trim(),
        });
    if (existsSync(join(root, path(".tool-versions"))))
      for (const line of readFileSync(join(root, path(".tool-versions")), "utf8").split("\n")) {
        const match = /^([a-z][\w-]*)\s+(\S+)(?:\s|$)/.exec(line);
        if (match?.[1] && match[2])
          add({
            kind: MaintenanceKind.Toolchains,
            provider: MaintenanceProvider.Tool,
            path: path(".tool-versions"),
            name: match[1],
            current: match[2],
          });
      }
    for (const filename of ["rust-toolchain.toml", "rust-toolchain-miri.toml"])
      if (existsSync(join(root, path(filename)))) {
        const data = parseToml(readFileSync(join(root, path(filename)), "utf8"));
        const channel = string(record(data.toolchain, "Missing Rust toolchain").channel, "Missing Rust channel");
        add({
          kind: MaintenanceKind.Toolchains,
          provider: MaintenanceProvider.Tool,
          path: path(filename),
          name: filename.includes("miri") ? "miri" : "rust",
          current: channel,
        });
      }
    if (existsSync(join(root, path("flake.lock")))) {
      const data = record(JSON.parse(readFileSync(join(root, path("flake.lock")), "utf8")), "Invalid flake lock");
      const nodes = record(data.nodes, "Missing flake nodes");
      for (const [name, node] of Object.entries(nodes)) {
        const value = record(node, "Invalid flake node");
        if (!value.locked) continue;
        const locked = record(value.locked, "Invalid locked flake input");
        const original = record(value.original, "Missing flake input origin");
        if (original.type === "github")
          add({
            kind: MaintenanceKind.Environments,
            provider: MaintenanceProvider.Nix,
            path: path("flake.lock"),
            name: name,
            current: string(locked.rev, "Missing locked revision"),
            locator: locations.nix(
              `${string(original.owner, "Missing owner")}/${string(original.repo, "Missing repo")}`,
              typeof original.ref === "string" ? original.ref : string(original.rev, "Missing source revision"),
              typeof original.ref !== "string",
            ),
          });
      }
    }
    if (existsSync(join(root, path("channels.scm")))) {
      const text = readFileSync(join(root, path("channels.scm")), "utf8");
      const pin = guixCommit(text);
      add({
        kind: MaintenanceKind.Environments,
        provider: MaintenanceProvider.Guix,
        path: path("channels.scm"),
        name: "guix",
        current: pin.current,
      });
    }
  }
  const configuration = parseToml(readFileSync(join(root, "workbench/config.toml"), "utf8"));
  const nixImage = record(configuration.checks ?? {}, "Invalid checks configuration").nix_docker_image;
  if (typeof nixImage === "string") {
    const [name, current] = nixImage.split("@");
    if (name && current)
      add({
        kind: MaintenanceKind.Environments,
        provider: MaintenanceProvider.Image,
        path: "workbench/config.toml",
        name: name,
        current: current,
        locator: locations.field("checks", "nix_docker_image"),
      });
  }
  for (const path of [".devcontainer/Dockerfile", ".devcontainer/nix/Dockerfile", ".devcontainer/guix/Dockerfile"])
    if (existsSync(join(root, path)))
      for (const image of dockerBases(readFileSync(join(root, path), "utf8")))
        add({
          kind: MaintenanceKind.Automation,
          provider: MaintenanceProvider.Image,
          path: path,
          name: image.name,
          current: image.digest,
        });
  const workflows = join(root, ".github/workflows");
  for (const name of existsSync(workflows)
    ? readdirSync(workflows)
        .filter((name) => /\.ya?ml$/.test(name))
        .sort()
    : []) {
    const path = `.github/workflows/${name}`;
    for (const pin of actionPins(readFileSync(join(root, path), "utf8")))
      add({
        kind: MaintenanceKind.Automation,
        provider: MaintenanceProvider.Action,
        path: path,
        name: pin.name,
        current: pin.version,
        locator: locations.action(pin.revision),
      });
  }
  const toolchains = record(configuration.toolchains ?? {}, "Invalid toolchain configuration");
  for (const [index, profile] of records(toolchains.profiles ?? [], "Invalid toolchain profiles").entries())
    for (const [name, version] of Object.entries(record(profile.tools ?? {}, "Invalid profile tools")))
      add({
        kind: MaintenanceKind.Toolchains,
        provider: MaintenanceProvider.Tool,
        path: "workbench/config.toml",
        name: name,
        current: string(version, "Invalid profile tool version"),
        locator: locations.field("toolchains", "profiles", String(index), "tools", name),
      });
  const projects = parseToml(readFileSync(join(root, "workbench/projects.toml"), "utf8"));
  for (const [index, language] of records(projects.language_root, "Missing language roots").entries())
    for (const [name, compiler] of Object.entries(record(language.compilers ?? {}, "Invalid compiler matrix"))) {
      const pins = record(compiler, "Invalid compiler support");
      if (typeof pins.minimum === "string")
        add({
          kind: MaintenanceKind.Toolchains,
          provider: MaintenanceProvider.Tool,
          path: "workbench/projects.toml",
          name: name,
          current: pins.minimum,
          locator: locations.field("language_root", String(index), "compilers", name, "minimum"),
        });
      for (const [versionIndex, version] of strings(pins.ci_versions ?? [], "Invalid compiler versions").entries())
        add({
          kind: MaintenanceKind.Toolchains,
          provider: MaintenanceProvider.Tool,
          path: "workbench/projects.toml",
          name: name,
          current: version,
          locator: locations.field(
            "language_root",
            String(index),
            "compilers",
            name,
            "ci_versions",
            String(versionIndex),
          ),
        });
    }
  return [...result, ...additionalMaintenanceTargets(root)];
}

export async function discoverMaintenance(
  root: string,
  discover: ((target: MaintenanceTarget) => Promise<Release[]>) & { sources?: MaintenanceSources },
  options: {
    kinds?: MaintenanceKind[];
    now?: Date;
    concurrency?: number;
    signal?: AbortSignal;
    sources?: MaintenanceSources;
  } = {},
): Promise<MaintenancePlan> {
  options.signal?.throwIfAborted();
  const targets = maintenanceTargets(root).filter((target) => !options.kinds || options.kinds.includes(target.kind));
  const concurrency = options.concurrency ?? 6;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error("Maintenance concurrency must be positive");
  const entries: MaintenanceEntry[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(targets.length, concurrency) }, async () => {
    for (;;) {
      options.signal?.throwIfAborted();
      const index = cursor++;
      const target = targets[index];
      if (!target) break;
      try {
        const available = await discover(target);
        options.signal?.throwIfAborted();
        const current = declaredVersion(target);
        const opaque = revisionTarget(target);
        const newest = opaque ? available[0] : latestRelease(available, current);
        const candidates = opaque
          ? available.slice(0, 1)
          : available
              .filter((release) => releaseEligible(target, release))
              .sort((a, b) => compareVersions(b.version, a.version));
        const sources = options.sources ?? discover.sources;
        let selected: Release | undefined, bound: Release | undefined, constraint: string | undefined;
        for (const candidate of candidates) {
          try {
            if (sources) await validateMaintenanceRelease(root, target, candidate, sources);
            bound =
              candidate.version !== current || target.provider === MaintenanceProvider.Action
                ? await bindPublication(root, target, candidate, sources)
                : candidate;
            selected = candidate;
            break;
          } catch (error) {
            if (!(error instanceof ReleaseConstraint)) throw error;
            constraint = error.message;
          }
        }
        if (!selected || !bound) {
          entries[index] = {
            ...target,
            state: MaintenanceState.Constrained,
            ...(newest ? { latest: newest.version } : {}),
            reason:
              constraint ??
              "No published stable release satisfies the declared support or dependency constraints; no downgrade was selected",
          };
          continue;
        }
        const changedImage =
          target.provider === MaintenanceProvider.Tool &&
          target.name === "buildkit" &&
          selected.revision !==
            (target.locator?.kind === "image" ? target.locator.reference.split("@").at(-1) : undefined);
        const changedAction =
          target.provider === MaintenanceProvider.Action && bound.revision !== target.locator.revision;
        const changed = selected.version !== current || changedImage || changedAction;
        const details = {
          ...target,
          selected: bound,
          ...(newest && newest.version !== selected.version
            ? {
                latest: newest.version,
                reason: constraint ?? "A newer release is outside the selected support or dependency constraints",
              }
            : {}),
        };
        entries[index] = changed
          ? { ...details, state: MaintenanceState.Available }
          : { ...details, state: MaintenanceState.Current };
      } catch (error) {
        options.signal?.throwIfAborted();
        entries[index] = {
          ...target,
          state: error instanceof ReleaseConstraint ? MaintenanceState.Constrained : MaintenanceState.Unavailable,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
  });
  // Drain every admitted request before returning cancellation or another worker failure.
  const outcomes = await Promise.allSettled(workers);
  options.signal?.throwIfAborted();
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure) throw errorFrom(failure.reason);
  return {
    schema_version: 2,
    created: (options.now ?? new Date()).toISOString(),
    inputs: maintenanceInputs(root, targets),
    entries,
  };
}

export function maintenanceInputs(root: string, targets: MaintenanceTarget[]): Record<string, string> {
  const inputs = new Set([
    "workbench/projects.toml",
    "workbench/config.toml",
    "scripts/native-assets.json",
    "scripts/llvm-assets.json",
    "scripts/package-manager/package.json",
    "scripts/package-manager/package-lock.json",
    "scripts/container-tools/package-lock.json",
    ...targets.map((entry) => entry.path),
  ]);
  for (const directory of developmentRoots(root))
    for (const filename of [
      "flake.nix",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "uv.lock",
      "Cargo.lock",
      "Gemfile.lock",
      "go.sum",
      "composer.lock",
      "tools/composer.lock",
      "tools/compat/composer.lock",
      ".mvn/checksums/checksums.sha256",
    ])
      inputs.add(directory === "." ? filename : `${directory}/${filename}`);
  return Object.fromEntries(
    [...inputs]
      .filter((path) => existsSync(join(root, path)))
      .sort()
      .map((path) => [path, fileDigest(root, path)]),
  );
}
