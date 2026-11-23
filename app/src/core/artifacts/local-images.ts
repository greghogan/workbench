import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { ownedPath } from "../runtime/paths.js";
import { isRecord } from "../runtime/values.mjs";
import { userDirectory } from "../storage/storage.js";
import { withCacheLockSync } from "../storage/cache-lock.js";
import { publishManagedReceipt } from "../storage/managed-preparation.js";
import { imageReference } from "./container-references.js";
import { imageQuery as run } from "./image-process.js";
import { keptCacheAssets } from "../projects/project-registry.js";
import {
  managedProfileOwner,
  managedStorePin,
  type ManagedStorePin,
} from "../execution/environments/managed/managed-contract.mjs";
import {
  imageHash as hash,
  imageDigest,
  imageProfileLock,
  imageProfileMaintenanceLock,
  imageProfileReceipt,
  ImageExecution,
  imageProtection,
  localPreparedReference,
  type ImageProtection,
  type LocalImageReport,
} from "./image-contract.js";
interface DockerImage {
  Id: string;
  Size: number;
  Config: { Labels?: Record<string, string> };
}
interface ImageRecord {
  version: number;
  checkout: string;
  profile: string;
  reference: string;
  image: string;
  inputs: string;
  platform: string;
  verified?: string;
  assembled?: string;
  published?: string;
  verificationHost?: string;
  verificationMethod?: ImageExecution;
  storePin?: ManagedStorePin;
  priorStorePins?: StorePinEvidence[];
}
interface StorePinEvidence {
  profile: string;
  platform: string;
  image: string;
  inputs: string;
  verified?: string;
  storePin: ManagedStorePin;
}
const profileName = /^[a-z][a-z0-9_-]*$/;
const profilePlatforms = ["linux-x64", "linux-arm64"];

/** GHCR uses this public repository annotation to associate images with their source repository. */
export function preparedImageSource(root: string): string | undefined {
  let remote: string;
  try {
    remote = run("git", ["-C", root, "remote", "get-url", "origin"]);
  } catch {
    return undefined;
  }
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
    remote,
  );
  return match ? `https://github.com/${match[1] ?? ""}/${match[2] ?? ""}` : undefined;
}
function catalogPath(value: Pick<ImageRecord, "checkout" | "reference">): string {
  return join(userDirectory("cache"), "prepared-images", hash(value.checkout), `${hash(value.reference)}.json`);
}

/** Local ownership and verification history survive deletion, including images whose verification failed. */
export function recordPreparedImage(
  checkout: string,
  profile: string,
  reference: string,
  receipt: Pick<
    ImageRecord,
    | "image"
    | "inputs"
    | "platform"
    | "verified"
    | "published"
    | "assembled"
    | "verificationHost"
    | "verificationMethod"
    | "storePin"
  >,
): void {
  const record: ImageRecord = { ...receipt, version: 1, checkout, profile, reference };
  const path = catalogPath(record);
  withCacheLockSync(path, () => {
    if (existsSync(path)) {
      const previous = readRecord(path);
      if (previous.profile === profile && previous.image === record.image && previous.inputs === record.inputs) {
        if (
          !record.verified &&
          previous.verified &&
          (!record.storePin || JSON.stringify(previous.storePin) === JSON.stringify(record.storePin))
        )
          return;
        if (!record.storePin && previous.storePin) record.storePin = previous.storePin;
      }
      const group = (pin: StorePinEvidence) =>
        `${pin.profile}/${pin.storePin.builder}/${pin.storePin.key}/${pin.inputs}`;
      const prior = new Map((previous.priorStorePins ?? []).map((pin) => [group(pin), pin]));
      if (previous.storePin) {
        const pin: StorePinEvidence = {
          profile: previous.profile,
          platform: previous.platform,
          image: previous.image,
          inputs: previous.inputs,
          storePin: previous.storePin,
          ...(previous.verified ? { verified: previous.verified } : {}),
        };
        prior.delete(group(pin));
        prior.set(group(pin), pin);
      }
      if (record.storePin) prior.delete(group({ ...record, storePin: record.storePin }));
      if (prior.size) record.priorStorePins = [...prior.values()];
    }
    const contents = JSON.stringify(record, null, 2) + "\n";
    if (record.storePin) publishManagedReceipt(path, contents);
    else writeAtomic(path, contents, 0o600);
  });
}
function readRecord(path: string): ImageRecord {
  const value = JSON.parse(readFileSync(path, "utf8")) as ImageRecord;
  if (
    value.version !== 1 ||
    typeof value.checkout !== "string" ||
    !isAbsolute(value.checkout) ||
    typeof value.profile !== "string" ||
    !profileName.test(value.profile) ||
    typeof value.reference !== "string" ||
    !(imageReference(value.reference) || localPreparedReference(value.reference)) ||
    !imageDigest.test(value.image) ||
    !/^[a-f0-9]{64}$/.test(value.inputs) ||
    !profilePlatforms.includes(value.platform) ||
    (value.verified !== undefined && typeof value.verified !== "string") ||
    (value.assembled !== undefined && typeof value.assembled !== "string") ||
    (value.verificationHost !== undefined && !profilePlatforms.includes(value.verificationHost)) ||
    (value.verificationMethod !== undefined && !Object.values(ImageExecution).includes(value.verificationMethod)) ||
    (value.verificationHost === undefined) !== (value.verificationMethod === undefined) ||
    (value.verificationMethod !== undefined &&
      (value.verificationMethod === ImageExecution.Native) !== (value.verificationHost === value.platform)) ||
    (!value.verified && !value.assembled) ||
    catalogPath(value) !== path
  )
    throw new Error(`${path}: invalid prepared image ownership`);
  if (value.storePin !== undefined) value.storePin = managedStorePin(value.storePin);
  if (value.priorStorePins !== undefined) {
    if (
      !Array.isArray(value.priorStorePins) ||
      value.priorStorePins.some(
        (pin: unknown) =>
          !isRecord(pin) ||
          typeof pin.profile !== "string" ||
          !profileName.test(pin.profile) ||
          typeof pin.platform !== "string" ||
          !profilePlatforms.includes(pin.platform) ||
          typeof pin.image !== "string" ||
          !imageDigest.test(pin.image) ||
          typeof pin.inputs !== "string" ||
          !/^[a-f0-9]{64}$/.test(pin.inputs) ||
          (pin.verified !== undefined &&
            (typeof pin.verified !== "string" || !Number.isFinite(Date.parse(pin.verified)))),
      )
    )
      throw new Error(`${path}: invalid prior store pin evidence`);
    value.priorStorePins = value.priorStorePins.map((pin) => ({ ...pin, storePin: managedStorePin(pin.storePin) }));
  }
  return value;
}

export function storePinForImage(
  checkout: string,
  profile: string,
  reference: string,
  image: string,
  inputs: string,
): ManagedStorePin | undefined {
  const path = catalogPath({ checkout, reference });
  if (!existsSync(path)) return undefined;
  const record = readRecord(path);
  if (record.profile === profile && record.image === image && record.inputs === inputs) return record.storePin;
  return record.priorStorePins
    ?.slice()
    .reverse()
    .find((pin) => pin.profile === profile && pin.image === image && pin.inputs === inputs)?.storePin;
}

export function preparedImageRecord(checkout: string, reference: string): ImageRecord | undefined {
  const path = catalogPath({ checkout, reference });
  if (existsSync(path)) return readRecord(path);
  return undefined;
}
/** Drop retired roots without discarding the image's verification or newer pin evidence. */
export function forgetPreparedStorePin(path: string, owner: string, inputs: string, pin: ManagedStorePin): void {
  withCacheLockSync(path, () => {
    if (!existsSync(path)) return;
    const record = readRecord(path);
    const identity = JSON.stringify(pin);
    const matches = (entry: Pick<ImageRecord, "profile" | "inputs" | "storePin">) =>
      managedProfileOwner(record.checkout, entry.profile) === owner &&
      entry.inputs === inputs &&
      JSON.stringify(entry.storePin) === identity;
    const current = matches(record);
    const previous = record.priorStorePins ?? [];
    const retained = previous.filter((entry) => !matches(entry));
    if (!current && retained.length === previous.length) return;
    if (current) delete record.storePin;
    if (retained.length) record.priorStorePins = retained;
    else delete record.priorStorePins;
    writeAtomic(path, JSON.stringify(record, null, 2) + "\n", 0o600);
  });
}

export function preparedImageEvidence(issues: string[], checkout?: string): { path: string; record: ImageRecord }[] {
  const base = join(userDirectory("cache"), "prepared-images");
  const result: { path: string; record: ImageRecord }[] = [];
  const children = (directory: string): string[] => {
    try {
      return readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push(`${directory}: ${String(error)}`);
      return [];
    }
  };
  for (const owner of children(base).filter((name) => /^[a-f0-9]{64}$/.test(name))) {
    if (checkout && owner !== hash(checkout)) continue;
    try {
      const directory = ownedPath(base, owner);
      for (const file of children(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
        try {
          const path = ownedPath(directory, file);
          result.push({ path, record: readRecord(path) });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            issues.push(`${join(directory, file)}: ${String(error)}`);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push(`${join(base, owner)}: ${String(error)}`);
    }
  }
  return result;
}

export function localImageReferences(): ReadonlySet<string> {
  return new Set(run("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"]).split("\n").filter(Boolean));
}

/** Inspect recorded ownership. Docker protects all container references, including stopped containers. */
export function inspectPreparedImages(
  checkout?: string,
  references?: ReadonlySet<string>,
  protections = true,
  inventory?: ReadonlySet<string>,
): LocalImageReport {
  const report: LocalImageReport = { location: "local", entries: [], issues: [] };
  const kept = protections ? keptCacheAssets() : new Set<string>();
  const owned = preparedImageEvidence(report.issues, checkout).filter(
    ({ record }) => !references || references.has(record.reference),
  );
  if (!owned.length) return report;
  try {
    const listed = inventory ?? localImageReferences();
    const selected = owned.filter(({ record }) => listed.has(record.reference));
    const images = new Map<string, DockerImage>();
    for (let offset = 0; offset < selected.length; offset += 100) {
      const batch = selected.slice(offset, offset + 100);
      const inspected = JSON.parse(
        run("docker", ["image", "inspect", ...batch.map(({ record }) => record.reference)]),
      ) as DockerImage[];
      if (inspected.length !== batch.length) throw new Error("Docker returned an incomplete image inventory");
      batch.forEach(({ record }, index) => {
        const image = inspected[index];
        if (!image) throw new Error(`Docker returned no image for ${record.reference}`);
        images.set(record.reference, image);
      });
    }
    const attached = new Map<string, boolean>();
    for (const { path, record } of selected) {
      const image = images.get(record.reference);
      if (!image) throw new Error(`Docker returned no image for ${record.reference}`);
      const lock = imageProfileLock(record.checkout, record.profile, record.platform.slice("linux-".length));
      let reason: ImageProtection | undefined;
      if (image.Id !== record.image || image.Config.Labels?.["org.workbench.inputs"] !== record.inputs)
        reason = "changed";
      else if (kept.has(path)) reason = "retained";
      else if (protections) {
        if (!attached.has(record.image))
          attached.set(
            record.image,
            Boolean(run("docker", ["ps", "--all", "--quiet", "--filter", `ancestor=${record.image}`])),
          );
        reason = attached.get(record.image)
          ? "attached"
          : existsSync(`${lock}.lock`) ||
              existsSync(`${imageProfileMaintenanceLock(record.checkout, record.profile)}.lock`)
            ? "locked"
            : undefined;
      }
      report.entries.push({
        key: hash(path),
        checkout: record.checkout,
        profile: record.profile,
        reference: record.reference,
        image: record.image,
        bytes: image.Size,
        lock,
        identity: hash(JSON.stringify(record)),
        catalog: path,
        receipt: imageProfileReceipt(record.checkout, record.profile, record.platform.slice("linux-".length)),
        platform: record.platform,
        inputs: record.inputs,
        ...(record.assembled ? { assembled: record.assembled } : {}),
        ...(record.verified ? { verified: record.verified } : {}),
        ...(record.verificationHost ? { verificationHost: record.verificationHost } : {}),
        ...(record.verificationMethod ? { verificationMethod: record.verificationMethod } : {}),
        ...imageProtection(reason),
      });
    }
  } catch (error) {
    report.issues.push(error instanceof Error ? error.message : String(error));
  }
  return report;
}
