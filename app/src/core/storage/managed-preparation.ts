import { closeSync, fsyncSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { describeError } from "../diagnostics/diagnostic-errors.mjs";
import { builderOwner, type StoreManager } from "../execution/environments/managed/managed-contract.mjs";
import { readBoundedFile } from "../runtime/file-reads.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { ownedPath } from "../runtime/paths.js";
import { isRecord } from "../runtime/values.mjs";
import { userDirectory } from "./storage.js";

interface ManagedPreparation {
  checkout: string;
  profile: string;
  architecture: string;
  inputs: string;
  builder: StoreManager;
  key: string;
}

function preparation(value: unknown): ManagedPreparation {
  if (
    !isRecord(value) ||
    typeof value.checkout !== "string" ||
    !isAbsolute(value.checkout) ||
    typeof value.profile !== "string" ||
    !/^[a-z][a-z0-9_-]*$/.test(value.profile) ||
    (value.architecture !== "x64" && value.architecture !== "arm64") ||
    typeof value.inputs !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.inputs) ||
    (value.builder !== "nix" && value.builder !== "guix") ||
    typeof value.key !== "string" ||
    !/^[a-f0-9]{24}$/.test(value.key)
  )
    throw new Error("Invalid managed preparation receipt");
  const { checkout, profile, architecture, inputs, builder, key } = value;
  return { checkout, profile, architecture, inputs, builder, key };
}

export function managedPreparationIdentity(value: ManagedPreparation): string {
  return builderOwner(
    JSON.stringify([value.checkout, value.profile, value.architecture, value.inputs, value.builder, value.key]),
  );
}

const basePath = "managed-preparations";
const receiptPath = (value: ManagedPreparation): string =>
  ownedPath(
    userDirectory("cache"),
    `${basePath}/${builderOwner(value.checkout)}/${managedPreparationIdentity(value)}.json`,
  );

/** Synchronize the evidence and its containing directories before the next store mutation. */
export function publishManagedReceipt(path: string, contents: string): void {
  writeAtomic(
    path,
    (fd) => {
      writeFileSync(fd, contents);
      fsyncSync(fd);
    },
    0o600,
  );
  if (process.platform === "win32") return;
  const parent = dirname(path);
  for (const directory of [parent, dirname(parent), dirname(dirname(parent))]) {
    const fd = openSync(directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

/** Publish ownership before the Docker builder can install roots in its store. */
export function recordManagedPreparation(scope: unknown): void {
  const value = preparation(scope);
  publishManagedReceipt(receiptPath(value), JSON.stringify({ version: 1, ...value }) + "\n");
}

/** Once the image catalog binds the roots to a concrete image, it supplies the recovery evidence. */
export function completeManagedPreparation(value: ManagedPreparation): void {
  rmSync(receiptPath(value), { force: true });
}

export function pendingManagedPreparations(checkout: string | undefined, issues: string[]) {
  const cache = userDirectory("cache");
  const children = (subdirectory: string, pattern: RegExp) => {
    try {
      return readdirSync(ownedPath(cache, subdirectory)).filter((entry) => pattern.test(entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push(describeError(error));
      return [];
    }
  };
  const owners = checkout ? [builderOwner(checkout)] : children(basePath, /^[a-f0-9]{64}$/);
  return owners.flatMap((owner) => {
    const directory = `${basePath}/${owner}`;
    return children(directory, /^[a-f0-9]{64}\.json$/).flatMap((name) => {
      try {
        const path = ownedPath(cache, `${directory}/${name}`);
        const raw: unknown = JSON.parse(readBoundedFile(path, 16 * 1024, "managed preparation").toString());
        const value = preparation(raw);
        if (
          !isRecord(raw) ||
          raw.version !== 1 ||
          path !== receiptPath(value) ||
          (checkout && value.checkout !== checkout)
        )
          throw new Error(`${path}: managed preparation receipt does not match its owner`);
        return [{ path, value }];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push(describeError(error));
        return [];
      }
    });
  });
}
