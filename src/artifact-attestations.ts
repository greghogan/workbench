import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { Verifier, toSignedEntity, toTrustMaterial } from "@sigstore/verify";
import { artifactResponse } from "./artifact-streams.js";

export interface ArtifactAttestation {
  url: string;
  signer: string;
  subject: string;
  roots: string;
  release?: { repository: string; tag: string };
}

/** Authenticate a signed digest statement; streaming acquisition must still match that digest. */
export function verifyAttestation(
  text: string,
  digest: string,
  metadata: Pick<ArtifactAttestation, "signer" | "subject" | "roots" | "release">,
): void {
  if (text.length > 2 * 1024 ** 2) throw new Error("artifact attestation exceeds its size limit");
  let records: unknown[];
  try {
    const document = JSON.parse(text) as { attestations?: { bundle: unknown }[] };
    records = Array.isArray(document.attestations) ? document.attestations.map((entry) => entry.bundle) : [document];
  } catch {
    records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
  }
  const roots = metadata.roots
    .trim()
    .split("\n")
    .map((line) => TrustedRoot.fromJSON(JSON.parse(line)));
  const identity = `^${metadata.signer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  let lastError: unknown;
  for (const record of records) {
    const bundle = bundleFromJSON(record);
    if (bundle.content.$case !== "dsseEnvelope") continue;
    for (const root of roots) {
      try {
        if (!root.tlogs.length && !root.timestampAuthorities.length)
          throw new Error("attestation trust root has no trusted timestamp authority");
        const verifier = new Verifier(toTrustMaterial(root), {
          ctlogThreshold: root.ctlogs.length ? 1 : 0,
          tlogThreshold: root.tlogs.length ? 1 : 0,
          tsaThreshold: root.tlogs.length ? 0 : 1,
        });
        verifier.verify(toSignedEntity(bundle), {
          subjectAlternativeName: identity,
          ...(metadata.release ? {} : { extensions: { issuer: "https://token.actions.githubusercontent.com" } }),
        });
        const statement = JSON.parse(Buffer.from(bundle.content.dsseEnvelope.payload).toString("utf8")) as {
          _type: string;
          predicateType: string;
          subject: { name: string; digest: { sha256?: string } }[];
          predicate?: { repository?: string; tag?: string };
        };
        if (
          statement._type !== "https://in-toto.io/Statement/v1" ||
          statement.predicateType !==
            (metadata.release ? "https://in-toto.io/attestation/release/v0.2" : "https://slsa.dev/provenance/v1")
        )
          throw new Error("artifact attestation has an unexpected statement type");
        if (
          metadata.release &&
          (metadata.signer !== "https://dotcom.releases.github.com" ||
            statement.predicate?.repository !== metadata.release.repository ||
            statement.predicate.tag !== metadata.release.tag)
        )
          throw new Error("release attestation does not bind the expected repository and tag");
        if (!statement.subject.some((subject) => subject.name === metadata.subject && subject.digest.sha256 === digest))
          throw new Error("artifact attestation does not bind the expected filename and digest");
        return;
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw new Error("upstream artifact attestation verification failed", { cause: lastError });
}

export async function authenticateAttestation(
  metadata: ArtifactAttestation,
  digest: string,
  signal?: AbortSignal,
): Promise<void> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of await artifactResponse(metadata.url, signal)) {
    length += (chunk as Buffer).length;
    if (length > 2 * 1024 ** 2) throw new Error("artifact attestation exceeds its size limit");
    chunks.push(chunk as Buffer);
  }
  verifyAttestation(Buffer.concat(chunks).toString("utf8"), digest, metadata);
}
