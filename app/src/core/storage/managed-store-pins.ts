import { existsSync, lstatSync, readlinkSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { dockerQuery } from "../artifacts/docker-query.js";
import { imageDigest, imageHash, imageProfileLock, imageProfileReceipt } from "../artifacts/image-contract.js";
import { forgetPreparedStorePin, preparedImageEvidence } from "../artifacts/local-images.js";
import { userConfigValues } from "../configuration/user-config.js";
import { describeError } from "../diagnostics/diagnostic-errors.mjs";
import { executeCI } from "../execution/ci/support/ci-lifecycle.mjs";
import {
  managedProfileOwner,
  managedStoreCleanupLabel,
  managedStoreDirectory,
  managedStorePin,
  mountFields,
  partialManagedStorePin,
  PreparationStore,
  storePrefix,
} from "../execution/environments/managed/managed-contract.mjs";
import { distributionRoot } from "../projects/project-context.js";
import { projectPaths } from "../projects/project-paths.js";
import { keptCacheAssets } from "../projects/project-registry.js";
import { readBoundedFile } from "../runtime/file-reads.js";
import { ownedPath } from "../runtime/paths.js";
import { record as checkedRecord } from "../runtime/values.mjs";
import type { BuilderCacheEntry, BuilderCacheReport } from "./builder-cache.js";
import {
  managedStoreGeneration,
  managedStoreMaintenanceImage,
  managedStoreVolumes,
  prepareManagedBuilderStore,
} from "./managed-builder-store.js";
import {
  managedPreparationIdentity,
  pendingManagedPreparations,
  publishManagedReceipt,
} from "./managed-preparation.js";
import { userDirectory } from "./storage.js";

type Evidence = ReturnType<typeof preparedImageEvidence>[number];
type Release = "archive" | "generation";
type Pin = NonNullable<Evidence["record"]["storePin"]>;
export interface ManagedStoreCleanup {
  release: Release;
  profileLock: string;
  journal: string;
  owner: string;
  inputs: string;
  pin: Pin;
}
export interface ManagedStorePruneEntry extends BuilderCacheEntry {
  cleanup: ManagedStoreCleanup;
}

const retired = (path: string, inputs: string) => join(dirname(path), `.retiring-${inputs}`);
const running = "active or recovery-required preparation lock";

function policyProtection(
  checkout: string | undefined,
  paths: (string | undefined)[],
  kept: ReadonlySet<string>,
  setting: unknown,
): string | undefined {
  if (!checkout || !existsSync(join(checkout, projectPaths.projects))) return "project requirements are unavailable";
  if (paths.some((path) => path !== undefined && kept.has(path))) return "explicitly retained";
  if (setting === PreparationStore.Disabled) return "preparation store is disabled";
  return undefined;
}

function profileGeneration(directory: string, builder: Pin["builder"], owner: string, inputs: string): string {
  return ownedPath(directory, `${builder === "guix" ? "state" : "store/var/nix"}/gcroots/workbench/${owner}/${inputs}`);
}

async function hasVerifiedReplacement(
  current: Evidence["record"],
  verification: ReadonlySet<string>,
  observed: Map<string, boolean>,
): Promise<boolean> {
  const architecture = current.platform.slice("linux-".length);
  const path = imageProfileReceipt(current.checkout, current.profile, architecture);
  if (!existsSync(path)) return false;
  const accepted = checkedRecord(
    JSON.parse(readBoundedFile(path, 64 * 1024, "prepared profile").toString()),
    "Invalid verified profile receipt",
  );
  if (
    accepted.version !== 1 ||
    accepted.profile !== current.profile ||
    accepted.platform !== current.platform ||
    typeof accepted.image !== "string" ||
    !imageDigest.test(accepted.image) ||
    typeof accepted.inputs !== "string" ||
    !/^[a-f0-9]{64}$/.test(accepted.inputs) ||
    !accepted.storePin ||
    typeof accepted.verified !== "string" ||
    !(Date.parse(accepted.verified) >= Date.parse(current.verified ?? ""))
  )
    return false;
  const replacement = managedStorePin(accepted.storePin);
  if (
    (accepted.inputs === current.inputs && replacement.key === current.storePin?.key) ||
    !verification.has(
      JSON.stringify([
        current.checkout,
        current.profile,
        current.platform,
        accepted.inputs,
        accepted.image,
        accepted.verified,
        replacement.key,
      ]),
    )
  )
    return false;
  const directory = managedStoreGeneration(replacement.builder, replacement.key);
  const linked = profileGeneration(
    directory,
    replacement.builder,
    managedProfileOwner(current.checkout, current.profile),
    accepted.inputs,
  );
  const volume = dirname(storePrefix(replacement.builder));
  if (
    !replacement.roots.every((root, index) => {
      const link = join(linked, String(index));
      return (
        lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() &&
        readlinkSync(link) === root &&
        existsSync(ownedPath(directory, `store/${relative(volume, root)}`))
      );
    })
  )
    return false;
  const key = JSON.stringify([current.checkout, current.profile, architecture, accepted.inputs]);
  const cached = observed.get(key);
  if (cached !== undefined) return cached;
  const { offlineInputs, offlineProfile } = await import("../artifacts/offline-profiles.js");
  const matches =
    offlineInputs(current.checkout, offlineProfile(current.checkout, current.profile), architecture) ===
    accepted.inputs;
  observed.set(key, matches);
  return matches;
}

function cleanupIdentity(entry: ManagedStorePruneEntry): string {
  return JSON.stringify({ version: 1, identity: entry.identity, release: entry.cleanup.release }) + "\n";
}

function pendingOperation(journal: string): Record<string, unknown> | undefined {
  if (!existsSync(journal)) return undefined;
  return checkedRecord(
    JSON.parse(readBoundedFile(journal, 4096, "managed store retirement").toString()),
    "Invalid managed store retirement",
  );
}

/** Prepared image evidence is durable even when a Docker cleanup removes its tag. */
export async function inspectManagedStorePins(
  checkout?: string,
  signal?: AbortSignal,
  held: ReadonlySet<string> = new Set(),
): Promise<BuilderCacheReport> {
  const report: BuilderCacheReport = { entries: [], issues: [] };
  const catalog = preparedImageEvidence(report.issues, checkout);
  const evidence = catalog.flatMap(({ path, record }) => [
    ...(record.priorStorePins ?? []).map((pin) => {
      const previous = { ...record, ...pin };
      if (!pin.verified) delete previous.verified;
      return { path, record: previous };
    }),
    { path, record },
  ]);
  const recorded = new Set(
    evidence.flatMap(({ record: { checkout, profile, platform, inputs, storePin } }) =>
      storePin
        ? [
            managedPreparationIdentity({
              checkout,
              profile,
              architecture: platform.slice("linux-".length),
              inputs,
              ...storePin,
            }),
          ]
        : [],
    ),
  );
  for (const { path, value } of pendingManagedPreparations(checkout, report.issues)) {
    signal?.throwIfAborted();
    try {
      const { checkout, profile, architecture, inputs, builder, key } = value;
      const identity = managedPreparationIdentity(value);
      if (recorded.has(identity)) continue;
      const directory = managedStoreGeneration(builder, key);
      const generation = profileGeneration(directory, builder, managedProfileOwner(checkout, profile), inputs);
      const lock = managedStoreDirectory(userDirectory("cache"), builder);
      const profileLock = imageProfileLock(checkout, profile, architecture);
      const active = [lock, profileLock].some((path) => !held.has(path) && existsSync(`${path}.lock`));
      if (
        !active &&
        !lstatSync(generation, { throwIfNoEntry: false }) &&
        !lstatSync(join(dirname(generation), partialManagedStorePin(inputs)), { throwIfNoEntry: false })
      )
        continue;
      report.entries.push({
        key: `preparation-${identity}`,
        builder,
        label: `${builder === "nix" ? "Nix" : "Guix"} · ${basename(checkout)}/${profile} · linux-${architecture}`,
        status: "preparation pending",
        bytes: undefined,
        volumes: [],
        checkout,
        lock,
        identity,
        receipt: path,
        directory,
        blockedBy: active
          ? running
          : `retry workbench development prepare ${profile} --build --architecture ${architecture} from this project`,
      });
    } catch (error) {
      report.issues.push(describeError(error));
    }
  }
  if (!evidence.some(({ record }) => record.storePin)) return report;
  const preferences = userConfigValues();
  const kept = keptCacheAssets();
  const verification = new Set(
    evidence.flatMap(({ record }) =>
      record.verified && record.storePin
        ? [
            JSON.stringify([
              record.checkout,
              record.profile,
              record.platform,
              record.inputs,
              record.image,
              record.verified,
              record.storePin.key,
            ]),
          ]
        : [],
    ),
  );
  const images = new Map<string, boolean>();
  const maintenanceImages = new Map<string, boolean>();
  const attachedStores = new Map<string, boolean>();
  const observed = new Map<string, boolean>();
  for (const { path, record } of evidence) {
    signal?.throwIfAborted();
    const pin = record.storePin;
    if (!pin) continue;
    try {
      const directory = managedStoreGeneration(pin.builder, pin.key);
      if (!existsSync(directory)) continue;
      const owner = managedProfileOwner(record.checkout, record.profile);
      const generation = profileGeneration(directory, pin.builder, owner, record.inputs);
      const lock = managedStoreDirectory(userDirectory("cache"), pin.builder);
      const profileLock = imageProfileLock(record.checkout, record.profile, record.platform.slice("linux-".length));
      const key = `pin-${imageHash(JSON.stringify([path, owner, pin.key, record.inputs]))}`;
      const journal = ownedPath(directory, `.workbench-retirements/${key}.json`);
      const pending = pendingOperation(journal);
      const live = lstatSync(generation, { throwIfNoEntry: false });
      if (!pending && !live) continue;
      const archive = live?.isDirectory()
        ? lstatSync(join(generation, "archive"), { throwIfNoEntry: false })
        : undefined;
      let release: Release = pending?.release === "generation" ? "generation" : "archive";
      let blockedBy = report.issues.length
        ? "project requirements are unavailable"
        : policyProtection(
            record.checkout,
            [path, lock, directory],
            kept,
            preferences[`preparation.${pin.builder}_store`],
          );
      if (!blockedBy && [lock, profileLock].some((path) => !held.has(path) && existsSync(`${path}.lock`)))
        blockedBy = running;
      if (!blockedBy && (!record.verified || !Number.isFinite(Date.parse(record.verified))))
        blockedBy = "image verification is pending";
      if (!blockedBy) {
        const replaced =
          pending?.release !== "archive" && (await hasVerifiedReplacement(record, verification, observed));
        if (replaced) release = "generation";
        if (release === "generation" && !replaced) blockedBy = "verified replacement is unavailable";
        if (release === "archive" && !archive && !pending) blockedBy = "profile is still required";
        if (!blockedBy) {
          if (!images.has(record.image))
            images.set(
              record.image,
              Boolean(await dockerQuery(["ps", "--all", "--quiet", "--filter", `ancestor=${record.image}`], signal)),
            );
          if (images.get(record.image)) blockedBy = "referenced by a Docker container";
          else {
            if (!maintenanceImages.has(directory)) {
              const marker = ownedPath(directory, ".workbench-maintenance-image");
              const available =
                existsSync(marker) &&
                Boolean(
                  await dockerQuery(
                    [
                      "image",
                      "ls",
                      "--quiet",
                      "--filter",
                      `reference=workbench-managed-store:${pin.builder}-${pin.key}`,
                    ],
                    signal,
                  ),
                );
              maintenanceImages.set(directory, available);
            }
            if (!maintenanceImages.get(directory)) blockedBy = "compatible maintenance image is unavailable";
            else {
              if (!attachedStores.has(directory)) {
                const attached = await Promise.all(
                  managedStoreVolumes(pin.builder, pin.key).map(({ name }) =>
                    dockerQuery(["ps", "--all", "--quiet", "--filter", `volume=${name}`], signal),
                  ),
                );
                attachedStores.set(directory, attached.some(Boolean));
              }
              if (attachedStores.get(directory)) blockedBy = "store is attached to a Docker container";
            }
          }
        }
      }
      const identity = imageHash(
        JSON.stringify([record.checkout, record.profile, record.platform, record.inputs, record.image, pin, release]),
      );
      const entry: ManagedStorePruneEntry = {
        key,
        builder: pin.builder,
        label: `${pin.builder === "nix" ? "Nix" : "Guix"} · ${basename(record.checkout)}/${record.profile} · ${record.platform}`,
        status: pending ? "cleanup pending" : release === "archive" ? "release staging archive" : "superseded profile",
        bytes: undefined,
        volumes: [],
        checkout: record.checkout,
        lock,
        identity,
        receipt: path,
        directory,
        cleanup: { release, profileLock, journal, owner, inputs: record.inputs, pin },
      };
      if (pending && JSON.stringify(pending) + "\n" !== cleanupIdentity(entry))
        blockedBy = "retirement evidence changed; inspect before retrying";
      if (
        !pending &&
        (!live?.isDirectory() || lstatSync(retired(generation, record.inputs), { throwIfNoEntry: false }))
      )
        blockedBy = "profile root ownership or recovery is uncertain";
      if (blockedBy) entry.blockedBy = blockedBy;
      report.entries.push(entry);
    } catch (error) {
      signal?.throwIfAborted();
      report.issues.push(describeError(error));
    }
  }
  return report;
}

// Only a compatible bootstrap can run cleanup; the store mounts never use host manager paths.
const collector = `
set -eu
node /workbench/scripts/builder-store-gc.mjs "$@"
if [ "$1" = nix ]; then
  nix-store --store local --gc
else
  /opt/workbench-guix/bin/guix-daemon --build-users-group=guixbuild --disable-chroot &
  daemon=$!
  trap 'kill "$daemon" 2>/dev/null || true; wait "$daemon" || true' EXIT
  attempt=0
  until /opt/workbench-guix/bin/guix gc --list-roots >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if ! kill -0 "$daemon" 2>/dev/null || [ "$attempt" -ge 60 ]; then
      echo 'Managed Guix maintenance daemon did not become ready' >&2
      exit 1
    fi
    sleep 1
  done
  /opt/workbench-guix/bin/guix gc
fi`;

export async function retireManagedStorePin(entry: ManagedStorePruneEntry, validate?: () => void): Promise<void> {
  const { pin, release, owner, inputs, journal } = entry.cleanup;
  const authorize = () => {
    validate?.();
    const protection = policyProtection(
      entry.checkout,
      [entry.receipt, entry.lock, entry.directory],
      keptCacheAssets(),
      userConfigValues()[`preparation.${pin.builder}_store`],
    );
    if (protection) throw new Error(`Managed store cleanup is blocked: ${protection}`);
  };
  authorize();
  const directory = managedStoreGeneration(pin.builder, pin.key);
  const image = managedStoreMaintenanceImage(directory);
  const { volumes } = await prepareManagedBuilderStore(pin.builder, image, { expectedKey: pin.key, cleanup: true });
  for (const volume of volumes)
    if (await dockerQuery(["ps", "--all", "--quiet", "--filter", `volume=${volume.name}`]))
      throw new Error(`Managed store volume ${volume.name} has an attached process; preserving all roots`);
  authorize();
  publishManagedReceipt(journal, cleanupIdentity(entry));
  const distribution = distributionRoot(entry.checkout ?? process.cwd());
  await executeCI(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      `workbench-store-cleanup-${pin.key}`,
      "--label",
      `${managedStoreCleanupLabel}=${pin.builder}`,
      "--pull",
      "never",
      "--network",
      "none",
      "--entrypoint",
      "/bin/sh",
      "--mount",
      mountFields("type=bind", `src=${distribution}`, "dst=/workbench", "readonly"),
      ...volumes.flatMap(({ name, destination }) => [
        "--mount",
        mountFields("type=volume", `src=${name}`, `dst=${destination}`),
      ]),
      image,
      "-ec",
      collector,
      "workbench-managed-store",
      pin.builder,
      release,
      owner,
      inputs,
      JSON.stringify(pin),
    ],
    { capture: true },
  );
  if (release === "generation" && entry.receipt) forgetPreparedStorePin(entry.receipt, owner, inputs, pin);
  rmSync(journal);
}
