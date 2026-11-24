import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

/** Validate the account-owned executable and every directory used to reach it. */
export function protectedServiceCommand(path: string, uid: number, shared = false): string {
  const actual = realpathSync(path);
  for (let entry = actual; ; entry = dirname(entry)) {
    const metadata = lstatSync(entry);
    if ((metadata.uid !== 0 && metadata.uid !== uid) || (metadata.mode & 0o022) !== 0)
      throw new Error(entry + ": service commands require protected, account-owned installation paths");
    if (shared && (metadata.mode & (metadata.isDirectory() ? 0o001 : 0o004)) === 0)
      throw new Error(entry + ": system service files must be accessible to ordinary accounts");
    if (dirname(entry) === entry) break;
  }
  if (!lstatSync(actual).isFile()) throw new Error(actual + ": expected an installed service executable");
  return actual;
}
