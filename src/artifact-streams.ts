import { createHash, type Hash } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";

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

/** Every redirect and the final body share the caller's cancellation/deadline signal. */
export async function artifactResponse(urlText: string, signal?: AbortSignal): Promise<Readable> {
  let url = new URL(urlText);
  for (let redirects = 0; redirects < 10; redirects++) {
    if (url.protocol !== "https:") throw new Error("tool downloads require HTTPS, including redirects");
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Re-evaluate credentials on every hop; never forward GitHub API tokens to an asset CDN.
        const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
        const headers =
          url.origin === "https://api.github.com" && token ? { Authorization: `Bearer ${token}` } : undefined;
        response = await fetch(url, {
          redirect: "manual",
          ...(headers ? { headers } : {}),
          ...(signal ? { signal } : {}),
        });
        break;
      } catch (cause) {
        if (signal?.aborted || attempt === 2)
          throw new Error(`tool download connection failed: ${url.origin}${url.pathname}`, { cause });
      }
    }
    if (!response) throw new Error("tool download returned no response");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("tool download redirect has no location");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body)
      throw new Error(`tool download failed: ${String(response.status)}: ${url.origin}${url.pathname}`);
    return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  }
  throw new Error("too many tool download redirects");
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
