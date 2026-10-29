import { isMainScript } from "./script-entry.mjs";
import { required, isRecord, record, string } from "./values.mjs";

import { replaceManagedFiles } from "./managed-files.mjs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseToml, parseAllDocuments } from "./runtime-parsers.mjs";
import { managedCheckInputs } from "./managed-check-inputs.mjs";
import { guixCheckInputs, nixCheckInputs } from "./managed-input-recipes.mjs";

// Derive builder acquisition inputs from language locks; never resolve package versions here.
export function rustInputs(root: string) {
  const lock = parseToml(readFileSync(join(root, "Cargo.lock"), "utf8"));
  if (!Array.isArray(lock.package)) throw new Error("Cargo.lock has no package list");
  const crates = lock.package
    .map((entry) => record(entry, "Invalid locked Rust package"))
    .filter((entry) => entry.source)
    .map((entry) => ({
      source: string(entry.source, "Missing Rust source"),
      name: string(entry.name, "Missing crate name"),
      version: string(entry.version, "Missing crate version"),
      checksum: string(entry.checksum, "Missing crate checksum"),
    }));
  for (const crate of crates)
    if (
      crate.source !== "registry+https://github.com/rust-lang/crates.io-index" ||
      !/^[a-f0-9]{64}$/.test(crate.checksum)
    )
      throw new Error(`Unsupported locked Rust source: ${crate.name}`);
  return (
    ";; Generated from Cargo.lock by scripts/managed-inputs.mjs; do not edit.\n" +
    "(use-modules (guix packages) (guix download) (guix base16))\n\n(list\n" +
    crates
      .map(
        (crate) => ` (list "rust-${crate.name}-${crate.version}"
       (origin
         (method url-fetch)
         (uri "https://static.crates.io/crates/${crate.name}/${crate.name}-${crate.version}.crate")
         (file-name "${crate.name}-${crate.version}.crate")
         (hash (content-hash (base16-string->bytevector "${crate.checksum}") sha256))))`,
      )
      .join("\n") +
    ")\n"
  );
}

export function reactInputs(root: string) {
  const documents = parseAllDocuments(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
  for (const document of documents)
    if (document.errors.length) throw required(document.errors[0], "Missing YAML parse error");
  const packages: Record<string, unknown> = {};
  for (const document of documents)
    Object.assign(
      packages,
      record(record(document.toJSON(), "Invalid npm lock document").packages ?? {}, "Invalid npm package map"),
    );
  const names = new Set(["react", "react-dom", "scheduler"]);
  const inputs = Object.entries(packages)
    .filter(([name]) => names.has(name.slice(0, name.lastIndexOf("@"))))
    .map(([key, entry]) => {
      const integrity = string(
        record(record(entry, "Invalid npm package").resolution, "Missing npm resolution").integrity,
        "Missing npm integrity",
      );
      const at = key.lastIndexOf("@");
      const name = key.slice(0, at);
      const version = key.slice(at + 1);
      if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity)) throw new Error(`Missing locked npm integrity: ${key}`);
      return {
        name,
        version,
        url: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
        integrity: integrity,
      };
    });
  if (inputs.length !== names.size || new Set(inputs.map((entry) => entry.name)).size !== names.size)
    throw new Error("The React release needs exactly one locked version of each runtime dependency");
  return JSON.stringify(inputs, null, 2) + "\n";
}

export function deriveManagedInputs(root: string, selected?: string): [string, string][] {
  const outputs: [string, string][] = [];
  const projects = parseToml(readFileSync(join(root, "workbench/projects.toml"), "utf8"));
  if (!Array.isArray(projects.language_root)) throw new Error("Missing language roots");
  const roots = projects.language_root.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") throw new Error("Invalid language root");
    return entry.path;
  });
  if (selected !== undefined && !roots.includes(selected)) throw new Error(`Unknown language root: ${selected}`);
  for (const [directory, file, generate] of [
    ["examples/languages/rust", "guix-crates.scm", rustInputs],
    ["examples/frameworks/react", "managed-dependencies.json", reactInputs],
  ] as const) {
    if (selected !== undefined && selected !== directory) continue;
    const location = join(root, directory, file);
    const expected = generate(join(root, directory));
    outputs.push([location, expected]);
  }
  for (const directory of new Set(roots)) {
    if (selected !== undefined && selected !== directory) continue;
    for (const [file, expected] of [
      ["managed-check-inputs.json", `${JSON.stringify(managedCheckInputs(join(root, directory)), null, 2)}\n`],
      ["check-inputs.scm", guixCheckInputs],
      ["check-inputs.nix", nixCheckInputs],
    ] as const) {
      const location = join(root, directory, file);
      outputs.push([location, expected]);
    }
  }
  return outputs;
}

if (isMainScript(import.meta.url)) {
  const { values } = parseArgs({ options: { check: { type: "boolean" }, path: { type: "string" } }, strict: true });
  const outputs = deriveManagedInputs(resolve(import.meta.dirname, ".."), values.path);
  if (values.check) {
    for (const [path, expected] of outputs)
      if (readFileSync(path, "utf8") !== expected) throw new Error(`${path}: regenerate managed inputs`);
  } else replaceManagedFiles(outputs);
}
