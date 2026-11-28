import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseAllDocuments } from "../app/src/core/configuration/runtime-parsers.mjs";

/** Snapshots own mutable metadata and links while reusing immutable package contents. */
export function linkDependencies(source: string, destination: string, packages?: readonly string[]): void {
  const dependencies = realpathSync.native(source);
  mkdirSync(destination);
  const modules = join(dependencies, ".modules.yaml");
  const prepared = packages === undefined && existsSync(modules) ? preparedMetadata(modules) : undefined;
  const names =
    packages ??
    readdirSync(dependencies).flatMap((name) =>
      name.startsWith(".") && name !== ".bin" && name !== ".modules.yaml"
        ? []
        : name.startsWith("@")
          ? readdirSync(join(dependencies, name)).map((entry) => `${name}/${entry}`)
          : [name],
    );
  for (const name of names) {
    const canonical = realpathSync.native(join(dependencies, name));
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    if (name === ".modules.yaml") {
      writeFileSync(target, JSON.stringify(prepared ?? preparedMetadata(canonical), null, 2) + "\n");
    } else if (name === ".bin") linkBinaries(canonical, target, prepared?.virtualStoreDir);
    else if (!statSync(canonical).isDirectory()) copyFileSync(canonical, target);
    else symlinkSync(canonical, target, "junction");
  }
}

function preparedMetadata(path: string): Record<string, unknown> & { virtualStoreDir: string } {
  const documents = parseAllDocuments(readFileSync(path, "utf8"));
  const metadata: unknown = documents.at(-1)?.toJSON();
  if (
    documents.some((item) => item.errors.length) ||
    !metadata ||
    typeof metadata !== "object" ||
    !("virtualStoreDir" in metadata) ||
    typeof metadata.virtualStoreDir !== "string"
  )
    throw new Error("Prepared dependency metadata needs a virtual store");
  return { ...metadata, virtualStoreDir: resolve(dirname(realpathSync.native(path)), metadata.virtualStoreDir) };
}

function linkBinaries(source: string, destination: string, store?: string): void {
  mkdirSync(destination);
  for (const name of readdirSync(source)) {
    const command = join(source, name);
    const target = join(destination, name);
    const metadata = statSync(command);
    if (!metadata.isFile()) throw new Error(`Unsupported package launcher: ${command}`);
    if (/\.(exe|com)$/i.test(name)) {
      copyFileSync(command, target);
      continue;
    }

    const contents = readFileSync(command, "utf8");
    const declared = /^(?:#|@?rem) cmd-shim-target=(.+)$/im.exec(contents)?.[1];
    let relocated = contents;
    if (declared && store) {
      const declaredPath = resolve(source, declared.trim());
      const executable = realpathSync.native(declaredPath);
      const location = relative(realpathSync.native(store), executable);
      if (isAbsolute(location) || location === ".." || location.startsWith(".." + sep))
        throw new Error(`Package launcher leaves its prepared store: ${command}`);
      const oldPath = relative(source, declaredPath);
      const newPath = relative(destination, declaredPath);
      if (isAbsolute(oldPath) || isAbsolute(newPath)) {
        // Windows launchers on another volume use the provider's existing path rules.
        const launcher = name.endsWith(".cmd")
          ? `@echo off\r\n@call "${command.replaceAll("%", "%%")}" %*\r\n@exit /b %errorlevel%\r\n`
          : name.endsWith(".ps1")
            ? `& '${command.replaceAll("'", "''")}' @args\nexit $LASTEXITCODE\n`
            : `#!/bin/sh\nexec '${command.replaceAll("\\", "/").replaceAll("'", "'\\''")}' "$@"\n`;
        writeFileSync(target, launcher);
        continue;
      }
      // A native pnpm shim contains the relative target in its shell dialect.
      // Retain the package manager's interpreter, flags, and search path.
      for (const slash of ["/", "\\"]) {
        const from = oldPath.split(sep).join(slash);
        const to = newPath.split(sep).join(slash);
        if (from !== to) {
          const encode = name.endsWith(".cmd")
            ? (path: string) => path.replaceAll("%", "%%")
            : (path: string) => path.replaceAll("'", name.endsWith(".ps1") ? "''" : "'\\''");
          relocated = relocated.replaceAll(encode(from), () => encode(to));
        }
      }
    }
    writeFileSync(target, relocated);
    if (process.platform !== "win32") chmodSync(target, metadata.mode & 0o777);
  }
}
