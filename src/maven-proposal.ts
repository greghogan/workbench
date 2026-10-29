import { existsSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { mavenChecksums, mavenDigest, verifyMavenArtifact, retainMavenArtifacts } from "./maven-artifacts.js";
import {
  acquisitionInputs,
  decodeMavenAuthentication,
  mavenEvidenceAuthorized,
  type MavenAuthentication,
} from "./maven-policy.js";
import { readMavenMetadata, optionalMavenMetadata, mavenMetadataLimit, assertMavenFiles } from "./maven-files.js";
import { processCancellation } from "../scripts/owned-child.mjs";
import { settleCleanup } from "../scripts/diagnostic-errors.mjs";
import { publishCheckedFiles } from "../scripts/file-publication.mjs";
import { isRecord } from "../scripts/values.mjs";
import { withCacheLocksSync } from "./cache-lock.js";
import { BoundedState } from "./bounded-state.js";
import { userDirectory } from "./storage.js";
import { withToolCacheUseAsync } from "./tool-cache-lock.js";
import { mavenWorkspaceExternalChecksums, assertMavenWorkspaceExternalCoordinates } from "./maven-workspace.js";
interface Activation {
  pom: string;
  policy: string;
  files: { name: "authentication.json" | "checksums.sha256"; before: string | null; after: string }[];
}
function activationPath(root: string): string {
  return join(
    userDirectory("state"),
    "maven-activations",
    createHash("sha256").update(realpathSync(root)).digest("hex") + ".json",
  );
}
function activationStore(root: string) {
  return new BoundedState<Activation | null>(
    () => activationPath(root),
    mavenMetadataLimit,
    (input) => {
      if (input === null) return null;
      if (
        !isRecord(input) ||
        typeof input.pom !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.pom) ||
        typeof input.policy !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.policy) ||
        !Array.isArray(input.files) ||
        input.files.length !== 2
      )
        throw new Error("Invalid Maven activation recovery record");
      const files = (input.files as unknown[]).map((file): Activation["files"][number] => {
        if (
          !isRecord(file) ||
          (file.name !== "authentication.json" && file.name !== "checksums.sha256") ||
          (file.before !== null && typeof file.before !== "string") ||
          typeof file.after !== "string"
        )
          throw new Error("Invalid Maven activation recovery file");
        return { name: file.name, before: file.before, after: file.after };
      });
      if (new Set(files.map((file) => file.name)).size !== 2) throw new Error("Duplicate Maven recovery output");
      return { pom: input.pom, policy: input.policy, files };
    },
    () => null,
  );
}
function finishActivation(root: string): void {
  const pending = activationStore(root).read();
  if (!pending) return;
  const checkInputs = () => {
    const inputs = acquisitionInputs(root);
    if (pending.pom !== mavenDigest(inputs.pom) || pending.policy !== inputs.policy)
      throw new Error(
        `Maven activation recovery requires reconciliation of changed project inputs: ${activationPath(root)}`,
      );
  };
  checkInputs();
  const files = pending.files.map((file) => {
    const path = join(root, ".mvn/checksums", file.name),
      current = optionalMavenMetadata(path)?.toString("utf8") ?? null;
    if (current !== file.before && current !== file.after)
      throw new Error(
        `Maven activation recovery conflicts with ${path}; preserve changes and reconcile ${activationPath(root)}`,
      );
    return { path, contents: file.after, expected: current === null ? undefined : Buffer.from(current), mode: 0o644 };
  });
  publishCheckedFiles(files, checkInputs);
  rmSync(activationPath(root));
}
export function recoverMavenAcceptance(root: string): void {
  withCacheLocksSync([activationPath(root)], () => {
    finishActivation(root);
  });
}

/** Decode metadata once; byte verification occurs at its consuming boundary. */
function readMavenProposal(root: string, proposal: string) {
  const source = resolve(proposal),
    proposed = readMavenMetadata(join(source, "checksums.sha256")),
    checksums = mavenChecksums(proposed.toString("utf8")),
    inputs = acquisitionInputs(root),
    authentication = decodeMavenAuthentication(
      JSON.parse(readMavenMetadata(join(source, "authentication.json")).toString("utf8")),
    );
  if (
    authentication.checksumSHA256 !== mavenDigest(proposed) ||
    authentication.pom !== mavenDigest(inputs.pom) ||
    authentication.policy !== inputs.policy ||
    authentication.artifacts.length !== checksums.size
  )
    throw new Error("Maven proposal is stale or incomplete; prepare it again");
  if (authentication.resolver !== inputs.config.resolver) throw new Error("Maven proposal resolver is invalid");
  const reviewed = inputs.workspace
    ? mavenWorkspaceExternalChecksums(inputs.workspace)
    : inputs.frozen
      ? mavenChecksums(inputs.frozen.toString("utf8"))
      : new Map<string, string>();
  const current = inputs.frozen ? mavenDigest(inputs.frozen) : null;
  if (current !== authentication.previousChecksums && current !== authentication.checksumSHA256)
    throw new Error("Maven checksum index changed after preparation; reconcile it before activation");
  if (inputs.workspace) assertMavenWorkspaceExternalCoordinates(inputs.workspace, checksums);
  for (const artifact of authentication.artifacts) {
    if (checksums.get(artifact.path) !== artifact.sha256)
      throw new Error("Maven proposal artifact identity is inconsistent or duplicated");
    if (artifact.authentication === "reviewed-pin") {
      if (
        artifact.identity !== "Previously reviewed project checksum" ||
        reviewed.get(artifact.path) !== artifact.sha256
      )
        throw new Error("Maven reviewed-pin evidence does not match a previously reviewed project checksum");
    } else if (!mavenEvidenceAuthorized(artifact, inputs.config))
      throw new Error("Maven authentication evidence does not match the declared trust policy");
  }
  return { source, authentication, proposed, checksums, inputs };
}
function activationRecord(
  root: string,
  authentication: MavenAuthentication,
  proposed: Buffer,
  previous: Buffer | undefined,
): Activation {
  const directory = join(root, ".mvn/checksums");
  const outputs = [
    ["authentication.json", JSON.stringify(authentication, null, 2) + "\n"],
    ["checksums.sha256", proposed.toString("utf8")],
  ] as const;
  const activation: Activation = {
    pom: authentication.pom,
    policy: authentication.policy,
    files: outputs.map(([name, after]) => ({
      name,
      after,
      before:
        (name === "checksums.sha256" ? previous : optionalMavenMetadata(join(directory, name)))?.toString("utf8") ??
        null,
    })),
  };
  if (Buffer.byteLength(JSON.stringify(activation, null, 2) + "\n") > mavenMetadataLimit)
    throw new Error("Maven proposal cannot fit the activation recovery record size limit");
  return activation;
}
/** Explicit activation checks the proposal still describes this POM and the exact retained bytes. */
export async function acceptMavenDependencies(root: string, proposal: string, signal?: AbortSignal): Promise<void> {
  const cancellation = processCancellation(),
    active = signal ? AbortSignal.any([cancellation.signal, signal]) : cancellation.signal;
  let failure: unknown;
  try {
    active.throwIfAborted();
    await withToolCacheUseAsync(async () => {
      recoverMavenAcceptance(root);
      const { source, authentication, proposed, checksums, inputs } = readMavenProposal(root, proposal);
      // Refuse an unrepresentable transaction before copying any potentially large artifact bytes.
      const activation = activationRecord(root, authentication, proposed, inputs.frozen);
      await retainMavenArtifacts(
        join(source, "repository"),
        process.env.WORKBENCH_MAVEN_REPOSITORY ?? join(userDirectory("cache"), "downloads", "maven"),
        checksums,
        active,
      );
      active.throwIfAborted();
      withCacheLocksSync([activationPath(root)], () => {
        assertMavenFiles(inputs.files);
        assertMavenFiles(
          activation.files.map((file) => ({
            path: join(root, ".mvn/checksums", file.name),
            bytes: file.before === null ? undefined : Buffer.from(file.before),
          })),
        );
        active.throwIfAborted();
        mkdirSync(join(root, ".mvn/checksums"), { recursive: true });
        activationStore(root).write(activation);
        finishActivation(root);
      });
    });
  } catch (error) {
    failure = error;
  }
  await settleCleanup([cancellation.close], failure);
}

/** Maintenance resumes only after the operator or agent explicitly accepts the inspected proposal. */
export async function requireMavenProposalAcceptance(root: string, proposal: string): Promise<void> {
  recoverMavenAcceptance(root);
  const { authentication, proposed, source, checksums } = readMavenProposal(root, proposal);
  for (const path of checksums.keys()) await verifyMavenArtifact(join(source, "repository"), path, checksums);
  const index = join(root, ".mvn/checksums/checksums.sha256");
  const evidence = join(root, ".mvn/checksums/authentication.json");
  const bytes = optionalMavenMetadata(evidence);
  const accepted = bytes ? decodeMavenAuthentication(JSON.parse(bytes.toString("utf8"))) : undefined;
  if (
    !existsSync(index) ||
    !readMavenMetadata(index).equals(proposed) ||
    accepted?.pom !== authentication.pom ||
    accepted.policy !== authentication.policy ||
    accepted.checksumSHA256 !== authentication.checksumSHA256
  )
    throw new Error(
      `Maven proposal requires acceptance. Review ${source}, then from ${root} run workbench tools maven accept --proposal '${source}' and resume maintenance.`,
    );
}

/** Recheck the accepted lock at each qualification, including after an interrupted update resumes. */
export function requireAcceptedMavenInputs(root: string): void {
  recoverMavenAcceptance(root);
  const path = join(root, ".mvn/checksums/authentication.json");
  const bytes = optionalMavenMetadata(path);
  const accepted = bytes ? decodeMavenAuthentication(JSON.parse(bytes.toString("utf8"))) : undefined;
  const inputs = acquisitionInputs(root);
  if (
    accepted?.pom !== mavenDigest(inputs.pom) ||
    accepted.policy !== inputs.policy ||
    accepted.checksumSHA256 !== (inputs.frozen ? mavenDigest(inputs.frozen) : null)
  )
    throw new Error(
      "Maven inputs differ from the accepted proposal; review and accept the prepared inputs before qualification",
    );
}
