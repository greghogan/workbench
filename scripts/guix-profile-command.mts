import { isMainScript } from "./script-entry.mjs";
import { lstatSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { withManagedProcesses, type ManagedProcessScope } from "./managed-process.mjs";
import { required } from "./values.mjs";

/** Caller holds the dependency lock and registers ownership of both public profile paths. */
export async function runGuixProfile(profile: string, command: string[], scope: ManagedProcessScope): Promise<void> {
  const pending = `${profile}-pending`;
  const register = () =>
    scope.run("guix", ["repl", join(import.meta.dirname, "ci-guix-bootstrap.scm"), "register-root", profile]);
  for (const path of [profile, pending]) {
    const metadata = lstatSync(path, { throwIfNoEntry: false });
    if (metadata && (!metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()))
      throw new Error(`${path}: expected your registered Guix profile symlink`);
  }
  // A prior interrupted publication may have replaced the link before registering it.
  // Re-register before releasing the pending root that protects the same environment.
  if (lstatSync(profile, { throwIfNoEntry: false })) await register();
  rmSync(pending, { force: true });
  await scope.run(required(command[0], "Missing Guix command"), command.slice(1));
  const temporary = `${profile}.${randomUUID()}.partial`;
  try {
    symlinkSync(realpathSync(pending), temporary);
    renameSync(temporary, profile);
    await register();
    rmSync(pending);
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (isMainScript(import.meta.url))
  await withManagedProcesses(async (scope) => {
    await runGuixProfile(required(process.argv[2], "Missing Guix profile"), process.argv.slice(3), scope);
  });
