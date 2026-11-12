import { recordOwnerPath } from "../../core/records/staged-records.js";

/** Supporting files share their primary record's acknowledgment and queue position. */
export function reviewOwner(
  path: string,
  scopes: string[],
  sources: string[],
  hasPrimary: (path: string) => boolean,
): string {
  const owner = recordOwnerPath(path, scopes, sources);
  return owner && hasPrimary(owner) ? owner : path;
}
