import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { satisfies, validRange, gte, valid, parse as parseSemver } from "semver";
import {
  MaintenanceKind,
  MaintenanceProvider,
  requestedVersion,
  type MaintenanceTarget,
  type Release,
} from "./contract.mjs";
import { compareVersions, stableVersion, latestRelease, MaintenanceSources, ReleaseConstraint } from "./sources.mjs";

import { record, records, string, strings } from "../values.mjs";
export class MaintenanceConstraint extends ReleaseConstraint {}
export function revisionTarget(target: MaintenanceTarget): boolean {
  return (
    target.kind === MaintenanceKind.Environments ||
    target.name === "miri" ||
    target.name === "vcpkg" ||
    (target.provider === MaintenanceProvider.Tool && target.name === "cross") ||
    target.provider === MaintenanceProvider.Image
  );
}
export function releaseEligible(target: MaintenanceTarget, release: Release): boolean {
  if (revisionTarget(target)) return true;
  if (target.provider === MaintenanceProvider.Go)
    return valid(release.version) !== null && valid(target.current) !== null && gte(release.version, target.current);
  const current = requestedVersion(target.current);
  if (target.provider === MaintenanceProvider.Npm) {
    const requirement = registryNpmDependency(target).range;
    const updated = requirement.replace(requestedVersion(requirement), release.version);
    if (!validRange(updated) || !satisfies(release.version, updated)) return false;
  }
  if (target.provider === MaintenanceProvider.Python) {
    const updated = target.current.replace(current, release.version);
    // Deliberately support numeric clauses only; PEP 440 markers, wildcards and compatible-release semantics need review.
    for (const clause of updated.split(",")) {
      const match = /^\s*(==|!=|<=|>=|<|>)\s*(\d+(?:\.\d+){0,2})\s*$/.exec(clause);
      if (!match?.[1] || !match[2]) return false;
      const comparison = compareVersions(release.version, match[2]);
      const accepted: Record<string, boolean> = {
        "==": comparison === 0,
        "!=": comparison !== 0,
        "<=": comparison <= 0,
        ">=": comparison >= 0,
        "<": comparison < 0,
        ">": comparison > 0,
      };
      if (!accepted[match[1]]) return false;
    }
  }
  if (
    [MaintenanceProvider.Cargo, MaintenanceProvider.Ruby, MaintenanceProvider.Composer].includes(target.provider) &&
    !/^(?:[~^]|~>)?\s*v?\d+(?:\.\d+)*(?:\+\d+)?$/.test(target.current)
  )
    return false;
  return (
    (target.provider !== MaintenanceProvider.Tool || release.version.split(".")[0] === current.split(".")[0]) &&
    compareVersions(release.version, current) >= 0
  );
}

function registryNpmDependency(target: MaintenanceTarget): { name: string; range: string } {
  let name = target.name,
    range = target.current;
  const alias =
    target.name === "packageManager"
      ? target.current
      : target.current.startsWith("npm:")
        ? target.current.slice(4)
        : undefined;
  if (alias !== undefined) {
    const separator = alias.lastIndexOf("@");
    if (separator <= 0 || separator === alias.length - 1)
      throw new MaintenanceConstraint(`The npm authority requires an explicit registry version: ${target.current}`);
    name = alias.slice(0, separator);
    range = alias.slice(separator + 1);
  }
  if (!/\d+\.\d+/.test(range) || !validRange(range))
    throw new MaintenanceConstraint(
      `Nonregistry or unversioned npm requirements require their own update workflow: ${target.current}`,
    );
  if (target.name === "packageManager" && /\+sha(?:224|256|384|512)\./i.test(range))
    throw new MaintenanceConstraint(
      "The package-manager pin includes integrity data that must be regenerated with its version",
    );
  return { name, range };
}

/** A browser package and its separately verified native executable move together. */
export async function validateMaintenanceRelease(
  root: string,
  target: MaintenanceTarget,
  release: Release,
  sources: MaintenanceSources,
): Promise<void> {
  if (
    target.provider === MaintenanceProvider.Tool &&
    target.name === "chromium-headless-shell" &&
    release.version !== target.current
  )
    throw new MaintenanceConstraint(
      "Prepare and review the complete native browser recipes before changing its pin; generic GitHub artifact cloning cannot verify Chrome for Testing archives",
    );
  if (
    target.provider !== MaintenanceProvider.Npm ||
    target.path !== "package.json" ||
    registryNpmDependency(target).name !== "playwright-core"
  )
    return;
  const tools = join(root, ".tool-versions");
  const pinned = existsSync(tools)
    ? /^chromium-headless-shell\s+(\S+)/m.exec(readFileSync(tools, "utf8"))?.[1]
    : undefined;
  const paired = await sources.playwrightBrowser(release.version);
  if (!pinned || paired.version !== pinned)
    throw new MaintenanceConstraint(
      `Playwright ${release.version} requires Chromium ${paired.version}; prepare and review its all-platform native recipes and align the browser pin before updating Playwright`,
    );
}

/** One authority for feeds; version authorities remain in the existing project manifests. */
export function developmentDiscovery(sources = new MaintenanceSources(), root = process.cwd()) {
  const github: Record<string, [string, string]> = {
    cmake: ["Kitware/CMake", "v"],
    ninja: ["ninja-build/ninja", "v"],
    uv: ["astral-sh/uv", ""],
    shfmt: ["mvdan/sh", "v"],
    shellcheck: ["koalaman/shellcheck", "v"],
    actionlint: ["rhysd/actionlint", "v"],
    "cargo-nextest": ["nextest-rs/nextest", "cargo-nextest-"],
    "cargo-llvm-cov": ["taiki-e/cargo-llvm-cov", "v"],
    maven: ["apache/maven", "maven-"],
    composer: ["composer/composer", ""],
    xdebug: ["xdebug/xdebug", ""],
    llvm: ["llvm/llvm-project", "llvmorg-"],
    clang: ["llvm/llvm-project", "llvmorg-"],
  };
  const adapters: { [P in MaintenanceProvider]: (target: MaintenanceTarget & { provider: P }) => Promise<Release[]> } =
    {
      [MaintenanceProvider.Npm]: async (target) => {
        const dependency = registryNpmDependency(target);
        const versions = await sources.npm(
          dependency.name,
          target.name === "@types/node" ? requestedVersion(target.current).split(".")[0] : undefined,
        );
        return versions;
      },
      [MaintenanceProvider.Python]: (target) => sources.pypi(target.name),
      [MaintenanceProvider.Ruby]: (target) => sources.gem(target.name),
      [MaintenanceProvider.Composer]: async (target) => {
        const manifest = record(JSON.parse(readFileSync(join(root, target.path), "utf8")), "Invalid Composer manifest");
        const platform = record(
          record(manifest.config ?? {}, "Invalid Composer configuration").platform ?? {},
          "Invalid Composer platform",
        );
        return sources.composer(
          target.name,
          typeof platform.php === "string" ? platform.php : undefined,
          requestedVersion(target.current),
        );
      },
      [MaintenanceProvider.Maven]: async (target) => {
        const [group, artifact] = target.name.split(":");
        if (!group || !artifact) throw new Error("Invalid Maven coordinates");
        const versions = await sources.maven(group, artifact);
        if (target.current.endsWith("-jre") || target.current.endsWith("-android"))
          return versions.filter((version) =>
            version.version.endsWith(target.current.endsWith("-jre") ? "-jre" : "-android"),
          );
        return artifact === "plexus-utils"
          ? versions.filter((version) => version.version.split(".")[0] === target.current.split(".")[0])
          : versions;
      },
      [MaintenanceProvider.Cargo]: async (target) => {
        const url = `https://crates.io/api/v1/crates/${target.name}`;
        const data = record(await sources.json(url), "Invalid crates.io response");
        return records(data.versions, "Missing crate versions").flatMap((entry) => {
          const version = stableVersion(string(entry.num, "Missing crate version"));
          return version && entry.yanked !== true
            ? [
                {
                  version,
                  reference: url,
                  ...(typeof entry.checksum === "string" ? { integrity: `sha256:${entry.checksum}` } : {}),
                },
              ]
            : [];
        });
      },
      [MaintenanceProvider.Go]: async (target) => {
        const escaped = target.name.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
        const url = `https://proxy.golang.org/${escaped}/@v/list`;
        return (await sources.request(url, "text/plain")).split(/\r?\n/).flatMap((line) => {
          const parsed = parseSemver(line);
          const version = parsed && !parsed.prerelease.length ? line.replace(/^v/, "") : undefined;
          return version ? [{ version, reference: url }] : [];
        });
      },
      [MaintenanceProvider.Action]: (target) => sources.github(target.name),
      [MaintenanceProvider.Image]: (target) => sources.docker(target.name, target.platform),
      [MaintenanceProvider.Nix]: async (target) => {
        const repository = target.locator.repository;
        const reference = target.locator.reference;
        const branch = reference.value;
        if (!repository || !branch) throw new Error("Missing flake branch authority");
        if (reference.kind === "revision")
          throw new MaintenanceConstraint(
            "This flake uses a fixed source revision; review its compatibility exception before selecting a replacement source",
          );
        return sources.branch(repository, branch);
      },
      [MaintenanceProvider.Guix]: async () => {
        const url = "https://codeberg.org/api/v1/repos/guix/guix/branches/master";
        const data = record(record(await sources.json(url), "Invalid Guix branch").commit, "Missing Guix commit");
        return [{ version: string(data.id, "Missing Guix revision"), reference: url }];
      },
      [MaintenanceProvider.Tool]: async (target) => {
        if (target.name === "apt-snapshot")
          throw new MaintenanceConstraint(
            "An APT snapshot timestamp selects authenticated environment state; explicitly select and verify signed repository metadata and the complete replacement package graph before changing it",
          );
        if (target.name === "cross") return sources.branch("cross-rs/cross", "main");
        if (target.name === "buildkit") {
          const current = requestedVersion(target.current);
          const selected = latestRelease(await sources.github("moby/buildkit"), current, true);
          const image =
            string(
              target.locator?.kind === "image" ? target.locator.reference : undefined,
              "Missing pinned BuildKit image",
            ).split("@")[0] ?? "";
          const separator = image.lastIndexOf(":");
          if (separator < 0) throw new Error("The BuildKit image authority must include an explicit release tag");
          const tag = `${image.slice(0, separator)}:v${selected.version}`;
          const published = (await sources.docker(tag, target.platform))[0];
          return [{ ...selected, revision: string(published?.version, "Missing published BuildKit image digest") }];
        }
        if (target.name === "node") return sources.node();
        if (target.name === "python") return sources.python();
        if (target.name === "go") return sources.go();
        if (target.name === "ruby") return sources.ruby();
        if (target.name === "bundler") return sources.gem("bundler");
        if (target.name === "php") return sources.php();
        if (target.name === "rust") return sources.rust();
        if (target.name === "miri") {
          const configuration = parseToml(readFileSync(join(root, "workbench/config.toml"), "utf8"));
          const ci = record(configuration.ci ?? {}, "Invalid CI configuration");
          const architectures = record(ci.architectures ?? {}, "Missing CI architectures");
          const triples: Record<string, string> = {
            x64: "x86_64-unknown-linux-gnu",
            arm64: "aarch64-unknown-linux-gnu",
          };
          const targets = strings(architectures.linux, "Declare the Linux CI architectures before updating Miri").map(
            (architecture) => {
              const triple = triples[architecture];
              if (!triple) throw new MaintenanceConstraint(`No Miri availability adapter for Linux ${architecture}`);
              return triple;
            },
          );
          return sources.rust("nightly", targets);
        }
        if (target.name === "gcc") return sources.gcc();
        if (target.name === "mvsc" || target.name === "sdk")
          throw new MaintenanceConstraint(
            `The pin ${target.current} names an installed Windows component directory; servicing retains that layout and Workbench fingerprints its contents. Review servicing on Windows: ${target.name === "mvsc" ? "https://learn.microsoft.com/en-us/visualstudio/releases/2022/release-history" : "https://learn.microsoft.com/en-us/windows/apps/windows-sdk/downloads"}`,
          );
        if (target.name === "rustup-init") return sources.rustup();
        if (target.name === "vcpkg") return sources.branch("microsoft/vcpkg", "master");
        if (target.name === "chromium-headless-shell") {
          const manifest = record(
            JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
            "Invalid package manifest",
          );
          const version = requestedVersion(
            string(
              record(manifest.devDependencies, "Missing browser dependencies")["playwright-core"],
              "Missing Playwright version",
            ),
          );
          const browser = await sources.playwrightBrowser(version);
          await validateMaintenanceRelease(root, target, browser, sources);
          return [browser];
        }
        if (target.name === "java")
          return sources.github(`adoptium/temurin${target.current.split(".")[0] ?? ""}-binaries`, "jdk-", 10);
        const provider = github[target.name];
        if (provider) return sources.github(...provider);
        throw new Error(`No release adapter for ${target.name}; the version was not assumed current`);
      },
    };
  return Object.assign(
    (target: MaintenanceTarget) => {
      // The discriminant selects the matching typed handler in this exhaustive registry.
      const adapter = adapters[target.provider] as (target: MaintenanceTarget) => Promise<Release[]>;
      return adapter(target);
    },
    { sources },
  );
}
