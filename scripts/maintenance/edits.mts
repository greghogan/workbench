import {
  editJsonFields,
  editTokens,
  mavenVersions,
  dockerBases,
  actionPins,
  goModules,
  guixCommit,
} from "./syntax.mjs";
import { locatorName, locatorField } from "./workspace.mjs";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { editToml } from "../../src/toml-edit.js";
import { MaintenanceProvider, requestedVersion, type MaintenanceEntry } from "./contract.mjs";
import { record, required, strings } from "../values.mjs";

const expression = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function replace(source: string, before: string | RegExp, after: string): string {
  const result = source.replace(before, after);
  if (result === source) throw new Error(`Cannot locate the selected version token: ${String(before)}`);
  return result;
}

/** Retain aliases, range operators and unrelated bounds instead of replacing requirements with bare versions. */
export function versionRequirement(current: string, version: string): string {
  const previous = requestedVersion(current);
  if (!current.includes(previous)) throw new Error(`Unsupported version requirement: ${current}`);
  return current.replace(previous, version);
}

function setPath(document: Record<string, unknown>, path: string[], value: string) {
  const parts = path;
  let parent: unknown = document;
  for (const part of parts.slice(0, -1))
    parent = Array.isArray(parent)
      ? (parent[Number(part)] as unknown)
      : record(parent, "Missing version authority")[part];
  const key = required(parts.at(-1), "Missing version field");
  if (Array.isArray(parent)) parent[Number(key)] = value;
  else record(parent, "Missing version authority")[key] = value;
}

function tomlEntry(document: Record<string, unknown>, entry: MaintenanceEntry, version: string) {
  const provider = entry.provider;
  if (provider === MaintenanceProvider.Python) {
    const build = locatorName(entry) === "build-system";
    const parent = record(document[build ? "build-system" : "dependency-groups"], "Missing Python requirements");
    const key = build ? "requires" : locatorName(entry);
    const requirements = strings(parent[key], "Invalid Python requirements");
    const prefix = new RegExp(`^${expression(entry.name)}(?:\\[[^\\]]+\\])?\\s*(?=[=<>!~])`, "i");
    if (!requirements.some((requirement) => prefix.test(requirement)))
      throw new Error(`Missing Python dependency: ${entry.name}`);
    parent[key] = requirements.map((requirement) => {
      const name = prefix.exec(requirement)?.[0];
      if (!name) return requirement;
      if (requirement.slice(name.length) !== entry.current)
        throw new Error(`Python requirement has changed: ${entry.name}`);
      return name + versionRequirement(entry.current, version);
    });
  } else if (provider === MaintenanceProvider.Cargo) {
    const group = record(document[locatorName(entry)], "Missing Cargo dependencies");
    if (typeof group[entry.name] === "string") group[entry.name] = versionRequirement(entry.current, version);
    else record(group[entry.name], "Missing Cargo dependency").version = versionRequirement(entry.current, version);
  } else if (entry.provider === MaintenanceProvider.Image && entry.locator)
    setPath(document, locatorField(entry), `${entry.name}@${version}`);
  else if (entry.locator) setPath(document, locatorField(entry), version);
  else record(document.toolchain, "Missing Rust toolchain").channel = version;
}

/** Edit only known declaration fields. TOML edits reuse Workbench's comment-preserving editor. */
export function manifestMaintenanceEdits(root: string, entries: MaintenanceEntry[]): [string, string][] {
  const groups = new Map<string, MaintenanceEntry[]>();
  for (const entry of entries) {
    if (!entry.selected) throw new Error(`No selected version: ${entry.id}`);
    const group = groups.get(entry.path) ?? [];
    group.push(entry);
    groups.set(entry.path, group);
  }
  const files: [string, string][] = [...groups].map(([path, changes]) => {
    const original = readFileSync(join(root, path), "utf8");
    let result = original;
    if (path.endsWith(".json")) {
      result = editJsonFields(
        original,
        changes.map((entry) => {
          const version = required(entry.selected, "Missing release").version;
          if (entry.name === "packageManager")
            return { path: ["packageManager"], value: versionRequirement(entry.current, version) };
          if (entry.provider === MaintenanceProvider.Image)
            return { path: locatorField(entry), value: `${entry.name}@${version}` };
          if (entry.provider === MaintenanceProvider.Tool) return { path: locatorField(entry), value: version };
          return { path: [locatorName(entry), entry.name], value: versionRequirement(entry.current, version) };
        }),
      );
    } else if (path.endsWith(".toml")) {
      const document = parseToml(original);
      for (const entry of changes) tomlEntry(document, entry, required(entry.selected, "Missing release").version);
      result = editToml(original, document);
    } else {
      for (const entry of changes) {
        const version = required(entry.selected, "Missing release").version;
        if (entry.provider === MaintenanceProvider.Image) {
          const tokens = dockerBases(result).filter(
            (token) => token.name === entry.name && token.digest === entry.current,
          );
          if (!tokens.length) throw new Error(`Cannot locate image authority: ${entry.name}`);
          result = editTokens(
            result,
            tokens.map((token) => ({ start: token.start, end: token.end, value: `${entry.name}@${version}` })),
          );
        } else if (entry.provider === MaintenanceProvider.Action) {
          const revision = required(entry.selected?.revision, "Missing resolved action commit");
          const tokens = actionPins(result).filter(
            (pin) =>
              pin.name === entry.name && pin.revision === entry.locator.revision && pin.version === entry.current,
          );
          if (!tokens.length) throw new Error(`Cannot locate action authority: ${entry.name}`);
          result = editTokens(
            result,
            tokens.flatMap((pin) => {
              const quote = ["'", '"'].includes(result[pin.start] ?? "") ? (result[pin.start] ?? "") : "";
              return [
                { start: pin.start, end: pin.end, value: `${quote}${entry.name}@${revision}${quote}` },
                { start: pin.versionStart, end: pin.versionEnd, value: version },
              ];
            }),
          );
        } else if (entry.provider === MaintenanceProvider.Maven) {
          const tokens = mavenVersions(result).filter(
            (token) =>
              token.name === entry.name &&
              token.current === entry.current &&
              token.property === (entry.locator ? locatorName(entry) : undefined),
          );
          if (!tokens.length) throw new Error(`Cannot locate Maven version: ${entry.name}`);
          result = editTokens(
            result,
            tokens.map((token) => ({ start: token.start, end: token.end, value: version })),
          );
        } else if (entry.provider === MaintenanceProvider.Go) {
          const tokens = goModules(result).filter(
            (token) => token.name === entry.name && token.current === entry.current,
          );
          if (!tokens.length) throw new Error(`Cannot locate Go module: ${entry.name}`);
          result = editTokens(
            result,
            tokens.map((token) => ({ ...token, value: `v${version}` })),
          );
        } else if (entry.provider === MaintenanceProvider.Ruby)
          result = replace(
            result,
            new RegExp(`(^gem\\s+"${expression(entry.name)}",\\s*")${expression(entry.current)}(")`, "m"),
            `$1${versionRequirement(entry.current, version)}$2`,
          );
        else if (entry.provider === MaintenanceProvider.Guix) {
          const pin = guixCommit(result);
          if (pin.current !== entry.current) throw new Error("Guix pin changed before editing");
          result = editTokens(result, [{ ...pin, value: version }]);
        } else if (entry.name === "buildkit" && entry.locator) {
          const digest = required(entry.selected?.revision, "Missing BuildKit image digest");
          if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid BuildKit image digest");
          const reference = required(
            entry.locator.kind === "image" ? entry.locator.reference : undefined,
            "Missing image reference",
          );
          const image = reference
            .replace(`:v${entry.current}@`, `:v${version}@`)
            .replace(/@sha256:[a-f0-9]{64}$/, `@${digest}`);
          result = replace(result, reference, image);
        } else if (
          entry.name === "bundler" &&
          entry.locator?.kind === "marker" &&
          entry.locator.name === "BUNDLED WITH"
        )
          result = replace(
            result,
            new RegExp(`((?:^|\\r?\\n)BUNDLED WITH\\r?\\n[ \\t]+)${expression(entry.current)}(?=\\s*$)`),
            `$1${version}`,
          );
        else if (basename(path) === ".tool-versions")
          result = replace(
            result,
            new RegExp(`(^${expression(entry.name)}\\s+)${expression(entry.current)}(?=\\s|$)`, "m"),
            `$1${version}`,
          );
        else if (entry.provider === MaintenanceProvider.Tool && /^\.[a-z-]+-version$/.test(basename(path))) {
          if (original.trim() !== entry.current) throw new Error(`Version file has changed: ${path}`);
          result = replace(result, entry.current, version);
        } else throw new Error(`No declaration editor for ${entry.id}`);
      }
    }
    if (result === original) throw new Error(`No change for ${path}`);
    return [path, result];
  });
  const manager = entries.find((entry) => entry.path === "package.json" && entry.name === "packageManager");
  const bootstrap = "scripts/package-manager/package.json";
  if (manager?.selected && existsSync(join(root, bootstrap))) {
    const name = required(manager.current.split("@")[0], "Missing package-manager name");
    files.push([
      bootstrap,
      editJsonFields(readFileSync(join(root, bootstrap), "utf8"), [
        { path: ["dependencies", name], value: manager.selected.version },
      ]),
    ]);
  }
  return files;
}
