import { dockerBases } from "./syntax.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { developmentRoots, targetCollector, locations } from "./workspace.mjs";
import { MaintenanceKind, MaintenanceProvider, type MaintenanceLocator, type MaintenanceTarget } from "./contract.mjs";
import { record, string, strings } from "../values.mjs";

/** Discover independent version authorities outside the language dependency manifests. */
export function additionalMaintenanceTargets(root: string): MaintenanceTarget[] {
  const targets: MaintenanceTarget[] = [];
  const add = targetCollector(targets);
  const imageTarget = (
    path: string,
    reference: string,
    locator?: Extract<MaintenanceLocator, { kind: "field" }>,
    platform?: string,
  ) => {
    const separator = reference.lastIndexOf("@");
    const name = reference.slice(0, separator),
      current = reference.slice(separator + 1);
    if (separator < 1 || !/^sha256:[a-f0-9]{64}$/.test(current))
      throw new Error(`${path}: image must pin an immutable SHA-256 digest`);
    add({
      kind: MaintenanceKind.Automation,
      provider: MaintenanceProvider.Image,
      path: path,
      name: name,
      current: current,
      ...(locator ? { locator } : {}),
      ...(platform ? { platform } : {}),
    });
  };
  const readJSON = (path: string) => {
    try {
      return record(JSON.parse(readFileSync(join(root, path), "utf8")), `${path}: expected a version authority object`);
    } catch (error) {
      throw new Error(`${path}: cannot read maintenance version authority`, { cause: error });
    }
  };
  const snapshots = (path: string, contents: string) => {
    for (const match of contents.matchAll(/https:\/\/snapshot\.ubuntu\.com\/ubuntu\/(\d{8}T\d{6}Z)\b/g))
      add({
        kind: MaintenanceKind.Environments,
        provider: MaintenanceProvider.Tool,
        path: path,
        name: "apt-snapshot",
        current: string(match[1], `${path}: missing repository snapshot`),
        locator: locations.marker("snapshot"),
      });
  };
  for (const path of [".devcontainer/Dockerfile", ".devcontainer/guix/Dockerfile"])
    if (existsSync(join(root, path))) snapshots(path, readFileSync(join(root, path), "utf8"));

  const bootstrap = "scripts/bootstrap-tools.json";
  if (existsSync(join(root, bootstrap)))
    for (const [name, value] of Object.entries(readJSON(bootstrap))) {
      const current = string(value, `${bootstrap}: ${name} must pin a version string`);
      if (!current.trim()) throw new Error(`${bootstrap}: ${name} must pin a nonempty version`);
      add({
        kind: MaintenanceKind.Toolchains,
        provider: MaintenanceProvider.Tool,
        path: bootstrap,
        name: name,
        current: current,
        locator: locations.field(name),
      });
    }

  const containerTools = "scripts/container-tools/package.json";
  if (existsSync(join(root, containerTools))) {
    const manifest = readJSON(containerTools);
    for (const group of ["dependencies", "devDependencies"])
      for (const [name, value] of Object.entries(record(manifest[group] ?? {}, `${containerTools}: invalid ${group}`)))
        add({
          kind: MaintenanceKind.Toolchains,
          provider: MaintenanceProvider.Npm,
          path: containerTools,
          name: name,
          current: string(value, `${containerTools}: ${name} must pin a version string`),
          locator: locations.group(group),
        });
  }
  const buildkit = "scripts/container-tools/buildkit-image.txt";
  if (existsSync(join(root, buildkit))) {
    const reference = readFileSync(join(root, buildkit), "utf8").trim();
    const version = /^(?:docker\.io\/)?moby\/buildkit:v(\d+\.\d+\.\d+)@sha256:[a-f0-9]{64}$/.exec(reference)?.[1];
    add({
      kind: MaintenanceKind.Toolchains,
      provider: MaintenanceProvider.Tool,
      path: buildkit,
      name: "buildkit",
      current: string(version, `${buildkit}: BuildKit must pin a stable version and image digest`),
      locator: locations.image(reference),
    });
  }

  for (const directory of developmentRoots(root)) {
    const path = (filename: string) => (directory === "." ? filename : `${directory}/${filename}`);
    const lock = path("Gemfile.lock");
    if (existsSync(join(root, lock))) {
      const match = /(?:^|\r?\n)BUNDLED WITH\r?\n[ \t]+(\d+\.\d+\.\d+)\s*$/.exec(
        readFileSync(join(root, lock), "utf8"),
      );
      const version = string(match?.[1], `${lock}: BUNDLED WITH must pin an exact Bundler version`);
      add({
        kind: MaintenanceKind.Toolchains,
        provider: MaintenanceProvider.Tool,
        path: lock,
        name: "bundler",
        current: version,
        locator: locations.marker("BUNDLED WITH"),
      });
    }

    const managedRelease = path("managed-release-check.json");
    if (existsSync(join(root, managedRelease)))
      imageTarget(
        managedRelease,
        string(readJSON(managedRelease).image, `${managedRelease}: missing verification image`),
        locations.field("image"),
      );

    const dockerfile = path("Dockerfile.musl");
    if (existsSync(join(root, dockerfile))) {
      const contents = readFileSync(join(root, dockerfile), "utf8");
      for (const image of dockerBases(contents)) imageTarget(dockerfile, `${image.name}@${image.digest}`);
      snapshots(dockerfile, contents);
    }

    const muslRelease = path("release-musl.json");
    if (existsSync(join(root, muslRelease))) {
      const document = readJSON(muslRelease);
      const revision = string(document.cross_revision, `${muslRelease}: missing cross revision`);
      if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error(`${muslRelease}: cross must pin a complete Git revision`);
      add({
        kind: MaintenanceKind.Toolchains,
        provider: MaintenanceProvider.Tool,
        path: muslRelease,
        name: "cross",
        current: revision,
        locator: locations.field("cross_revision"),
      });
      for (const [name, value] of Object.entries(
        record(document.targets ?? {}, `${muslRelease}: invalid release targets`),
      )) {
        const target = record(value, `${muslRelease}: invalid target ${name}`);
        for (const [index, reference] of strings(
          target.verification_images ?? [],
          `${muslRelease}: invalid verification images`,
        ).entries()) {
          const imageName = reference.split("@")[0]?.split("/").at(-1)?.split(":")[0];
          const platform =
            imageName === "alpine"
              ? string(target.platform, `${muslRelease}: Alpine requires target.platform`)
              : undefined;
          if (platform !== undefined && !["linux-x64", "linux-arm64"].includes(platform))
            throw new Error(`${muslRelease}: unsupported verification platform ${platform}`);
          imageTarget(
            muslRelease,
            reference,
            locations.field("targets", name, "verification_images", String(index)),
            platform,
          );
        }
      }
    }

    const configuration = path("vcpkg-configuration.json");
    if (!existsSync(join(root, configuration))) continue;
    const registry = record(
      readJSON(configuration)["default-registry"] ?? {},
      `${configuration}: invalid default registry`,
    );
    if (registry.kind !== "builtin") continue;
    const baseline = string(registry.baseline, `${configuration}: missing builtin registry baseline`);
    if (!/^[a-f0-9]{40}$/.test(baseline))
      throw new Error(`${configuration}: builtin registry baseline must pin a complete Git revision`);
    add({
      kind: MaintenanceKind.Dependencies,
      provider: MaintenanceProvider.Tool,
      path: configuration,
      name: "vcpkg",
      current: baseline,
      locator: locations.field("default-registry", "baseline"),
    });
  }
  return targets;
}
