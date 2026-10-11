import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { artifactResponse } from "./artifact-streams.js";
import { commandInvocation, execute } from "./tool-downloads.js";
import { required } from "./invariants.js";

export interface ArtifactSignature {
  url: string;
  keys: string;
  signers: string[];
}

export interface SignedChecksums {
  url: string;
  subject: string;
  signature: ArtifactSignature;
}

/** Verify the publisher's signed catalog before using its artifact digest. */
export async function authenticateChecksums(
  metadata: SignedChecksums,
  digest: string,
  staging: string,
  signal: AbortSignal,
): Promise<void> {
  const bytes = await authenticateCatalog(metadata, staging, signal);
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
  metadata: Pick<SignedChecksums, "url" | "signature">,
  staging: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of await artifactResponse(metadata.url, signal)) {
    length += (chunk as Buffer).length;
    if (length > 2 * 1024 ** 2) throw new Error("signed checksum catalog exceeds its size limit");
    chunks.push(chunk as Buffer);
  }
  const bytes = Buffer.concat(chunks);
  const verifier = await signatureVerifier(metadata.signature, staging, signal);
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
  } finally {
    await verifier.cancel();
  }
  return bytes;
}

/** OpenPGP consumes the original HTTP bytes concurrently with extraction; no archive spool is needed. */
export async function signatureVerifier(signature: ArtifactSignature, staging: string, signal: AbortSignal) {
  if (!signature.signers.length || signature.signers.some((signer) => !/^[A-F0-9]{40,64}$/.test(signer)))
    throw new Error("artifact signature requires pinned full signer fingerprints");
  const home = mkdtempSync(join(resolve(staging), ".authentication-"));
  const keys = join(home, "keys.asc");
  writeFileSync(keys, signature.keys, { mode: 0o600 });
  const signaturePath = join(home, "artifact.sig");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of await artifactResponse(signature.url, signal)) {
    bytes += (chunk as Buffer).length;
    if (bytes > 64 * 1024) throw new Error("artifact signature exceeds its size limit");
    chunks.push(chunk as Buffer);
  }
  writeFileSync(signaturePath, Buffer.concat(chunks), { mode: 0o600 });
  const arguments_ = ["--batch", "--no-options", "--homedir", ".", "--no-auto-key-retrieve", "--no-autostart"];
  // A dedicated read-only keyring avoids importing keys or consulting an agent socket.
  execute("gpg", [...arguments_, "--dearmor", "--output", "keys.gpg", "keys.asc"], {
    cwd: home,
    capture: true,
    timeout: 30_000,
  });
  // GnuPG under Git Bash misinterprets drive-letter home/keyring paths.
  // Resolve verifier paths within its private working directory instead.
  arguments_.push("--no-default-keyring", "--keyring", "./keys.gpg", "--no-auto-check-trustdb");
  const invocation = commandInvocation("gpg", [...arguments_, "--status-fd", "2", "--verify", "artifact.sig", "-"]);
  const child = spawn(required(invocation[0], "signature verification needs a command"), invocation.slice(1), {
    cwd: home,
    stdio: ["pipe", "ignore", "pipe"],
  });
  let status = "";
  let failure: Error | undefined;
  child.stderr.on("data", (chunk: Buffer) => {
    status += chunk.toString("utf8");
    if (status.length > 64 * 1024) {
      failure = new Error("signature verifier output exceeds its limit");
      child.kill();
    }
  });
  child.stdin.on("error", () => {
    /* The relay reports write failures; cancellation may close stdin first. */
  });
  const completed = new Promise<void>((resolve) => {
    child.on("error", (error) => {
      failure = error;
      resolve();
    });
    child.on("close", (code) => {
      if (code !== 0) failure ??= new Error("upstream artifact signature verification failed");
      resolve();
    });
  });
  const abort = () => {
    failure ??= new Error("artifact signature verification cancelled");
    child.kill();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const verificationFailure = () =>
    new Error(
      `${failure?.message ?? "upstream artifact signature verification failed"}${status ? `\n${status.trim().slice(-8192)}` : ""}`,
      { cause: failure },
    );
  return {
    relay: new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        child.stdin.write(chunk, (error) => {
          if (error) {
            failure ??= new Error("upstream artifact signature verification failed", { cause: error });
            child.kill();
            void completed.then(() => {
              callback(verificationFailure());
            });
          } else callback(undefined, chunk);
        });
      },
      flush(callback) {
        child.stdin.end();
        callback();
      },
    }),
    async finish() {
      await completed;
      signal.removeEventListener("abort", abort);
      if (failure) throw verificationFailure();
      const valid = [...status.replaceAll("\r", "").matchAll(/^\[GNUPG:\] VALIDSIG ([A-F0-9]+) .+$/gm)];
      if (
        !valid.some(
          (match) =>
            signature.signers.includes(match[1] ?? "") || signature.signers.includes(match[0].split(" ").at(-1) ?? ""),
        )
      )
        throw new Error("artifact signature signer is not an approved fingerprint");
    },
    async cancel() {
      child.kill();
      await completed;
      signal.removeEventListener("abort", abort);
    },
  };
}
