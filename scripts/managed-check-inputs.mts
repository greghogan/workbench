import { required, record, records, string, strings, stringRecord } from "./values.mjs";
import type { ManagedSource } from "./managed-source-contract.mjs";
export interface PackagePlatform {
  os?: string[];
  cpu?: string[];
  libc?: string[];
}
export interface NpmLockedPackage extends PackagePlatform {
  resolution?: { tarball?: string; integrity?: string };
}
export interface NpmLock {
  packages?: Record<string, NpmLockedPackage>;
}
export interface BootstrapPackage extends PackagePlatform {
  version: string;
  resolved: string;
  integrity: string;
}
export interface ManagedBootstrap {
  schema_version: number;
  package_json: unknown;
  package_lock: { packages: Record<string, BootstrapPackage> };
  proofs: unknown[];
}
import type { BinaryLike } from "crypto";
import { managedSource, managedDeclaration } from "./managed-source-contract.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { pnpmPackages, pnpmIdentity } from "./pnpm-lock.mjs";

function packagePlatform(value: Record<string, unknown>): PackagePlatform {
  return Object.fromEntries(
    ["os", "cpu", "libc"].flatMap((key) =>
      value[key] === undefined ? [] : [[key, strings(value[key], "Invalid package platform")]],
    ),
  );
}

export function readNpmLock(value: unknown): NpmLock {
  const document = record(value, "Invalid npm lock document");
  return {
    packages: Object.fromEntries(
      Object.entries(record(document.packages ?? {}, "Invalid npm lock packages")).map(([name, raw]) => {
        const entry = record(raw, "Invalid npm lock package");
        const resolution =
          entry.resolution === undefined ? undefined : record(entry.resolution, "Invalid package resolution");
        return [
          name,
          {
            ...packagePlatform(entry),
            ...(resolution
              ? {
                  resolution: {
                    ...(resolution.tarball === undefined
                      ? {}
                      : { tarball: string(resolution.tarball, "Invalid package tarball") }),
                    ...(resolution.integrity === undefined
                      ? {}
                      : { integrity: string(resolution.integrity, "Invalid package integrity") }),
                  },
                }
              : {}),
          },
        ];
      }),
    ),
  };
}

const sha256 = (bytes: BinaryLike) => createHash("sha256").update(bytes).digest("hex");
const sri = (hex: string) => `sha256-${Buffer.from(hex, "hex").toString("base64")}`;
const text = (root: string, name: string) => readFileSync(join(root, name), "utf8");

function artifact(url: string, hash: unknown, destination: string, platforms?: string[]) {
  return managedSource({ url, hash, destination, ...(platforms ? { platforms } : {}) });
}

function platforms(entry: PackagePlatform) {
  const accepts = (values: string[] | undefined, selected: string) =>
    !values ||
    (!values.includes(`!${selected}`) &&
      (!values.some((value: string) => !value.startsWith("!")) || values.includes(selected)));
  return ["x64", "arm64"]
    .filter((arch) => accepts(entry.os, "linux") && accepts(entry.cpu, arch) && accepts(entry.libc, "glibc"))
    .map((arch) => `linux-${arch}`);
}

export function npmCheckInputs(root: string) {
  const packages = readNpmLock({ packages: pnpmPackages(text(root, "pnpm-lock.yaml")) }).packages ?? {};
  return Object.entries(packages).flatMap(([key, entry]) => {
    const selected = platforms(entry);
    if (!selected.length) return [];
    const { name, version } = pnpmIdentity(key);
    if (!/^[A-Za-z0-9.+_-]+$/.test(version) || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name))
      throw new Error(`Unsupported locked npm source: ${key}`);
    const url =
      entry.resolution?.tarball ??
      `https://registry.npmjs.org/${name}/-/${String(name.split("/").at(-1))}-${version}.tgz`;
    return [artifact(url, entry.resolution?.integrity, `npm/${name.replaceAll("/", "-")}-${version}.tgz`, selected)];
  });
}

export function mavenCheckInputs(root: string) {
  return text(root, ".mvn/checksums/checksums.sha256")
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9._+/-]+)$/.exec(line);
      if (!match) throw new Error("Invalid locked Maven checksum");
      return artifact(
        `https://maven-central.storage-download.googleapis.com/maven2/${String(match[2])}`,
        sri(required(match[1], "Missing Maven checksum")),
        `maven/${String(match[2])}`,
      );
    });
}

export function rubyCheckInputs(root: string) {
  const lock = text(root, "Gemfile.lock");
  const section = /(?:^|\n)CHECKSUMS\n([\s\S]*?)(?=\n[A-Z]|$)/.exec(lock)?.[1];
  if (!section) throw new Error("Managed gems require the lock's CHECKSUMS section");
  return [...section.matchAll(/^ {2}([A-Za-z0-9._-]+) \(([^)]+)\) sha256=([a-f0-9]{64})$/gm)].flatMap((match) => {
    const version = required(match[2], "Missing gem version"),
      platform = version.replace(/^[0-9]+(?:\.[0-9]+)*(?:\.pre\.[0-9]+)?/, "");
    const selected = !platform
      ? ["linux-x64", "linux-arm64"]
      : platform === "-x86_64-linux-gnu"
        ? ["linux-x64"]
        : platform === "-aarch64-linux-gnu"
          ? ["linux-arm64"]
          : [];
    if (!selected.length) return [];
    const name = `${String(match[1])}-${version}.gem`;
    return [
      artifact(
        `https://rubygems.org/downloads/${name}`,
        sri(required(match[3], "Missing gem checksum")),
        `gems/${name}`,
        selected,
      ),
    ];
  });
}

export function cargoCheckInputs(root: string) {
  const lock = parseToml(text(root, "Cargo.lock"));
  return records(lock.package, "Invalid Cargo lock packages")
    .filter((entry) => entry.source)
    .map((entry) => {
      if (
        entry.source !== "registry+https://github.com/rust-lang/crates.io-index" ||
        typeof entry.checksum !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.checksum)
      )
        throw new Error(`Unsupported locked Cargo source: ${String(entry.name)}`);
      const crate = string(entry.name, "Missing crate name"),
        version = string(entry.version, "Missing crate version");
      const name = `${crate}-${version}.crate`;
      return artifact(`https://static.crates.io/crates/${crate}/${name}`, sri(entry.checksum), `cargo/${name}`);
    });
}

export function pythonCheckInputs(root: string) {
  const lock = parseToml(text(root, "uv.lock"));
  return records(lock.package, "Invalid Python lock packages").flatMap((entry) =>
    [
      ...(entry.sdist === undefined ? [] : [record(entry.sdist, "Invalid source distribution")]),
      ...records(entry.wheels ?? [], "Invalid locked wheels"),
    ].flatMap((value) => {
      const file = {
        url: string(value.url, "Invalid Python artifact URL"),
        hash: string(value.hash, "Invalid Python artifact hash"),
      };
      const name = basename(new URL(file.url).pathname);
      const selected =
        !name.endsWith(".whl") || name.endsWith("-any.whl")
          ? ["linux-x64", "linux-arm64"]
          : ["x64", "arm64"]
              .filter((arch) => new RegExp(`manylinux[^/]*${arch === "x64" ? "x86_64" : "aarch64"}`).test(name))
              .map((arch) => `linux-${arch}`);
      if (!selected.length) return [];
      if (!/^sha256:[a-f0-9]{64}$/.test(file.hash)) throw new Error(`Invalid locked Python integrity: ${name}`);
      return [artifact(file.url, sri(file.hash.slice(7)), `python/${name}`, selected)];
    }),
  );
}

export function composerCheckInputs(root: string) {
  return [".", "tools", "tools/compat"].flatMap((directory) => {
    const base = join(root, directory);
    if (!existsSync(join(base, "composer.lock"))) return [];
    const lock = record(JSON.parse(text(base, "composer.lock")), "Invalid Composer lock");
    const checksums = stringRecord(JSON.parse(text(base, ".composer/checksums.json")), "Invalid Composer checksums");
    return [
      ...records(lock.packages, "Invalid Composer packages"),
      ...records(lock["packages-dev"], "Invalid Composer dev packages"),
    ]
      .map((entry) => ({ entry, dist: record(entry.dist, "Missing Composer distribution") }))
      .filter(({ dist }) => dist.type !== "path")
      .map(({ entry, dist }) => ({
        name: string(entry.name, "Missing Composer package name"),
        version: string(entry.version, "Missing Composer package version"),
        dist,
      }))
      .map((entry) => {
        const reference =
          entry.dist.reference === undefined || entry.dist.reference === null
            ? ""
            : string(entry.dist.reference, "Invalid distribution reference");
        const key = `${entry.name}@${entry.version}#${reference}`;
        const digest = checksums[key];
        if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Missing reviewed Composer integrity: ${key}`);
        return artifact(
          string(entry.dist.url, "Invalid Composer URL"),
          sri(digest),
          `composer/${directory === "." ? "application" : directory}/${entry.name}/${digest}.zip`,
        );
      });
  });
}

/** A builder consumes exactly these source bytes; dependency resolution stays in the language's lock. */
export function managedCheckInputs(root: string) {
  const inputs: ManagedSource[] = [];
  const sourceHashes: Record<string, string> = {};
  for (const [file, generate, sources] of [
    ["pnpm-lock.yaml", npmCheckInputs, ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".pnpmfile.cjs"]],
    ["Cargo.lock", cargoCheckInputs, ["Cargo.toml", "Cargo.lock"]],
    ["uv.lock", pythonCheckInputs, ["pyproject.toml", "uv.lock"]],
    ["Gemfile.lock", rubyCheckInputs, ["Gemfile", "Gemfile.lock"]],
    [".mvn/checksums/checksums.sha256", mavenCheckInputs, ["pom.xml", ".mvn/checksums/checksums.sha256"]],
    [
      "composer.lock",
      composerCheckInputs,
      [
        "composer.json",
        "composer.lock",
        ".composer/checksums.json",
        "tools/composer.json",
        "tools/composer.lock",
        "tools/.composer/checksums.json",
        "tools/compat/composer.json",
        "tools/compat/composer.lock",
        "tools/compat/.composer/checksums.json",
      ],
    ],
  ] as const) {
    if (!existsSync(join(root, file))) continue;
    inputs.push(...generate(root));
    for (const source of sources)
      if (existsSync(join(root, source))) sourceHashes[source] = sha256(readFileSync(join(root, source)));
  }
  const extraFile = join(root, "managed-extra-inputs.json");
  if (existsSync(extraFile)) {
    const extra = managedDeclaration(JSON.parse(readFileSync(extraFile, "utf8")));
    sourceHashes["managed-extra-inputs.json"] = sha256(readFileSync(extraFile));
    if (extra.schema_version !== 1) throw new Error("Unknown managed extra-input schema");
    for (const [file, expected] of Object.entries(extra.source_hashes)) {
      if (
        !file ||
        file.startsWith("/") ||
        file.includes("\\") ||
        file.split("/").some((part) => !part || part === ".." || part === ".")
      )
        throw new Error("Unsafe supplemental source path");
      if (sha256(readFileSync(join(root, file))) !== expected)
        throw new Error(`${file}: refresh derived managed inputs`);
      sourceHashes[file] = expected;
    }
    inputs.push(...extra.inputs.map((entry) => artifact(entry.url, entry.hash, entry.destination, entry.platforms)));
  }
  const bootstrapFile = join(root, "managed-bootstrap.json");
  const registryFile = join(root, "managed-registry.json.br");
  const registry = existsSync(registryFile);
  if (registry) sourceHashes["managed-registry.json.br"] = sha256(readFileSync(registryFile));
  const bootstrap = existsSync(bootstrapFile)
    ? record(JSON.parse(readFileSync(bootstrapFile, "utf8")), "Invalid managed bootstrap")
    : undefined;
  if (bootstrap) {
    if (bootstrap.schema_version !== 1) throw new Error("Unknown managed bootstrap schema");
    sourceHashes["managed-bootstrap.json"] = sha256(readFileSync(bootstrapFile));
    for (const [path, entry] of Object.entries(
      record(record(bootstrap.package_lock, "Invalid bootstrap lock").packages, "Invalid bootstrap packages"),
    )) {
      if (!path) continue;
      const value = record(entry, "Invalid bootstrap package");
      const selected = platforms(packagePlatform(value));
      if (selected.length)
        inputs.push(
          artifact(
            string(value.resolved, "Invalid bootstrap URL"),
            value.integrity,
            `bootstrap/${path.replaceAll("/", "-")}.tgz`,
            selected,
          ),
        );
    }
  }
  const destinations = new Map<string, ManagedSource>();
  for (const entry of inputs) {
    const previous = destinations.get(entry.destination);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
      throw new Error(`Conflicting managed input: ${entry.destination}`);
    destinations.set(entry.destination, entry);
  }
  return managedDeclaration({
    schema_version: 1,
    source_hashes: Object.fromEntries(Object.entries(sourceHashes).sort()),
    ...(bootstrap ? { bootstrap: true } : {}),
    ...(registry ? { registry: true } : {}),
    inputs: [...destinations.values()].sort((a, b) =>
      a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0,
    ),
  });
}
