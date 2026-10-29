import { basename } from "node:path";
import { ReleaseConstraint, type Release } from "./contract.mjs";
import { record, records, required, string } from "../values.mjs";
import type { MaintenanceSources } from "./sources.mjs";

const windowsCatalog = "https://downloads.php.net/~windows/releases/releases.json";
interface PHPPackageVersion {
  runtime: string;
  revision: number;
}
export interface PHPWindowsPackage extends PHPPackageVersion {
  filename: string;
  compiler: string;
  architecture: "x64";
}
function packageVersion(value: string): PHPPackageVersion {
  const match = required(/^(\d+\.\d+\.\d+)(?:-([1-9]\d*))?$/.exec(value), "Invalid Windows PHP package version");
  const revision = Number(match[2] ?? "0");
  if (!Number.isSafeInteger(revision)) throw new Error("Invalid Windows PHP package revision");
  return { runtime: required(match[1], "Missing PHP runtime version"), revision };
}
export function parsePHPWindowsPackage(filename: string): PHPWindowsPackage {
  const match = required(
    /^php-(.+)-nts-Win32-(vs\d+)-x64\.zip$/.exec(filename),
    "Unsupported Windows PHP package variant",
  );
  return {
    ...packageVersion(required(match[1], "Missing Windows PHP package version")),
    filename,
    compiler: required(match[2], "Missing Windows PHP compiler variant"),
    architecture: "x64",
  };
}
function digest(value: unknown): string {
  const hash = string(value, "Missing PHP SHA-256");
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid PHP SHA-256");
  return hash;
}
/** The release feed must supply complete identities; version-only responses cannot establish usable artifacts. */
export function decodePHPReleases(value: unknown, reference: string): Release[] {
  const release = record(value, "Invalid PHP release index");
  const version = string(release.version, "Missing stable PHP release");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Missing stable PHP release");
  const names = new Set<string>();
  const assets = records(release.source, "Missing PHP source archives").map((archive) => {
    const name = string(archive.filename, "Missing PHP archive filename");
    if (!["gz", "bz2", "xz"].some((extension) => name === `php-${version}.tar.${extension}`))
      throw new Error("Invalid PHP source archive filename");
    if (names.has(name)) throw new Error(`Ambiguous published PHP artifact: ${name}`);
    names.add(name);
    return { name, url: `https://www.php.net/distributions/${name}`, sha256: digest(archive.sha256) };
  });
  if (!assets.length) throw new Error("Missing PHP source archives");
  return [{ version, reference, assets }];
}
/** Windows rebuild revisions are independent of runtime versions and retain the selected compiler/architecture. */
export function decodePHPWindowsArchive(value: unknown, version: string, previous: PHPWindowsPackage) {
  const catalog = record(value, "Invalid Windows PHP release catalog");
  const series = version.split(".").slice(0, 2).join(".");
  const release = record(catalog[series], `Windows PHP ${series} is unavailable`);
  const publishedVersion = string(release.version, "Missing Windows PHP package version");
  const selected = packageVersion(publishedVersion);
  if (selected.runtime !== version)
    throw new ReleaseConstraint(
      `Windows PHP ${publishedVersion} does not provide runtime ${version}; retain the current pin`,
    );
  if (previous.runtime === version && selected.revision < previous.revision)
    throw new ReleaseConstraint(
      `Windows PHP ${publishedVersion} is older than the pinned package; no downgrade selected`,
    );
  const variant = `nts-${previous.compiler}-${previous.architecture}`;
  const build = record(release[variant], `Windows PHP ${publishedVersion} has no ${variant} package`);
  const archive = record(build.zip, "Missing Windows PHP ZIP archive");
  const filename = string(archive.path, "Missing Windows PHP archive filename");
  if (filename !== `php-${publishedVersion}-nts-Win32-${previous.compiler}-${previous.architecture}.zip`)
    throw new Error("Windows PHP archive does not match its published runtime and platform");
  if (
    [release, build, archive].some((value) =>
      Object.keys(value).some((key) => /signature|attestation|sigstore/i.test(key)),
    )
  )
    throw new Error(
      "Windows PHP publishes authentication evidence; configure and verify it before selecting this archive",
    );
  return { ...parsePHPWindowsPackage(filename), sha256: digest(archive.sha256), source: windowsCatalog };
}
export async function phpWindowsArchive(version: string, previousURL: string, sources: MaintenanceSources) {
  const previous = parsePHPWindowsPackage(basename(new URL(previousURL).pathname));
  return decodePHPWindowsArchive(await sources.json(windowsCatalog), version, previous);
}
