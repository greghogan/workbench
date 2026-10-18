import { artifactProof } from "./artifact-proofs.js";

export interface ArtifactAttestation {
  url: string;
  signer: string;
  subject: string;
  roots: string;
  release?: { repository: string; tag: string };
}

export async function authenticateAttestation(
  metadata: ArtifactAttestation,
  digest: string,
  signal?: AbortSignal,
): Promise<void> {
  const proof = await artifactProof(metadata.url, 2 * 1024 ** 2, "artifact attestation", signal);
  const { verifyAttestation } = await import("./attestation-verification.js");
  verifyAttestation(proof.bytes.toString("utf8"), digest, metadata);
  proof.accept();
}
