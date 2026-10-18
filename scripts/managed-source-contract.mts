import { isRecord as record, required } from "./values.mjs";
export interface ManagedSource {
  url: string;
  hash: string;
  destination: string;
  platforms?: string[];
}
export interface ManagedDeclaration {
  schema_version: number;
  source_hashes: Record<string, string>;
  inputs: ManagedSource[];
  bootstrap?: boolean;
  registry?: boolean;
}
import { isAbsolute } from "node:path";

function assertManagedSource(value: unknown): asserts value is ManagedSource {
  function fail(): never {
    throw new Error(
      "Invalid managed source: expected HTTPS URL, strong integrity, safe destination, and supported platforms",
    );
  }
  if (
    !record(value) ||
    typeof value.url !== "string" ||
    typeof value.hash !== "string" ||
    typeof value.destination !== "string"
  )
    return fail();
  let url;
  try {
    url = new URL(value.url);
  } catch {
    return fail();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !value.destination ||
    isAbsolute(value.destination) ||
    /^[A-Za-z]:/.test(value.destination) ||
    value.destination.includes("\\") ||
    value.destination.split("/").some((part: string) => !part || part === "." || part === "..")
  )
    return fail();
  const integrity = /^(sha256|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value.hash);
  if (
    !integrity ||
    Buffer.from(required(integrity[2], "Integrity digest"), "base64").length !==
      (integrity[1] === "sha256" ? 32 : 64) ||
    Buffer.from(required(integrity[2], "Integrity digest"), "base64").toString("base64") !==
      required(integrity[2], "Integrity digest")
  )
    return fail();
  if (
    value.platforms !== undefined &&
    (!Array.isArray(value.platforms) ||
      !value.platforms.length ||
      new Set(value.platforms).size !== value.platforms.length ||
      value.platforms.some((platform: string) => !["linux-x64", "linux-arm64"].includes(platform)))
  )
    return fail();
}
function assertManagedDeclaration(value: unknown): asserts value is ManagedDeclaration {
  if (
    !record(value) ||
    value.schema_version !== 1 ||
    !record(value.source_hashes) ||
    !Array.isArray(value.inputs) ||
    ["bootstrap", "registry"].some((flag) => value[flag] !== undefined && typeof value[flag] !== "boolean")
  )
    throw new Error("Invalid managed check-input declaration");
  for (const [file, hash] of Object.entries(value.source_hashes)) {
    if (
      !file ||
      isAbsolute(file) ||
      /^[A-Za-z]:/.test(file) ||
      file.includes("\\") ||
      file.split("/").some((part) => !part || part === "." || part === "..") ||
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(hash)
    )
      throw new Error("Invalid managed check-input source path or hash");
  }
  const destinations = new Set();
  for (const input of value.inputs) {
    assertManagedSource(input);
    if (destinations.has(input.destination))
      throw new Error(`Duplicate managed source destination: ${input.destination}`);
    destinations.add(input.destination);
  }
}

export function managedSource(value: unknown): ManagedSource {
  assertManagedSource(value);
  return value;
}

export function managedDeclaration(value: unknown): ManagedDeclaration {
  assertManagedDeclaration(value);
  return value;
}
