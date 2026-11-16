import { posix } from "node:path";

/** Shared illustrations live outside record attachments and their approval snapshots. */
export function isDocumentationSvg(path: string): boolean {
  return path.startsWith("docs/images/") && posix.extname(path).toLowerCase() === ".svg";
}
