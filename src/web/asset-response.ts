import { brotliCompress, gzip, constants } from "node:zlib";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { browserScript, stylesheet } from "./assets.js";
import { assetManifest } from "./asset-manifest.js";
import { negotiateEncoding } from "./content-negotiation.js";
import { WebError } from "./errors.js";

const encodeBrotli = promisify(brotliCompress),
  encodeGzip = promisify(gzip);
const assets = {
  style: { type: "text/css; charset=utf-8", body: Buffer.from(stylesheet) },
  client: { type: "text/javascript; charset=utf-8", body: Buffer.from(browserScript) },
};
type Asset = keyof typeof assets;
const encoded = new Map<string, Promise<Buffer>>();
/** Versioned URLs are immutable; unversioned requests revalidate against the same owned representations. */
export async function serveAsset(
  request: IncomingMessage,
  response: ServerResponse,
  kind: Asset,
  version?: string,
): Promise<void> {
  const asset = assets[kind],
    digest = assetManifest[kind].digest;
  if (version !== undefined && version !== digest)
    throw new WebError(404, "Asset version is unavailable; reload the page");
  const encoding = negotiateEncoding(request.headers["accept-encoding"], ["br", "gzip", "identity"]);
  if (!encoding) throw new WebError(406, "No acceptable asset encoding; allow identity, gzip, or Brotli");
  const etag = `"${digest}-${encoding}"`;
  response.setHeader("cache-control", version ? "public, max-age=31536000, immutable" : "no-cache");
  response.setHeader("vary", "Accept-Encoding");
  response.setHeader("etag", etag);
  response.setHeader("content-type", asset.type);
  if (encoding !== "identity") response.setHeader("content-encoding", encoding);
  if (
    (request.headers["if-none-match"] ?? "")
      .split(",")
      .some((entry) => entry.trim() === "*" || entry.trim().replace(/^W\//, "") === etag)
  ) {
    response.writeHead(304);
    response.end();
    return;
  }
  let body: Buffer = asset.body;
  if (encoding !== "identity") {
    const key = kind + encoding;
    let pending = encoded.get(key);
    if (!pending) {
      pending =
        encoding === "br" ? encodeBrotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }) : encodeGzip(body);
      encoded.set(key, pending);
      void pending.catch(() => {
        if (encoded.get(key) === pending) encoded.delete(key);
      });
    }
    body = await pending;
  }
  if (response.destroyed) return;
  response.setHeader("content-length", body.length);
  response.writeHead(200);
  response.end(request.method === "HEAD" ? undefined : body);
}
