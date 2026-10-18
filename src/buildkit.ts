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
import { spawnSync } from "node:child_process";
import { builderOwner } from "../scripts/managed-contract.mjs";
import { buildCheckout } from "./builds.js";
import { distributionRoot, writeAtomic } from "./core.js";
import { withCacheLock } from "./cache-lock.js";
import { executeCI } from "./ci-lifecycle.js";
import { userDirectory } from "./storage.js";
import { withToolCacheAdmission } from "./tool-cache-lock.js";
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
const lockPath = (value: Receipt) => join(base(), value.name);
const nodeName = (value: Receipt) => `${value.name}0`;
const containerName = (value: Receipt) => `buildx_buildkit_${nodeName(value)}`;
const volumeName = (value: Receipt) => `${containerName(value)}_state`;
function docker(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
  return result.stdout.trim();
}
function volume(value: Receipt): Volume | undefined {
  const names = docker(["volume", "ls", "--format", "{{.Name}}", "--filter", `name=^${volumeName(value)}$`]);
  if (!names) return undefined;
  return (JSON.parse(docker(["volume", "inspect", volumeName(value)])) as Volume[])[0];
}
function container(value: Receipt): Container | undefined {
  const ids = docker(["ps", "--all", "--quiet", "--filter", `name=^/${containerName(value)}$`]);
  if (!ids) return undefined;
  return (JSON.parse(docker(["container", "inspect", containerName(value)])) as Container[])[0];
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
function verify(
  value: Receipt,
  engine = docker(["info", "--format", "{{.ID}}"]),
): { volume?: Volume; container?: Container } {
  if (engine !== value.engine) throw new Error("BuildKit ownership belongs to a different Docker engine");
  const actualVolume = volume(value);
  const actualContainer = container(value);
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
    ? docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `volume=${volumeName(value)}`])
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

/** Serialize only Docker builds; Nix/Guix closure preparation keeps its own concurrency. */
export async function withProjectBuilder<T>(root: string, action: (client: BuilderClient) => Promise<T>): Promise<T> {
  if (process.platform === "win32")
    throw new Error("Docker image preparation requires a POSIX host; use WSL on Windows");
  const checkout = buildCheckout(root);
  const image = readFileSync(join(distributionRoot(root), "scripts/container-tools/buildkit-image.txt"), "utf8").trim();
  if (!/^docker\.io\/moby\/buildkit:v[\d.]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Invalid pinned BuildKit image");
  const engine = docker(["info", "--format", "{{.ID}}"]);
  if (!engine) throw new Error("Cannot identify the Docker engine");
  const name = `workbench-buildkit-${hash(JSON.stringify([builderOwner(checkout), engine, image])).slice(0, 24)}`;
  const initial: Receipt = { checkout, engine, image, name, token: randomUUID() };
  return withCacheLock(lockPath(initial), async () => {
    const value = existsSync(receiptPath(initial)) ? readReceipt(receiptPath(initial)) : initial;
    const temporary = mkdtempSync(join(tmpdir(), "workbench-buildkit-"));
    const env = { ...process.env, BUILDX_CONFIG: temporary, BUILDX_BUILDER: name };
    try {
      await withToolCacheAdmission(async () => {
        const actual = verify(value);
        save(value); // Durable intent allows recovery if creation is interrupted.
        if (!actual.volume) {
          docker([
            "volume",
            "create",
            "--label",
            `org.workbench.owner=${builderOwner(checkout)}`,
            "--label",
            `org.workbench.token=${value.token}`,
            volumeName(value),
          ]);
          const created = verify(value).volume;
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
          const current = verify(value);
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
      return await action({ name, docker: wrapper, env: { BUILDX_CONFIG: temporary, BUILDX_BUILDER: name } });
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
export function inspectBuildkitCache(checkout?: string): BuilderCacheReport {
  const report: BuilderCacheReport = { entries: [], issues: [] };
  if (!existsSync(base())) return report;
  let engine: string | undefined;
  let usage: { Name: string; Size: string }[] | undefined;
  for (const file of readdirSync(base()).filter((name) => /^workbench-buildkit-[a-f0-9]{24}\.json$/.test(name))) {
    try {
      const value = readReceipt(join(base(), file));
      if (checkout && value.checkout !== checkout) continue;
      let blockedBy: string | undefined;
      let actual: ReturnType<typeof verify> = {};
      try {
        engine ??= docker(["info", "--format", "{{.ID}}"]);
        actual = verify(value, engine);
      } catch (error) {
        blockedBy = String(error);
      }
      if (!blockedBy && !actual.volume && !actual.container) continue;
      if (!blockedBy && existsSync(`${lockPath(value)}.lock`))
        blockedBy = "active or recovery-required preparation lock";
      usage ??= JSON.parse(docker(["system", "df", "-v", "--format", "{{json .Volumes}}"])) as {
        Name: string;
        Size: string;
      }[];
      report.entries.push({
        key: value.name,
        builder: "buildkit",
        checkout: value.checkout,
        receipt: receiptPath(value),
        lock: lockPath(value),
        identity: hash(JSON.stringify(value)),
        volumes: [volumeName(value)],
        bytes: parseDockerBytes(usage.find((item) => item.Name === volumeName(value))?.Size ?? ""),
        ...(blockedBy ? { blockedBy } : {}),
      });
    } catch (error) {
      report.issues.push(String(error));
    }
  }
  return report;
}
/** Caller holds the same build lock and has revalidated the selected receipt. */
export async function removeBuildkitCache(entry: BuilderCacheEntry): Promise<void> {
  if (!entry.receipt) throw new Error("BuildKit cache has no ownership receipt");
  const value = readReceipt(entry.receipt);
  const actual = verify(value);
  if (actual.container)
    await executeCI("docker", ["container", "rm", "--force", actual.container.Id], { capture: true });
  // Recheck after removing the daemon: an external Docker command may have changed the volume meanwhile.
  const remaining = verify(value);
  if (remaining.volume) await executeCI("docker", ["volume", "rm", remaining.volume.Name], { capture: true });
  rmSync(entry.receipt);
}
