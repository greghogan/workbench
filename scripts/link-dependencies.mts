import { mkdirSync, readdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/** Reuse installed dependencies without rebasing pnpm's relative package links across volumes. */
export function linkDependencies(source: string, destination: string, packages?: readonly string[]): void {
  const dependencies = realpathSync.native(source);
  if (!packages && process.platform !== "win32") {
    symlinkSync(dependencies, destination, "junction");
    return;
  }
  mkdirSync(destination);
  const names =
    packages ??
    readdirSync(dependencies).flatMap((name) =>
      name.startsWith("@") ? readdirSync(join(dependencies, name)).map((entry) => `${name}/${entry}`) : [name],
    );
  for (const name of names) {
    const canonical = realpathSync.native(join(dependencies, name));
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(canonical, target, statSync(canonical).isDirectory() ? "junction" : "file");
  }
}
