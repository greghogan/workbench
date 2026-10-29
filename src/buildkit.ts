import { describeError } from "../scripts/diagnostic-errors.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { dockerQuery } from "./docker-query.js";
import { builderOwner } from "../scripts/managed-contract.mjs";
import { buildCheckout } from "./builds.js";
import { distributionRoot } from "./project-context.js";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { withCacheLock } from "./cache-lock.js";
import { executeCI } from "../scripts/ci-lifecycle.mjs";
import { userDirectory } from "./storage.js";
import { withToolCacheAdmission } from "./tool-cache-lock.js";
import { keptCacheAssets } from "./project-registry.js";
import { userConfigValues } from "./user-config.js";
import { diagnostic, LogLevel, DiagnosticOperation, DiagnosticOutcome } from "./diagnostics.js";
import { quote } from "./toolchains.js";
import { parseDockerBytes } from "./byte-size.js";
import type { BuilderCacheEntry, BuilderCacheReport } from "./builder-cache.js";

interface Volume {
  Name: string;
  CreatedAt: string;
  Labels: Record<string, string> | null;
}
interface Container {
  Id: string;
  Created: string;
  Config: { Image: string; Env: string[] };
  Mounts: { Name?: string; Destination: string }[];
}
interface Receipt {
  checkout: string;
  engine: string;
  image: string;
  name: string;
  token: string;
  volume?: Volume;
  container?: { Id: string; Created: string };
}
interface BuilderClient {
  name: string;
  docker: string;
  env: NodeJS.ProcessEnv;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const base = () => join(userDirectory("cache"), "docker-builders");
const receiptPath = (value: Receipt) => join(base(), `${value.name}.json`);
const lockPath = (value: Pick<Receipt, "name">) => join(base(), value.name);
const nodeName = (value: Receipt) => `${value.name}0`;
const containerName = (value: Receipt) => `buildx_buildkit_${nodeName(value)}`;
const volumeName = (value: Receipt) => `${containerName(value)}_state`;
async function volume(value: Receipt, signal?: AbortSignal): Promise<Volume | undefined> {
  const query = (args: string[]) => dockerQuery(args, signal);
  const names = await query(["volume", "ls", "--format", "{{.Name}}", "--filter", `name=^${volumeName(value)}$`]);
  if (!names) return undefined;
  return (JSON.parse(await query(["volume", "inspect", volumeName(value)])) as Volume[])[0];
}
async function container(value: Receipt, signal?: AbortSignal): Promise<Container | undefined> {
  const query = (args: string[]) => dockerQuery(args, signal);
  const ids = await query(["ps", "--all", "--quiet", "--filter", `name=^/${containerName(value)}$`]);
  if (!ids) return undefined;
  return (JSON.parse(await query(["container", "inspect", containerName(value)])) as Container[])[0];
}
function readReceipt(path: string): Receipt {
  const value = JSON.parse(readFileSync(path, "utf8")) as Receipt;
  if (
    typeof value.checkout !== "string" ||
    !isAbsolute(value.checkout) ||
    typeof value.engine !== "string" ||
    !value.engine ||
    typeof value.image !== "string" ||
    !/@sha256:[a-f0-9]{64}$/.test(value.image) ||
    !/^workbench-buildkit-[a-f0-9]{24}$/.test(value.name) ||
    typeof value.token !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.token) ||
    receiptPath(value) !== path ||
    value.name !==
      `workbench-buildkit-${hash(JSON.stringify([builderOwner(value.checkout), value.engine, value.image])).slice(0, 24)}`
  )
    throw new Error(`${path}: invalid BuildKit ownership receipt`);
  return value;
}
/** Names locate resources; labels, creation identities, engine, and the receipt authorize their use. */
async function verify(
  value: Receipt,
  engine?: string,
  signal?: AbortSignal,
): Promise<{ volume?: Volume; container?: Container }> {
  engine ??= await dockerQuery(["info", "--format", "{{.ID}}"], signal);
  if (engine !== value.engine) throw new Error("BuildKit ownership belongs to a different Docker engine");
  const actualVolume = await volume(value, signal);
  const actualContainer = await container(value, signal);
  if (
    actualVolume &&
    (actualVolume.Labels?.["org.workbench.token"] !== value.token ||
      actualVolume.Labels["org.workbench.owner"] !== builderOwner(value.checkout) ||
      (value.volume && actualVolume.CreatedAt !== value.volume.CreatedAt))
  )
    throw new Error("BuildKit volume has no matching Workbench ownership receipt");
  if (
    actualContainer &&
    (!actualVolume ||
      actualContainer.Config.Image !== value.image ||
      !actualContainer.Config.Env.includes(`WORKBENCH_BUILDER_TOKEN=${value.token}`) ||
      !actualContainer.Mounts.some(
        (mount) => mount.Name === volumeName(value) && mount.Destination === "/var/lib/buildkit",
      ) ||
      (value.container &&
        (actualContainer.Id !== value.container.Id || actualContainer.Created !== value.container.Created)))
  )
    throw new Error("BuildKit container has no matching Workbench ownership receipt");
  const attached = actualVolume
    ? (await dockerQuery(["ps", "--all", "--quiet", "--no-trunc", "--filter", `volume=${volumeName(value)}`], signal))
        .split("\n")
        .filter(Boolean)
    : [];
  if (attached.some((id) => id !== actualContainer?.Id))
    throw new Error("BuildKit volume is attached to another Docker container");
  return {
    ...(actualVolume ? { volume: actualVolume } : {}),
    ...(actualContainer ? { container: actualContainer } : {}),
  };
}
function save(value: Receipt): void {
  writeAtomic(receiptPath(value), JSON.stringify(value) + "\n", 0o600);
}

async function collectBuildkitCache(value: Receipt, client: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const config = userConfigValues();
    if (config["cache.auto_prune"] === false || keptCacheAssets().has(receiptPath(value))) return;
    const age = config["cache.max_age_days"] as number;
    const maximum = config["cache.buildkit_max_bytes"] as number;
    if (age === 0 && maximum === 0) return;
    await verify(value);
    const prune = (args: string[]) =>
      executeCI(client, ["buildx", "prune", "--builder", value.name, "--force", ...args], { env, capture: true });
    if (age > 0) await prune(["--filter", `until=${String(age * 24)}h`]);
    if (maximum > 0) await prune(["--keep-storage", `${String(maximum)}B`]);
  } catch (error) {
    try {
      diagnostic(
        LogLevel.Warn,
        DiagnosticOperation.Command,
        DiagnosticOutcome.Failed,
        { command: "owned BuildKit cache collection" },
        error,
        "image build completed; cache collection did not complete",
      );
    } catch {
      /* Optional maintenance cannot invalidate the completed build. */
    }
  }
}

function projectBuilderIdentity(root: string, engine: string) {
  const checkout = buildCheckout(root);
  const image = readFileSync(join(distributionRoot(root), "scripts/container-tools/buildkit-image.txt"), "utf8").trim();
  if (!/^docker\.io\/moby\/buildkit:v[\d.]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Invalid pinned BuildKit image");
  if (!engine) throw new Error("Cannot identify the Docker engine");
  const name = `workbench-buildkit-${hash(JSON.stringify([builderOwner(checkout), engine, image])).slice(0, 24)}`;
  return { checkout, engine, image, name };
}

/** Inspection and acquisition derive the exact same current engine/pin-bound metadata lock. */
export function projectBuildkitLock(root: string, engine: string): string {
  return lockPath(projectBuilderIdentity(root, engine));
}

/** Serialize only Docker builds; Nix/Guix closure preparation keeps its own concurrency. */
export async function withProjectBuilder<T>(root: string, action: (client: BuilderClient) => Promise<T>): Promise<T> {
  if (process.platform === "win32")
    throw new Error("Docker image preparation requires a POSIX host; use WSL on Windows");
  const initial: Receipt = {
    ...projectBuilderIdentity(root, await dockerQuery(["info", "--format", "{{.ID}}"])),
    token: randomUUID(),
  };
  const { checkout, image, name } = initial;
  return withCacheLock(lockPath(initial), async () => {
    const value = existsSync(receiptPath(initial)) ? readReceipt(receiptPath(initial)) : initial;
    const temporary = mkdtempSync(join(tmpdir(), "workbench-buildkit-"));
    const env = { ...process.env, BUILDX_CONFIG: temporary, BUILDX_BUILDER: name };
    try {
      await withToolCacheAdmission(async () => {
        const actual = await verify(value);
        save(value); // Durable intent allows recovery if creation is interrupted.
        if (!actual.volume) {
          await dockerQuery([
            "volume",
            "create",
            "--label",
            `org.workbench.owner=${builderOwner(checkout)}`,
            "--label",
            `org.workbench.token=${value.token}`,
            volumeName(value),
          ]);
          const created = (await verify(value)).volume;
          if (!created) throw new Error("Docker did not create the BuildKit volume");
          value.volume = created;
          delete value.container;
          save(value);
        }
        if (!actual.container) delete value.container;
        await executeCI(
          "docker",
          [
            "buildx",
            "create",
            "--name",
            name,
            "--node",
            nodeName(value),
            "--driver",
            "docker-container",
            "--driver-opt",
            `image=${image}`,
            "--driver-opt",
            "network=host",
            "--driver-opt",
            `env.WORKBENCH_BUILDER_TOKEN=${value.token}`,
            "--buildkitd-flags",
            "--allow-insecure-entitlement network.host",
          ],
          { env, capture: true },
        );
        // Bootstrap may create a container even on failure; preserve its identity for safe recovery.
        try {
          await executeCI("docker", ["buildx", "inspect", "--bootstrap", name], { env, capture: true });
        } finally {
          const current = await verify(value);
          if (current.container) value.container = { Id: current.container.Id, Created: current.container.Created };
          if (current.volume) value.volume = current.volume;
          save(value);
        }
      });
      const client = process.env.WORKBENCH_CI_DOCKER ?? dockerClient();
      const wrapper = join(temporary, "docker");
      writeFileSync(
        wrapper,
        [
          "#!/bin/sh",
          "set -eu",
          "operation=$1; shift",
          'case "$operation" in',
          `build) exec ${quote(client)} buildx build --builder ${quote(name)} --load --allow=network.host "$@";;`,
          `buildx) if [ "\${1:-}" = build ]; then shift; exec ${quote(client)} buildx build --builder ${quote(name)} --load --allow=network.host "$@"; fi;;`,
          "esac",
          `exec ${quote(client)} "$operation" "$@"`,
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const result = await action({ name, docker: wrapper, env: { BUILDX_CONFIG: temporary, BUILDX_BUILDER: name } });
      await collectBuildkitCache(value, client, env);
      return result;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
function dockerClient(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = resolve(directory, "docker");
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* Keep searching PATH. */
    }
  }
  throw new Error("Cannot locate the Docker client");
}
export async function buildProjectImage(root: string, args: string[]): Promise<void> {
  await withProjectBuilder(root, async (client) => {
    await executeCI(client.docker, ["build", ...args], { env: { ...process.env, ...client.env } });
  });
}

/** Only receipt-owned builders enter the cache selector; discovery never creates or starts one. */
export function currentBuildkitCacheKeys(root: string): string[] {
  if (!existsSync(base())) return [];
  const image = readFileSync(join(distributionRoot(root), "scripts/container-tools/buildkit-image.txt"), "utf8").trim();
  return readdirSync(base())
    .filter((file) => /^workbench-buildkit-[a-f0-9]{24}\.json$/.test(file))
    .map((file) => readReceipt(join(base(), file)))
    .filter((value) => value.checkout === buildCheckout(root) && value.image === image)
    .map((value) => value.name);
}

export async function inspectBuildkitCache(
  checkout?: string,
  signal?: AbortSignal,
  measure = true,
): Promise<BuilderCacheReport> {
  signal?.throwIfAborted();
  const query = (args: string[]) => dockerQuery(args, signal);
  const report: BuilderCacheReport = { entries: [], issues: [] };
  if (!existsSync(base())) return report;
  let engine: string | undefined;
  let usage: { Name: string; Size: string }[] | undefined;
  for (const file of readdirSync(base()).filter((name) => /^workbench-buildkit-[a-f0-9]{24}\.json$/.test(name))) {
    try {
      const value = readReceipt(join(base(), file));
      if (checkout && value.checkout !== checkout) continue;
      let blockedBy: string | undefined;
      let actual: Awaited<ReturnType<typeof verify>> = {};
      try {
        engine ??= await query(["info", "--format", "{{.ID}}"]);
        actual = await verify(value, engine, signal);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        blockedBy = describeError(error);
      }
      if (!blockedBy && !actual.volume && !actual.container) continue;
      if (!blockedBy && existsSync(`${lockPath(value)}.lock`))
        blockedBy = "active or recovery-required preparation lock";
      if (measure)
        usage ??= JSON.parse(await query(["system", "df", "-v", "--format", "{{json .Volumes}}"])) as {
          Name: string;
          Size: string;
        }[];
      if (measure && !usage?.some((item) => item.Name === volumeName(value)))
        throw new Error(`Docker volume usage is unavailable: ${volumeName(value)}`);
      report.entries.push({
        key: value.name,
        builder: "buildkit",
        checkout: value.checkout,
        receipt: receiptPath(value),
        lock: lockPath(value),
        identity: hash(JSON.stringify(value)),
        volumes: [volumeName(value)],
        bytes: measure
          ? parseDockerBytes(usage?.find((item) => item.Name === volumeName(value))?.Size ?? "")
          : undefined,
        ...(blockedBy ? { blockedBy } : {}),
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      report.issues.push(describeError(error));
    }
  }
  return report;
}
/** Caller holds the same build lock and has revalidated the selected receipt. */
export async function removeBuildkitCache(entry: BuilderCacheEntry): Promise<void> {
  if (!entry.receipt) throw new Error("BuildKit cache has no ownership receipt");
  const value = readReceipt(entry.receipt);
  const actual = await verify(value);
  if (actual.container)
    await executeCI("docker", ["container", "rm", "--force", actual.container.Id], { capture: true });
  // Recheck after removing the daemon: an external Docker command may have changed the volume meanwhile.
  const remaining = await verify(value);
  if (remaining.volume) await executeCI("docker", ["volume", "rm", remaining.volume.Name], { capture: true });
  rmSync(entry.receipt);
}
