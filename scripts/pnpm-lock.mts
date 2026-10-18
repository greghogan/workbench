import { parseAllDocuments } from "yaml";
import { record, required } from "./values.mjs";

/** pnpm locks can contain independent bootstrap and project YAML documents. */
export function pnpmPackages(text: string): Record<string, unknown> {
  const packages = Object.create(null) as Record<string, unknown>;
  for (const document of parseAllDocuments(text)) {
    if (document.errors.length) throw required(document.errors[0], "Missing YAML parse error");
    Object.assign(
      packages,
      record(record(document.toJSON(), "Invalid pnpm lock").packages ?? {}, "Invalid pnpm packages"),
    );
  }
  return packages;
}

export function pnpmIdentity(key: string): { name: string; version: string } {
  const match = /^([^()]+)@([^(@)]+)(?:\(.*\))?$/.exec(key);
  if (!match?.[1] || !match[2]) throw new Error(`unsupported npm lock identity: ${key}`);
  return { name: match[1], version: match[2] };
}
