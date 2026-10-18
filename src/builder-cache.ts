import { inspectBuildkitCache, removeBuildkitCache } from "./buildkit.js";
import { parseDockerBytes } from "./byte-size.js";
import { builderOwner, builderVolumes } from "../scripts/managed-contract.mjs";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { buildCheckout } from "./builds.js";
import { writeAtomic } from "./core.js";
import { ownedPath } from "./paths.js";
import { userDirectory } from "./storage.js";
import { withCacheLocksSync } from "./cache-lock.js";
import { withToolCacheAdmission } from "./tool-cache-lock.js";
import { pruneItem, type CachePruneObserver } from "./cache-prune-progress.js";

const execute = promisify(execFile);

const volumeName = /^workbench-(guix|nix)-([a-f0-9]{24})-(store|state)$/;
interface DockerVolume {
  Name: string;
  CreatedAt: string;
}
interface Ownership {
  checkout: string;
  builder: "guix" | "nix";
  cache: string;
  engine: string;
  volumes: DockerVolume[];
}
export interface BuilderCacheEntry {
  key: string;
  builder: string;
  volumes: string[];
  bytes: number;
  checkout?: string;
  receipt?: string;
  lock?: string;
  identity?: string;
  blockedBy?: string;
}
export interface BuilderCacheReport {
  entries: BuilderCacheEntry[];
  issues: string[];
}
function docker(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
  return result.stdout.trim();
}
function owner(checkout: string): string {
  return builderOwner(checkout);
}
function namespace(checkout: string, builder: string): string {
  return ownedPath(userDirectory("cache"), `offline-builders/${owner(checkout)}/${builder}`);
}
function receiptPath(value: Ownership): string {
  return ownedPath(namespace(value.checkout, value.builder), `volumes/${value.cache}.json`);
}
function names(builder: string, cache: string): string[] {
  return builderVolumes(builder, cache).map(({ name }) => name);
}

/** Register volume identities before attachment; the preparation command already holds this builder's owner lock. */
export function recordBuilderVolumes(root: string, builder: string, cache: string): void {
  if ((builder !== "guix" && builder !== "nix") || !/^[a-f0-9]{24}$/.test(cache))
    throw new Error("Invalid managed builder cache identity");
  const checkout = buildCheckout(root);
  const value: Ownership = {
    checkout,
    builder,
    cache,
    engine: docker(["info", "--format", "{{.ID}}"]),
    volumes: JSON.parse(docker(["volume", "inspect", ...names(builder, cache)])) as DockerVolume[],
  };
  withToolCacheAdmission(() => {
    writeAtomic(
      receiptPath(value),
      JSON.stringify({ ...value, volumes: value.volumes.map(({ Name, CreatedAt }) => ({ Name, CreatedAt })) }) + "\n",
      0o600,
    );
  });
}
function records(): Map<string, { value: Ownership; path: string }> {
  const result = new Map<string, { value: Ownership; path: string }>();
  const base = join(userDirectory("cache"), "offline-builders");
  if (!existsSync(base)) return result;
  for (const project of readdirSync(base).filter((name) => /^[a-f0-9]{64}$/.test(name)))
    for (const builder of ["guix", "nix"]) {
      const directory = ownedPath(base, `${project}/${builder}/volumes`);
      if (!existsSync(directory)) continue;
      for (const file of readdirSync(directory).filter((name) => /^[a-f0-9]{24}\.json$/.test(name))) {
        const path = ownedPath(directory, file);
        const value = JSON.parse(readFileSync(path, "utf8")) as Ownership;
        if (
          typeof value.checkout !== "string" ||
          !isAbsolute(value.checkout) ||
          owner(value.checkout) !== project ||
          value.builder !== builder ||
          value.cache !== file.slice(0, -5) ||
          typeof value.engine !== "string" ||
          !Array.isArray(value.volumes) ||
          value.volumes.length !== names(builder, value.cache).length ||
          value.volumes.some(
            (volume, index) =>
              volume.Name !== names(builder, value.cache)[index] || typeof volume.CreatedAt !== "string",
          )
        )
          throw new Error(`${path}: invalid builder volume ownership`);
        result.set(`${builder}-${value.cache}`, { value, path });
      }
    }
  return result;
}
/** Docker owns volume storage; only matching receipts permit deletion through Workbench. */
export function inspectBuilderCache(checkout?: string): BuilderCacheReport {
  const report = inspectBuildkitCache(checkout);
  const owned = records();
  if (checkout && ![...owned.values()].some(({ value }) => value.checkout === checkout)) return report;
  try {
    const listed = docker(["volume", "ls", "--format", "{{.Name}}", "--filter", "name=^workbench-"])
      .split("\n")
      .filter((name) => volumeName.test(name));
    if (!listed.length) return report;
    const engine = docker(["info", "--format", "{{.ID}}"]);
    const usage = JSON.parse(docker(["system", "df", "-v", "--format", "{{json .Volumes}}"])) as {
      Name: string;
      Size: string;
      Links: string | number;
    }[];
    const volumes = JSON.parse(docker(["volume", "inspect", ...listed])) as DockerVolume[];
    for (const name of listed) {
      const match = volumeName.exec(name);
      if (!match) continue;
      const key = `${match[1] ?? ""}-${match[2] ?? ""}`;
      if (report.entries.some((entry) => entry.key === key)) continue;
      const record = owned.get(key);
      if (checkout && record?.value.checkout !== checkout) continue;
      const members = listed.filter((volume) => volume.startsWith(`workbench-${key}-`));
      const identityMatches =
        record?.value.engine === engine &&
        members.length === record.value.volumes.length &&
        record.value.volumes.every((volume) =>
          volumes.some((actual) => actual.Name === volume.Name && actual.CreatedAt === volume.CreatedAt),
        );
      const lock = record ? namespace(record.value.checkout, record.value.builder) : undefined;
      const referenced = members.some((volume) => Number(usage.find((item) => item.Name === volume)?.Links ?? 0) > 0);
      const blockedBy = !identityMatches
        ? "no matching Workbench ownership receipt"
        : referenced
          ? "attached to a Docker container"
          : lock && existsSync(`${lock}.lock`)
            ? "active or recovery-required preparation lock"
            : undefined;
      report.entries.push({
        key,
        builder: match[1] ?? "",
        volumes: members,
        bytes: members.reduce(
          (total, volume) => total + parseDockerBytes(usage.find((item) => item.Name === volume)?.Size ?? ""),
          0,
        ),
        ...(record
          ? {
              checkout: record.value.checkout,
              receipt: record.path,
              lock: namespace(record.value.checkout, record.value.builder),
              identity: createHash("sha256").update(JSON.stringify(record.value)).digest("hex"),
            }
          : {}),
        ...(blockedBy ? { blockedBy } : {}),
      });
    }
  } catch (error) {
    if (!(error instanceof Error && error.message.includes("ENOENT")))
      report.issues.push(error instanceof Error ? error.message : String(error));
  }
  return report;
}
export async function pruneBuilderCache(report: BuilderCacheReport, progress?: CachePruneObserver): Promise<void> {
  if (!report.entries.length) return;
  await withToolCacheAdmission(() =>
    withCacheLocksSync(
      report.entries
        .map((entry) => {
          if (!entry.lock || !entry.receipt || entry.blockedBy)
            throw new Error(`Builder ${entry.key} is not removable`);
          return entry.lock;
        })
        .filter((lock, index, all) => all.indexOf(lock) === index)
        .sort(),
      async () => {
        const current = inspectBuilderCache();
        if (current.issues.length)
          throw new Error(`Cannot revalidate Docker builder caches: ${current.issues.join("; ")}`);
        for (const entry of report.entries) {
          const actual = current.entries.find((candidate) => candidate.key === entry.key);
          // The lock above is ours; attached containers and changed ownership still forbid deletion.
          if (
            !actual ||
            (actual.blockedBy && actual.blockedBy !== "active or recovery-required preparation lock") ||
            actual.receipt !== entry.receipt ||
            actual.identity !== entry.identity ||
            JSON.stringify(actual.volumes) !== JSON.stringify(entry.volumes)
          )
            throw new Error(`Builder ${entry.key} changed or became active; inspect the cache again`);
        }
        for (const entry of report.entries) {
          await pruneItem(
            `Builders / ${entry.key}`,
            async () => {
              if (entry.builder === "buildkit") await removeBuildkitCache(entry);
              else {
                await execute("docker", ["volume", "rm", ...entry.volumes], { maxBuffer: 16 * 1024 * 1024 });
                if (entry.receipt) rmSync(entry.receipt);
              }
            },
            progress,
          );
        }
      },
    ),
  );
}
