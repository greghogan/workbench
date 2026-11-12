import { basename } from "node:path";

/** Generated helpers keep one source identity across emission, packaging, and documentation. */
export function generatedOutput(source: string): string | undefined {
  if (source.endsWith(".mts")) return source.slice(0, -4) + ".mjs";
  if (source.endsWith(".cts")) return source.slice(0, -4) + ".cjs";
  return undefined;
}

export function generatedSource(output: string): string | undefined {
  if (output.endsWith(".mjs")) return output.slice(0, -4) + ".mts";
  if (output.endsWith(".cjs")) return output.slice(0, -4) + ".cts";
  return undefined;
}

export function generatedBanner(source: string): string {
  return `// Generated from ${basename(source)}; edit the TypeScript source.`;
}

export function hasGeneratedBanner(prefix: string, source: string): boolean {
  const [first, second] = prefix.split(/\r?\n/, 3);
  const expected = generatedBanner(source);
  return first === expected || (first?.startsWith("#!") === true && second === expected);
}
