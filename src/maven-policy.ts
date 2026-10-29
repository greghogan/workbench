import { realpathSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import { safeRelative } from "./files.js";
import { isRecord } from "../scripts/values.mjs";
import { mavenDigest, mavenArtifactPath } from "./maven-artifacts.js";
import { decodeSignatureEvidence, type SignatureEvidence } from "./signature-status.js";
import { readMavenWorkspace, mavenWorkspaceIdentity } from "./maven-workspace.js";
import { readMavenMetadata, optionalMavenMetadata, type MavenFile } from "./maven-files.js";

interface RuleIdentity {
  prefix: string;
  identity: string;
}
export type TrustRule = RuleIdentity &
  ({ keys: string; signers: string[]; unavailable?: never } | { unavailable: string; keys?: never; signers?: never });
export interface MavenAcquisition {
  resolver: string;
  trust: TrustRule[];
  sources?: string[];
}
interface EvidenceIdentity {
  path: string;
  sha256: string;
  identity: string;
}
export type MavenEvidence = EvidenceIdentity &
  (
    | { authentication: "reviewed-pin"; proof?: never; signatures?: never; reason?: never }
    | { authentication: "signature"; proof: string; signatures: SignatureEvidence[]; reason?: never }
    | { authentication: "unavailable"; reason: string; proof?: never; signatures?: never }
  );
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();
export function decodeMavenAcquisition(value: unknown): MavenAcquisition {
  if (
    !isRecord(value) ||
    typeof value.resolver !== "string" ||
    !/^org\.apache\.maven\.plugins:maven-dependency-plugin:\d+\.\d+\.\d+:go-offline$/.test(value.resolver) ||
    !Array.isArray(value.trust) ||
    Object.keys(value).some((key) => !["resolver", "trust", "sources"].includes(key)) ||
    (value.sources !== undefined &&
      (!Array.isArray(value.sources) ||
        value.sources.some(
          (path: unknown) => typeof path !== "string" || !path.trim() || path.includes("\0") || isAbsolute(path),
        ) ||
        new Set(value.sources).size !== value.sources.length))
  )
    throw new Error(
      ".mvn/acquisition.json requires a pinned Maven dependency-plugin go-offline resolver and trust rules",
    );
  const prefixes = new Set<string>();
  const trust = (value.trust as unknown[]).map((rule): TrustRule => {
    if (
      !isRecord(rule) ||
      typeof rule.prefix !== "string" ||
      !/^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*\/$/.test(rule.prefix) ||
      rule.prefix.split("/").some((part) => part === "." || part === "..") ||
      prefixes.has(rule.prefix) ||
      !nonempty(rule.identity) ||
      Object.keys(rule).some((key) => !["prefix", "identity", "keys", "signers", "unavailable"].includes(key))
    )
      throw new Error(
        "Maven trust rules require unique repository prefixes and independently established publisher identities",
      );
    prefixes.add(rule.prefix);
    const identity = { prefix: rule.prefix, identity: rule.identity };
    if (rule.unavailable !== undefined) {
      if (!nonempty(rule.unavailable) || rule.keys !== undefined || rule.signers !== undefined)
        throw new Error("Unavailable Maven authentication requires a reason and cannot replace a declared signature");
      return { ...identity, unavailable: rule.unavailable };
    }
    if (
      !nonempty(rule.keys) ||
      !Array.isArray(rule.signers) ||
      !rule.signers.length ||
      rule.signers.some(
        (signer: unknown) => typeof signer !== "string" || !/^[A-F0-9]{40}(?:[A-F0-9]{24})?$/.test(signer),
      )
    )
      throw new Error("Maven signature rules require a project key file and approved full signer fingerprints");
    return { ...identity, keys: rule.keys, signers: rule.signers as string[] };
  });
  return {
    resolver: value.resolver,
    trust,
    ...(value.sources === undefined ? {} : { sources: value.sources as string[] }),
  };
}
export function acquisitionInputs(root: string) {
  const configuration = join(root, ".mvn/acquisition.json"),
    configurationBytes = readMavenMetadata(configuration),
    config = decodeMavenAcquisition(JSON.parse(configurationBytes.toString("utf8"))),
    pom = readMavenMetadata(join(root, "pom.xml")),
    frozen = optionalMavenMetadata(join(root, ".mvn/checksums/checksums.sha256"));
  const files: MavenFile[] = [
    { path: configuration, bytes: configurationBytes },
    { path: join(root, "pom.xml"), bytes: pom },
    { path: join(root, ".mvn/checksums/checksums.sha256"), bytes: frozen },
  ];
  const keys = new Map<string, string>(),
    canonical = realpathSync(root);
  for (const rule of config.trust) {
    if (!rule.keys || keys.has(rule.keys)) continue;
    const path = realpathSync(resolve(root, rule.keys));
    safeRelative(canonical, path);
    const bytes = readMavenMetadata(path);
    files.push({ path, bytes });
    keys.set(rule.keys, bytes.toString("utf8"));
  }
  const workspace = readMavenWorkspace(root, config.sources ?? [], undefined, { pom, checksums: frozen });
  for (const source of workspace?.sources ?? [])
    files.push(
      { path: join(source.root, "pom.xml"), bytes: source.pom },
      { path: join(source.root, ".mvn/checksums/checksums.sha256"), bytes: source.checksums },
    );
  const policy = mavenDigest(
    Buffer.from(
      JSON.stringify({
        config,
        keys: [...keys].map(([path, bytes]) => [path, mavenDigest(Buffer.from(bytes))]),
        ...(workspace ? { sources: mavenWorkspaceIdentity(workspace) } : {}),
      }),
    ),
  );
  return { root, config, keys, policy, workspace, pom, frozen, files };
}
export function mavenTrustRule(config: MavenAcquisition, path: string): TrustRule | undefined {
  return config.trust
    .filter((entry) => path.startsWith(entry.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
}
export function decodeMavenEvidence(value: unknown): MavenEvidence {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !nonempty(value.identity)
  )
    throw new Error("Maven proposal authentication evidence is incomplete");
  const base = { path: mavenArtifactPath(value.path), sha256: value.sha256, identity: value.identity };
  const allowed = ["path", "sha256", "identity", "authentication"];
  if (value.authentication === "signature") allowed.push("proof", "signatures");
  if (value.authentication === "unavailable") allowed.push("reason");
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unexpected Maven authentication evidence fields");
  switch (value.authentication) {
    case "reviewed-pin":
      return { ...base, authentication: "reviewed-pin" };
    case "unavailable":
      if (!nonempty(value.reason)) throw new Error("Maven authentication limitation requires a reason");
      return { ...base, authentication: "unavailable", reason: value.reason };
    case "signature": {
      if (
        !nonempty(value.proof) ||
        new URL(value.proof).protocol !== "https:" ||
        !Array.isArray(value.signatures) ||
        !value.signatures.length
      )
        throw new Error("Maven signature evidence is incomplete");
      return {
        ...base,
        authentication: "signature",
        proof: value.proof,
        signatures: (value.signatures as unknown[]).map(decodeSignatureEvidence),
      };
    }
    default:
      throw new Error("Unknown Maven authentication evidence");
  }
}

export interface MavenAuthentication {
  schema: 1;
  checksumSHA256: string;
  preparedAt: string;
  pom: string;
  policy: string;
  previousChecksums: string | null;
  resolver: string;
  artifacts: MavenEvidence[];
}
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
/** Decode historical and current records alike; callers separately check the required input bindings. */
export function decodeMavenAuthentication(value: unknown): MavenAuthentication {
  if (
    !isRecord(value) ||
    value.schema !== 1 ||
    !digest(value.checksumSHA256) ||
    !digest(value.pom) ||
    !digest(value.policy) ||
    (value.previousChecksums !== null && !digest(value.previousChecksums)) ||
    typeof value.preparedAt !== "string" ||
    !Number.isFinite(Date.parse(value.preparedAt)) ||
    typeof value.resolver !== "string" ||
    !/^org\.apache\.maven\.plugins:maven-dependency-plugin:\d+\.\d+\.\d+:go-offline$/.test(value.resolver) ||
    !Array.isArray(value.artifacts) ||
    Object.keys(value).some(
      (key) =>
        ![
          "schema",
          "checksumSHA256",
          "preparedAt",
          "pom",
          "policy",
          "previousChecksums",
          "resolver",
          "artifacts",
        ].includes(key),
    )
  )
    throw new Error("Invalid Maven authentication record");
  const artifacts = (value.artifacts as unknown[]).map(decodeMavenEvidence);
  if (new Set(artifacts.map((entry) => entry.path)).size !== artifacts.length)
    throw new Error("Maven proposal artifact identity is inconsistent or duplicated");
  return {
    schema: 1,
    checksumSHA256: value.checksumSHA256,
    pom: value.pom,
    policy: value.policy,
    preparedAt: value.preparedAt,
    previousChecksums: value.previousChecksums,
    resolver: value.resolver,
    artifacts,
  };
}
export function mavenEvidenceAuthorized(artifact: MavenEvidence, config: MavenAcquisition): boolean {
  const rule = mavenTrustRule(config, artifact.path);
  if (rule?.identity !== artifact.identity) return false;
  switch (artifact.authentication) {
    case "signature":
      return (
        !!rule.keys &&
        artifact.signatures.every(
          (signature) =>
            rule.signers.includes(signature.fingerprint) || rule.signers.includes(signature.primaryFingerprint),
        )
      );
    case "unavailable":
      return rule.unavailable === artifact.reason;
    case "reviewed-pin":
      return false;
  }
}
/** Exact reviewed pins remain valid; reuse earlier provenance only while the consumer's policy authorizes it. */
export function retainedMavenEvidence(
  inputs: ReturnType<typeof acquisitionInputs>,
  known: ReadonlyMap<string, string>,
): Map<string, MavenEvidence> {
  const retained = new Map<string, MavenEvidence>();
  const modules = inputs.workspace
    ? [inputs.workspace.consumer, ...inputs.workspace.sources]
    : [{ root: inputs.root, checksums: inputs.frozen }];
  for (const module of modules) {
    const path = join(module.root, ".mvn/checksums/authentication.json"),
      bytes = optionalMavenMetadata(path);
    inputs.files.push({ path, bytes });
    if (!module.checksums || !bytes) continue;
    const previous = decodeMavenAuthentication(JSON.parse(bytes.toString("utf8")));
    if (previous.checksumSHA256 !== mavenDigest(module.checksums)) continue;
    for (const artifact of previous.artifacts)
      if (
        !retained.has(artifact.path) &&
        known.get(artifact.path) === artifact.sha256 &&
        mavenEvidenceAuthorized(artifact, inputs.config)
      )
        retained.set(artifact.path, artifact);
  }
  return retained;
}
