import { writeDiagnosticText } from "../scripts/diagnostics.mjs";
import {
  retryNetwork,
  retryableNetworkFailure,
  networkResponse,
  rejectNetworkResponse,
  AcquisitionRejected,
  releaseNetworkResponse,
} from "../scripts/network-retry.mts";
import { DiagnosticOperation } from "./diagnostics.js";
import { createHash, type Hash } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { createReadStream } from "node:fs";
import { managedInputRepository, managedInputSource } from "./managed-inputs.js";

export interface ArtifactLimits {
  compressed: number;
  decompressed: number;
  retained: number;
  file: number;
  entries: number;
  metadata: number;
  windowLog: number;
  milliseconds: number;
}

export const artifactLimits: ArtifactLimits = {
  compressed: 4 * 1024 ** 3,
  decompressed: 24 * 1024 ** 3,
  retained: 4 * 1024 ** 3,
  file: 1024 ** 3,
  entries: 100_000,
  metadata: 64 * 1024,
  windowLog: 27,
  milliseconds: 30 * 60 * 1000,
};

/** Preflight and extraction can enforce byte limits without recomputing acquisition digests. */
export class ByteLimit extends Transform {
  bytes = 0;
  constructor(
    private readonly limit: number,
    private readonly label: string,
  ) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      callback(new Error(`${this.label} exceeds its byte limit`));
      return;
    }
    callback(null, chunk);
  }
}

/** Bounded streaming digests do not require reading a completed file again. */
export class DigestStream extends ByteLimit {
  readonly hash: Hash = createHash("sha256");
  override _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk);
    super._transform(chunk, encoding, callback);
  }
}

export interface ArtifactSource {
  url: string;
  backupUrls?: string[];
}

export function artifactSourceUrls(urlText: string, backupUrls: string[] = []): string[] {
  if (!Array.isArray(backupUrls) || backupUrls.some((url) => typeof url !== "string"))
    throw new Error("artifact backup URLs must be a list of HTTPS URLs");
  const urls = [...new Set([urlText, ...backupUrls])];
  for (const location of urls)
    if (new URL(location).protocol !== "https:") throw new Error("tool downloads require HTTPS, including backups");
  return urls;
}

export class ArtifactUnavailable extends Error {}
export function artifactUnavailable(error: unknown): boolean {
  return (
    error instanceof ArtifactUnavailable ||
    (error instanceof AggregateError && error.errors.length > 0 && error.errors.every(artifactUnavailable))
  );
}

/** Every redirect and the final body share the caller's cancellation/deadline signal. */
async function fetchArtifactResponse(urlText: string, signal?: AbortSignal): Promise<Readable> {
  let url = new URL(urlText);
  for (let redirects = 0; redirects < 10; redirects++) {
    if (url.protocol !== "https:") throw new Error("tool downloads require HTTPS, including redirects");
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    const headers = url.origin === "https://api.github.com" && token ? { Authorization: `Bearer ${token}` } : undefined;
    const response = await networkResponse(url, {
      redirect: "manual",
      ...(headers ? { headers } : {}),
      ...(signal ? { signal } : {}),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await releaseNetworkResponse(response);
      if (!location) throw new Error("tool download redirect has no location");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      const message = `tool download failed: HTTP ${String(response.status)}: ${url.origin}${url.pathname}`;
      const Failure = [404, 410].includes(response.status) ? ArtifactUnavailable : AcquisitionRejected;
      return rejectNetworkResponse(response, new Failure(message));
    }
    return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  }
  throw new Error("too many tool download redirects");
}

async function withArtifactSources<T>(
  urlText: string,
  consume: (location: string) => Promise<T>,
  signal?: AbortSignal,
  backupUrls: string[] = [],
): Promise<T> {
  const urls = artifactSourceUrls(urlText, backupUrls);
  const url = new URL(urlText);
  return retryNetwork(
    `Acquire ${url.origin}${url.pathname}`,
    async () => {
      const failures: Error[] = [];
      for (const [index, location] of urls.entries()) {
        try {
          return await consume(location);
        } catch (error) {
          if (
            signal?.aborted ||
            !(error instanceof Error) ||
            (!(error instanceof ArtifactUnavailable) && !retryableNetworkFailure(error))
          )
            throw error;
          failures.push(error);
          const next = urls[index + 1];
          if (next) {
            const target = new URL(next);
            writeDiagnosticText(`${error.message}; trying backup ${target.origin}${target.pathname}`);
          }
        }
      }
      const [failure] = failures;
      if (failures.length === 1 && failure) throw failure;
      throw new AggregateError(
        failures,
        `All declared artifact sources failed: ${failures.map((error) => error.message).join("; ")}`,
      );
    },
    {
      ...(signal ? { signal } : {}),
      diagnosticOperation: DiagnosticOperation.ArtifactConnection,
      fields: { source: url.origin + url.pathname },
    },
  );
}

/** Only availability failures select another declared source; integrity remains the caller's contract. */
export async function artifactResponse(
  urlText: string,
  signal?: AbortSignal,
  backupUrls: string[] = [],
): Promise<Readable> {
  artifactSourceUrls(urlText, backupUrls);
  const managed = managedInputRepository(process.cwd());
  if (managed) return createReadStream(managedInputSource(managed, urlText), signal ? { signal } : {});
  return withArtifactSources(urlText, (location) => fetchArtifactResponse(location, signal), signal, backupUrls);
}

/** Retry a complete, privately consumed body; partial bytes never escape to a subsequent attempt. */
export async function withArtifactResponse<T>(
  urlText: string,
  consume: (source: Readable) => Promise<T>,
  signal?: AbortSignal,
  backupUrls: string[] = [],
): Promise<T> {
  artifactSourceUrls(urlText, backupUrls);
  const managed = managedInputRepository(process.cwd());
  const read = async (location: string) => {
    const stream = managed
      ? createReadStream(managedInputSource(managed, location), signal ? { signal } : {})
      : await fetchArtifactResponse(location, signal);
    try {
      return await consume(stream);
    } finally {
      stream.destroy();
    }
  };
  return managed ? read(urlText) : withArtifactSources(urlText, read, signal, backupUrls);
}

/** tar-stream buffers extended headers: reject oversized metadata before feeding it those bytes. */
export class TarGuard extends Transform {
  private header = Buffer.alloc(0);
  private remaining = 0;
  private total = 0;
  private entries = 0;
  constructor(private readonly limits: ArtifactLimits) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.total += chunk.length;
      if (this.total > this.limits.decompressed) throw new Error("archive exceeds its decompressed byte limit");
      let offset = 0;
      while (offset < chunk.length) {
        if (this.remaining) {
          const length = Math.min(this.remaining, chunk.length - offset);
          offset += length;
          this.remaining -= length;
          continue;
        }
        const length = Math.min(512 - this.header.length, chunk.length - offset);
        this.header = Buffer.concat([this.header, chunk.subarray(offset, offset + length)]);
        offset += length;
        if (this.header.length !== 512) continue;
        if (this.header.some((byte) => byte !== 0)) {
          if (++this.entries > this.limits.entries) throw new Error("archive exceeds its entry limit");
          const sizeText = this.header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
          if (!/^[0-7]+$/.test(sizeText)) throw new Error("archive has an unsupported entry size encoding");
          const size = Number.parseInt(sizeText, 8);
          if (!Number.isSafeInteger(size) || size > this.limits.file)
            throw new Error("archive entry exceeds its size limit");
          if ("xgLK".includes(String.fromCharCode(this.header[156] ?? 0)) && size > this.limits.metadata)
            throw new Error("archive metadata exceeds its size limit");
          this.remaining = Math.ceil(size / 512) * 512;
        }
        this.header = Buffer.alloc(0);
      }
      callback(null, chunk);
    } catch (error) {
      callback(error as Error);
    }
  }
  override _flush(callback: TransformCallback): void {
    callback(this.remaining || this.header.length ? new Error("truncated tool archive") : null);
  }
}
