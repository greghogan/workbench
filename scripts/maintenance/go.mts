import { gte, parse as parseSemver } from "semver";
import type { MaintenanceTarget, Release } from "./contract.mjs";
import type { MaintenanceSources } from "./sources.mjs";
import { record, string } from "../values.mjs";

/** Preserve canonical Go spelling, including +incompatible and pseudo-version revisions. */
function version(value: string): string {
  const parsed = parseSemver(value);
  if (
    !value.startsWith("v") ||
    value !== value.trim() ||
    !parsed ||
    (parsed.build.length && parsed.build.join(".") !== "incompatible")
  )
    throw new Error(`Invalid Go module version: ${value}`);
  return value.slice(1);
}

function candidate(value: string): boolean {
  const parsed = parseSemver(value);
  if (!parsed) return false;
  if (!parsed.prerelease.length) return true;
  const pseudo =
    /^(?:\d+\.0\.0-\d{14}|\d+\.\d+\.\d+-(?:0|[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*\.0)\.\d{14})-[a-f0-9]{12}(?:\+incompatible)?$/;
  if (!pseudo.test(value)) return false;
  const stamp = /(?:-|\.)(\d{14})-[a-f0-9]{12}/.exec(value)?.[1];
  if (!stamp) return false;
  const date = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}Z`;
  return Number.isFinite(Date.parse(date)) && new Date(date).toISOString() === date.replace("Z", ".000Z");
}

/** Follow the proxy's tagged-version query with its documented latest-version fallback. */
export async function discoverGoModules(target: MaintenanceTarget, sources: MaintenanceSources): Promise<Release[]> {
  const current = version(target.current);
  const escaped = target.name.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
  const base = `https://proxy.golang.org/${escaped}`;
  const url = `${base}/@v/list`;
  const releases = (await sources.request(url, "text/plain"))
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((raw) => {
      const value = version(raw);
      return !parseSemver(value)?.prerelease.length ? [{ version: value, reference: url }] : [];
    });
  if (!releases.some((release) => gte(release.version, current))) {
    const latest = `${base}/@latest`;
    const value = version(
      string(record(await sources.json(latest), "Invalid Go module metadata").Version, "Missing Go module version"),
    );
    if (candidate(value)) releases.push({ version: value, reference: latest });
  }
  if (!releases.some((release) => gte(release.version, current))) {
    const info = `${base}/@v/${encodeURIComponent(target.current)}.info`;
    const value = string(
      record(await sources.json(info), "Invalid pinned Go module metadata").Version,
      "Missing pinned Go module version",
    );
    if (value !== target.current) throw new Error("Go proxy metadata does not match the pinned version");
    releases.push({ version: current, reference: info });
  }
  return releases;
}
