import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { archivePath, execute } from "./tool-downloads.js";
import { artifactLimits } from "./artifact-streams.js";

/** Accept only bounded regular files and directories; RubyInstaller archives require no links. */
export function sevenZipMembers(listing: string, limits = artifactLimits): Map<string, number | undefined> {
  const members = new Map<string, number | undefined>();
  const folded = new Set<string>();
  let total = 0;
  for (const block of listing.trim().split(/\r?\n\r?\n/)) {
    if (Buffer.byteLength(block) > limits.metadata) throw new Error("7-Zip member metadata exceeds bounds");
    const properties = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const match = /^([^=]+) = (.*)$/.exec(line);
      if (!match?.[1] || match[2] === undefined) throw new Error("invalid 7-Zip member listing");
      const key = match[1].trim();
      if (properties.has(key)) throw new Error("duplicate 7-Zip member property");
      properties.set(key, match[2]);
    }
    // 7-Zip presents native separators on Windows; validate the resulting relative archive path.
    const name = archivePath((properties.get("Path") ?? "").replaceAll("\\", "/"));
    const attributes = properties.get("Attributes") ?? "";
    if (properties.has("Symbolic Link") || properties.has("Hard Link") || /[Ll]/.test(attributes))
      throw new Error("7-Zip links are not supported");
    const directory = properties.get("Folder") === "+" || attributes.startsWith("D");
    const sizeText = properties.get("Size") ?? "";
    const size = Number(sizeText);
    if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(size) || size < 0 || size > limits.file)
      throw new Error("7-Zip member exceeds file bounds");
    if (properties.get("Encrypted") === "+") throw new Error("encrypted 7-Zip members are not supported");
    total += size;
    if (total > Math.min(limits.decompressed, limits.retained) || members.size >= limits.entries)
      throw new Error("7-Zip archive exceeds bounds");
    if (folded.has(name.toLowerCase())) throw new Error("duplicate 7-Zip member path");
    folded.add(name.toLowerCase());
    members.set(name, directory ? undefined : size);
  }
  for (const name of members.keys()) {
    const parts = name.split("/");
    while (parts.pop() && parts.length) {
      const parent = parts.join("/");
      if (members.has(parent) && members.get(parent) !== undefined) throw new Error("7-Zip parent is not a directory");
    }
  }
  return members;
}

export function extractSevenZip(archive: string, destination: string, strip: number, limits = artifactLimits): string {
  const windows = "C:/Program Files/7-Zip/7z.exe";
  const command = process.platform === "win32" && existsSync(windows) ? windows : "7z";
  const members = sevenZipMembers(
    execute(command, ["l", "-slt", "-ba", archive], {
      capture: true,
      timeout: limits.milliseconds,
      maxBuffer: Math.min(32 * 1024 ** 2, limits.entries * 1024),
    }),
    limits,
  );
  execute(command, ["x", "-y", `-o${destination}`, archive], { timeout: limits.milliseconds });
  let files = 0;
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("7-Zip extracted a link");
      if (entry.isDirectory()) visit(path, `${name}/`);
      else {
        if (!entry.isFile() || members.get(name) !== lstatSync(path).size)
          throw new Error("7-Zip extracted unexpected content");
        files++;
      }
    }
  };
  visit(destination);
  if (files !== [...members.values()].filter((size) => size !== undefined).length)
    throw new Error("7-Zip omitted content");
  if (strip === 0) return destination;
  const roots = readdirSync(destination);
  const first = roots[0];
  if (strip !== 1 || roots.length !== 1 || !first || !lstatSync(join(destination, first)).isDirectory())
    throw new Error("7-Zip archive has an unexpected root");
  return join(destination, first);
}
