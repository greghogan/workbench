import type { IncomingMessage, ServerResponse } from "node:http";
import { WebError } from "./errors.js";
export function requestOrigin(request: IncomingMessage): string {
  const host = request.headers.host ?? "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(host))
    throw new WebError(403, "the web UI requires a loopback Host");
  const origin = `http://${host}`;
  if (request.headers.origin && request.headers.origin !== origin)
    throw new WebError(403, "request origin does not match this local service");
  const site = request.headers["sec-fetch-site"];
  if (
    site &&
    !["same-origin", "none"].includes(site) &&
    !(
      request.method === "GET" &&
      request.headers["sec-fetch-mode"] === "navigate" &&
      request.headers["sec-fetch-dest"] === "document"
    )
  )
    throw new WebError(403, "cross-origin access to the local service is not allowed");
  return origin;
}
export async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded")
    throw new WebError(400, "expected a form submission");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > 8 * 1024 * 1024) {
      request.resume();
      throw new WebError(413, "request exceeds the 8 MiB form limit");
    }
    chunks.push(bytes);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export function send(response: ServerResponse, status: number, type: string, contents: string | Buffer): void {
  response.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(contents) });
  response.end(contents);
}
export function secureResponse(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "same-origin");
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
}
