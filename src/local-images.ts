import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { writeAtomic } from "./core.js";
import { ownedPath } from "./paths.js";
import { userDirectory } from "./storage.js";
import { imageReference } from "./container-references.js";
import { imageQuery as run } from "./image-process.js";
import {
  imageHash as hash,
  imageDigest,
  imageProfileLock,
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
}

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
function catalogPath(value: ImageRecord): string {
  return join(userDirectory("cache"), "prepared-images", hash(value.checkout), `${hash(value.reference)}.json`);
}

/** Local ownership and verification history survive deletion, including images whose verification failed. */
export function recordPreparedImage(
  checkout: string,
  profile: string,
  reference: string,
  receipt: Pick<ImageRecord, "image" | "inputs" | "platform" | "verified" | "published" | "assembled">,
): void {
  const record: ImageRecord = { ...receipt, version: 1, checkout, profile, reference };
  const path = catalogPath(record);
  if (existsSync(path) && !record.verified) {
    const previous = readRecord(path);
    if (previous.image === record.image && previous.verified) return;
  }
  writeAtomic(path, JSON.stringify(record, null, 2) + "\n", 0o600);
}
function readRecord(path: string): ImageRecord {
  const value = JSON.parse(readFileSync(path, "utf8")) as ImageRecord;
  if (
    value.version !== 1 ||
    typeof value.checkout !== "string" ||
    !isAbsolute(value.checkout) ||
    typeof value.profile !== "string" ||
    !/^[a-z][a-z0-9_-]*$/.test(value.profile) ||
    typeof value.reference !== "string" ||
    !(imageReference(value.reference) || localPreparedReference(value.reference)) ||
    !imageDigest.test(value.image) ||
    !/^[a-f0-9]{64}$/.test(value.inputs) ||
    !["linux-x64", "linux-arm64"].includes(value.platform) ||
    (value.verified !== undefined && typeof value.verified !== "string") ||
    (value.assembled !== undefined && typeof value.assembled !== "string") ||
    (!value.verified && !value.assembled) ||
    catalogPath(value) !== path
  )
    throw new Error(`${path}: invalid prepared image ownership`);
  return value;
}
function records(issues: string[], checkout?: string): { path: string; record: ImageRecord }[] {
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

/** Inspect recorded ownership. Docker protects all container references, including stopped containers. */
export function inspectPreparedImages(checkout?: string, references?: ReadonlySet<string>): LocalImageReport {
  const report: LocalImageReport = { location: "local", entries: [], issues: [] };
  const owned = records(report.issues, checkout).filter(
    ({ record }) => !references || references.has(record.reference),
  );
  if (!owned.length) return report;
  try {
    const listed = new Set(
      run("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"]).split("\n").filter(Boolean),
    );
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
      const lock = imageProfileLock(record.checkout, record.profile);
      let reason: ImageProtection | undefined;
      if (image.Id !== record.image || image.Config.Labels?.["org.workbench.inputs"] !== record.inputs)
        reason = "changed";
      else {
        if (!attached.has(record.image))
          attached.set(
            record.image,
            Boolean(run("docker", ["ps", "--all", "--quiet", "--filter", `ancestor=${record.image}`])),
          );
        reason = attached.get(record.image) ? "attached" : existsSync(`${lock}.lock`) ? "locked" : undefined;
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
        ...(record.verified ? { verified: record.verified } : {}),
        ...imageProtection(reason),
      });
    }
  } catch (error) {
    report.issues.push(error instanceof Error ? error.message : String(error));
  }
  return report;
}
