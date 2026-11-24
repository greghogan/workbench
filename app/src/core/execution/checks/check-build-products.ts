import { constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { publishDirectory } from "../../runtime/directory-publication.mjs";
import { readBoundedFile } from "../../runtime/file-reads.js";
import { writeAtomic } from "../../runtime/file-publication.mjs";
import { ownedPath } from "../../runtime/paths.js";
import { fileDigest, inputDigest } from "./check-inputs.js";

function productEntry(buildDirectory: string, key: string): string {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid check build identity");
  return ownedPath(buildDirectory, ".workbench-check-products/" + key);
}

export function checkBuildProductIdentity(buildDirectory: string, key: string): string | undefined {
  try {
    const entry = productEntry(buildDirectory, key);
    const digest = readBoundedFile(ownedPath(entry, "sha256"), 64, "build output digest").toString("utf8");
    return /^[0-9a-f]{64}$/.test(digest) ? digest : undefined;
  } catch {
    return undefined;
  }
}

function productDigest(directories: readonly string[]): string {
  const files: [string, number, string?][] = [];
  function visit(directory: string, name: string): void {
    const path = join(directory, name);
    const entry = lstatSync(path);
    if (entry.isDirectory()) {
      files.push([name, entry.mode & 0o777]);
      for (const child of readdirSync(path).sort()) visit(directory, name + "/" + child);
    } else if (entry.isFile()) files.push([name, entry.mode & 0o777, fileDigest(path)]);
    else throw new Error(`Unsupported file in declared build output: ${path}`);
  }
  for (const directory of directories) visit(directory, ".");
  return inputDigest(files);
}

/** The worker holds the owning root's build lock while inspecting and publishing products. */
export function checkBuildProducts(buildDirectory: string, key: string, directories: readonly string[]) {
  const storage = ownedPath(buildDirectory, ".workbench-check-products");
  const entry = productEntry(buildDirectory, key);
  const products = (root: string) => directories.map((_, index) => ownedPath(root, String(index)));
  const install = (from: readonly string[], into: readonly string[]) => {
    for (const [index, source] of from.entries()) {
      const target = into[index];
      if (!target) throw new Error("Missing declared build output location");
      cpSync(source, target, { recursive: true, mode: constants.COPYFILE_FICLONE });
    }
  };
  return {
    restore(): string | undefined {
      const digest = checkBuildProductIdentity(buildDirectory, key);
      if (digest === undefined) return;
      try {
        if (productDigest(products(entry)) !== digest) return;
      } catch {
        return;
      }
      try {
        install(products(entry), directories);
        if (productDigest(directories) !== digest) throw new Error("Check build output changed during restore");
        return digest;
      } catch {
        for (const directory of directories) {
          rmSync(directory, { force: true, recursive: true });
          mkdirSync(directory, { recursive: true });
        }
        return;
      }
    },
    retain(): string {
      const digest = productDigest(directories);
      mkdirSync(storage, { recursive: true, mode: 0o700 });
      const temporary = mkdtempSync(join(storage, ".incoming-"));
      const previous = join(temporary, "previous");
      let published = false;
      try {
        const incoming = join(temporary, "products");
        mkdirSync(incoming);
        install(directories, products(incoming));
        if (productDigest(products(incoming)) !== digest)
          throw new Error("Check build output changed during retention");
        writeAtomic(join(incoming, "sha256"), digest, 0o600);
        publishDirectory(incoming, entry, previous);
        published = true;
        return digest;
      } finally {
        if (published || !existsSync(previous)) rmSync(temporary, { force: true, recursive: true });
      }
    },
  };
}
