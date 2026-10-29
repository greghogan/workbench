import { basename } from "node:path";

export const projectIdPattern = /^[a-z][a-z0-9_-]*$/;

/** Filesystem names and display names do not impose ecosystem identifier restrictions. */
export function defaultId(root: string): string {
  const candidate = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (projectIdPattern.test(candidate)) return candidate;
  return candidate ? `project-${candidate}` : "project";
}
