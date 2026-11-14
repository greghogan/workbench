import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseAllDocuments } from "../app/src/core/configuration/runtime-parsers.mjs";

/** Snapshots own mutable metadata and links while reusing immutable package contents. */
export function linkDependencies(source: string, destination: string, packages?: readonly string[]): void {
  const dependencies = realpathSync.native(source);
  mkdirSync(destination);
  const names =
    packages ??
    readdirSync(dependencies).flatMap((name) =>
      name === ".pnpm"
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
      const documents = parseAllDocuments(readFileSync(canonical, "utf8"));
      const document = documents.at(-1);
      if (!document || documents.some((item) => item.errors.length))
        throw new Error("Invalid prepared dependency metadata");
      const metadata: unknown = document.toJSON();
      if (
        !metadata ||
        typeof metadata !== "object" ||
        !("virtualStoreDir" in metadata) ||
        typeof metadata.virtualStoreDir !== "string"
      )
        throw new Error("Prepared dependency metadata needs a virtual store");
      metadata.virtualStoreDir = resolve(dirname(canonical), metadata.virtualStoreDir);
      writeFileSync(target, JSON.stringify(metadata, null, 2) + "\n");
    } else if (name === ".bin") linkBinaries(canonical, target);
    else if (!statSync(canonical).isDirectory()) copyFileSync(canonical, target);
    else symlinkSync(canonical, target, "junction");
  }
}

function linkBinaries(source: string, destination: string): void {
  mkdirSync(destination);
  for (const name of readdirSync(source)) {
    const command = join(source, name),
      target = join(destination, name);
    if (!statSync(command).isFile()) throw new Error(`Unsupported package launcher: ${command}`);
    if (/\.(exe|com)$/i.test(name)) copyFileSync(command, target);
    else if (/\.cmd$/i.test(name))
      writeFileSync(target, `@echo off\r\n@call "${command.replaceAll("%", "%%")}" %*\r\n@exit /b %errorlevel%\r\n`);
    else if (/\.ps1$/i.test(name))
      writeFileSync(target, `& '${command.replaceAll("'", "''")}' @args\nexit $LASTEXITCODE\n`);
    else
      writeFileSync(target, `#!/bin/sh\nexec '${command.replaceAll("\\", "/").replaceAll("'", "'\\''")}' "$@"\n`, {
        mode: 0o755,
      });
  }
}
