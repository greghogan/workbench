import { posix } from "node:path";
import type { ServerResponse } from "node:http";
import { send } from "../http/http.js";

/** Shared illustrations live outside record attachments and their approval snapshots. */
export function isDocumentationSvg(path: string): boolean {
  return path.startsWith("docs/images/") && isSvg(path);
}

export function isSvg(path: string): boolean {
  return posix.extname(path).toLowerCase() === ".svg";
}

export function sendSandboxedSvg(response: ServerResponse, bytes: Buffer): void {
  response.setHeader(
    "content-security-policy",
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  response.setHeader("cross-origin-resource-policy", "same-origin");
  send(response, 200, "image/svg+xml", bytes);
}
