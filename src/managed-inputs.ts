import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readText } from "./core.js";

export type { ManagedSource } from "../scripts/managed-source-contract.mjs";
import { managedDeclaration, type ManagedDeclaration } from "../scripts/managed-source-contract.mjs";
export interface ManagedInputRepository {
  directory: string;
  declaration: ManagedDeclaration;
}

/** The environment selects a realized package; current language declarations must still match it. */
export function managedInputRepository(directory: string): ManagedInputRepository | undefined {
  const selected = process.env.WORKBENCH_CHECK_INPUTS;
  if (!selected) return undefined;
  if (!isAbsolute(selected)) throw new Error("Managed check inputs require an absolute package location");
  directory = process.env.WORKBENCH_CHECK_INPUT_ROOT ?? directory;
  const root = realpathSync(selected);
  const declaration = managedDeclaration(JSON.parse(readText(join(root, "manifest.json"))));
  for (const [file, expected] of Object.entries(declaration.source_hashes)) {
    if (!file || isAbsolute(file) || file.split(/[\\/]/).some((part) => !part || part === ".." || part === "."))
      throw new Error("Invalid managed check-input source path");
    if (
      createHash("sha256")
        .update(readFileSync(join(directory, file)))
        .digest("hex") !== expected
    )
      throw new Error(`${file}: managed check inputs are stale; regenerate and rebuild the selected environment`);
  }
  return { directory: root, declaration };
}

/** Managers receive declared local artifacts; a missing source never authorizes a network fallback. */
export function managedInputSource(repository: ManagedInputRepository, url: string, integrity?: string): string {
  const platform = `linux-${process.arch}`;
  const entries = repository.declaration.inputs.filter(
    (entry) =>
      entry.url === url &&
      (!entry.platforms || entry.platforms.includes(platform)) &&
      (!integrity || entry.hash === integrity),
  );
  if (!entries.length || new Set(entries.map((entry) => entry.hash)).size !== 1)
    throw new Error(`Missing or ambiguous declared managed source: ${url}`);
  const entry = entries[0];
  if (
    !entry?.destination ||
    isAbsolute(entry.destination) ||
    entry.destination.split(/[\\/]/).some((part) => !part || part === ".." || part === ".")
  )
    throw new Error("Invalid managed artifact destination");
  const file = resolve(repository.directory, entry.destination);
  const match = /^(sha256|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(entry.hash);
  if (
    !match ||
    !existsSync(file) ||
    createHash(match[1] ?? "")
      .update(readFileSync(file))
      .digest("base64") !== match[2]
  )
    throw new Error(`Managed input integrity verification failed: ${entry.destination}`);
  return file;
}

interface BootstrapProof {
  name: string;
  version: string;
  integrity: string;
  signer: string;
  subject: string;
  bundle: unknown;
}
export interface ManagedBootstrap {
  schema_version: number;
  package_json: { dependencies: Record<string, string> };
  package_lock: {
    packages: Record<
      string,
      { version?: string; resolved?: string; integrity?: string; os?: string[]; cpu?: string[]; libc?: string[] }
    >;
  };
  proofs: BootstrapProof[];
}

export function managedBootstrap(repository: ManagedInputRepository): ManagedBootstrap {
  if (!repository.declaration.bootstrap) throw new Error("Managed inputs do not declare the package-manager bootstrap");
  const bytes = readFileSync(join(repository.directory, "bootstrap.json"));
  if (
    createHash("sha256").update(bytes).digest("hex") !== repository.declaration.source_hashes["managed-bootstrap.json"]
  )
    throw new Error("Managed bootstrap metadata does not match its declared source");
  const bootstrap = JSON.parse(bytes.toString("utf8")) as Partial<ManagedBootstrap>;
  if (bootstrap.schema_version !== 1 || !bootstrap.package_lock?.packages || !Array.isArray(bootstrap.proofs))
    throw new Error("Invalid managed package-manager bootstrap");
  return bootstrap as ManagedBootstrap;
}

export async function verifiedBootstrapSources(
  repository: ManagedInputRepository,
  distribution: string,
): Promise<string[]> {
  const bootstrap = managedBootstrap(repository);
  const { verifyAttestation } = await import("./attestation-verification.js");
  const roots = readText(join(distribution, "scripts/keys/sigstore-trusted-root.jsonl"));
  const sources = [];
  for (const [path, entry] of Object.entries(bootstrap.package_lock.packages)) {
    if (
      !path ||
      (entry.os && !entry.os.includes("linux")) ||
      (entry.cpu && !entry.cpu.includes(process.arch)) ||
      (entry.libc && !entry.libc.includes("glibc"))
    )
      continue;
    const name = path.replace(/^node_modules\//, "");
    const proof = bootstrap.proofs.find((proof) => proof.name === name && proof.version === entry.version);
    if (!proof) throw new Error(`Managed bootstrap has no provenance for ${name}`);
    const digest = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(proof.integrity)?.[1];
    if (!digest) throw new Error(`Unsupported bootstrap package digest: ${proof.name}`);
    verifyAttestation(
      JSON.stringify(proof.bundle),
      Buffer.from(digest, "base64").toString("hex"),
      {
        signer: proof.signer,
        subject: proof.subject,
        roots,
      },
      "sha512",
    );
    if (entry.version !== proof.version || entry.integrity !== proof.integrity || !entry.resolved)
      throw new Error(`Bootstrap proof does not match the locked package: ${proof.name}`);
    sources.push(managedInputSource(repository, entry.resolved, entry.integrity));
  }
  if (!sources.length) throw new Error("Managed package-manager bootstrap has no verified sources");
  return sources;
}
