import { runOwnedChild, captureOwnedChild } from "../scripts/owned-child.mjs";
import { processFailure } from "../scripts/process-outcome.mjs";
import { combineFailures } from "../scripts/diagnostic-errors.mjs";
import { AcquisitionRejected } from "../scripts/network-retry.mts";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Transform, Writable, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { artifactProof } from "./artifact-proofs.js";
import { commandInvocation } from "./tool-execution.js";
import { required } from "./invariants.js";
import type { ArtifactSource } from "./artifact-streams.js";
import { verifiedSignatureStatus } from "./signature-status.js";

export interface ArtifactSignature extends ArtifactSource {
  keys: string;
  signers: string[];
}

export interface SignedChecksums extends ArtifactSource {
  subject: string;
  signature: ArtifactSignature;
}

/** Verify the publisher's signed catalog before using its artifact digest. */
export async function authenticateChecksums(
  metadata: SignedChecksums,
  digest: string,
  signal: AbortSignal,
): Promise<void> {
  const bytes = await authenticateCatalog(metadata, signal);
  const entries = bytes
    .toString("utf8")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line);
      return match?.[2] === metadata.subject ? [match[1]?.toLowerCase()] : [];
    });
  if (entries.length !== 1 || entries[0] !== digest)
    throw new Error("signed checksum catalog does not bind the expected filename and digest");
}

/** Signed repository catalogs use their own checksum grammar after authenticating these bytes. */
export async function authenticateCatalog(
  metadata: Pick<SignedChecksums, "url" | "backupUrls" | "signature">,
  signal: AbortSignal,
): Promise<Buffer> {
  const proof = await artifactProof(
    metadata.url,
    2 * 1024 ** 2,
    "signed checksum catalog",
    signal,
    metadata.backupUrls,
  );
  const { bytes } = proof;
  const verifier = await signatureVerifier(metadata.signature, signal);
  try {
    await pipeline(
      Readable.from([bytes]),
      verifier.relay,
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      { signal },
    );
    await verifier.finish();
    proof.accept();
  } finally {
    await verifier.cancel();
  }
  return bytes;
}

/** OpenPGP consumes the original HTTP bytes concurrently with extraction; no archive spool is needed. */
export async function signatureVerifier(signature: ArtifactSignature, signal: AbortSignal) {
  if (!signature.signers.length || signature.signers.some((signer) => !/^[A-F0-9]{40}(?:[A-F0-9]{24})?$/.test(signer)))
    throw new Error("artifact signature requires pinned full signer fingerprints");
  const home = mkdtempSync(join(realpathSync.native(tmpdir()), "workbench-authentication-"));
  const retained = (cause: unknown) =>
    new Error(`Signature verifier drainage is unproven; preserving authentication state: ${home}`, { cause });
  let preserve = false;
  try {
    const keys = join(home, "keys.asc");
    writeFileSync(keys, signature.keys, { mode: 0o600 });
    const proof = await artifactProof(signature.url, 64 * 1024, "artifact signature", signal, signature.backupUrls);
    writeFileSync(join(home, "artifact.sig"), proof.bytes, { mode: 0o600 });
    const arguments_ = ["--batch", "--no-options", "--homedir", ".", "--no-auto-key-retrieve", "--no-autostart"];
    preserve = true;
    const imported = await captureOwnedChild(
      "gpg",
      [...arguments_, "--dearmor", "--output", "keys.gpg", "keys.asc"],
      {
        cwd: home,
        env: process.env,
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        stopDescendantsOnExit: true,
      },
      64 * 1024,
    );
    preserve = imported.descendantsActive === true;
    const importFailure = processFailure("GnuPG key preparation", imported);
    if (preserve) throw importFailure ?? new Error("GnuPG key preparation left active or unconfirmed descendants");
    if (importFailure) throw importFailure;
    // Relative verifier paths also work under Git Bash, where drive-letter keyring paths are ambiguous.
    const invocation = commandInvocation(
      "gpg",
      [
        ...arguments_,
        "--no-default-keyring",
        "--keyring",
        "./keys.gpg",
        "--status-fd",
        "2",
        "--verify",
        "artifact.sig",
        "-",
      ],
      process.env,
      home,
    );
    const input = new PassThrough();
    const controller = new AbortController();
    let status = Buffer.alloc(0),
      failure: Error | undefined;
    const completed = runOwnedChild(
      required(invocation[0], "signature verification needs a command"),
      invocation.slice(1),
      {
        cwd: home,
        env: process.env,
        signal: AbortSignal.any([signal, controller.signal]),
        stopDescendantsOnExit: true,
        input,
        output: (out, err) => {
          out.resume();
          err.on("data", (chunk: Buffer) => {
            const remaining = 64 * 1024 - status.length;
            status = Buffer.concat([status, chunk.subarray(0, Math.max(0, remaining))]);
            if (chunk.length > remaining) {
              failure ??= new Error("signature verifier output exceeds its limit");
              controller.abort();
            }
          });
        },
      },
    );
    const relay = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        input.write(chunk, (error) => {
          if (error)
            callback(new AcquisitionRejected("upstream artifact signature verification failed", { cause: error }));
          else callback(undefined, chunk);
        });
      },
      flush(callback) {
        input.end();
        callback();
      },
    });
    let cancelled: Promise<void> | undefined;
    return {
      relay,
      async finish() {
        const outcome = await completed;
        failure ??= signal.aborted
          ? new Error("artifact signature verification cancelled")
          : processFailure("upstream artifact signature verification", outcome);
        if (failure)
          throw new AcquisitionRejected(
            `${failure.message}${status.length ? `\n${status.toString("utf8").trim().slice(-8192)}` : ""}`,
            { cause: failure },
          );
        const evidence = verifiedSignatureStatus(status.toString("utf8"), signature.signers);
        proof.accept({ verifiedAt: new Date().toISOString(), signatures: evidence });
        return evidence;
      },
      cancel() {
        cancelled ??= (async () => {
          controller.abort();
          input.destroy();
          let outcome: Awaited<typeof completed>;
          try {
            outcome = await completed;
          } catch (error) {
            throw retained(error);
          }
          if (outcome.descendantsActive)
            throw retained(outcome.error ?? new Error("Signature verifier descendants remain active"));
          rmSync(home, { recursive: true, force: true });
        })();
        return cancelled;
      },
    };
  } catch (error) {
    if (preserve) throw retained(error);
    try {
      rmSync(home, { recursive: true, force: true });
    } catch (cleanup) {
      throw combineFailures(error, cleanup, "Signature verification and cleanup failed");
    }
    throw error;
  }
}
