/** Runtime, loading, and compression policy travel with each authored entry point. */
interface BundleDefinition {
  source: string;
  lazy: boolean;
  runtime: "bootstrap" | "cli";
  compression: "configured" | "brotli" | "none";
}
export const bundles = {
  main: { source: "app/src/cli/main.ts", lazy: false, runtime: "cli", compression: "none" },
  "archive-guard": {
    source: "app/src/core/records/archive-hook.ts",
    lazy: false,
    runtime: "bootstrap",
    compression: "none",
  },
  launcher: { source: "app/src/cli/launcher.ts", lazy: false, runtime: "bootstrap", compression: "none" },
  bootstrap: {
    source: "app/src/core/distribution/bootstrap.ts",
    lazy: false,
    runtime: "bootstrap",
    compression: "brotli",
  },
  skills: { source: "app/src/core/skills/skills.ts", lazy: false, runtime: "cli", compression: "configured" },
  package: { source: "app/src/core/artifacts/package.ts", lazy: false, runtime: "cli", compression: "configured" },
  consumer: {
    source: "app/test/integration/consumers/consumer.ts",
    lazy: false,
    runtime: "cli",
    compression: "configured",
  },
  formatter: { source: "app/src/core/records/formatter.ts", lazy: true, runtime: "cli", compression: "configured" },
  "attestation-verification": {
    source: "app/src/core/toolchains/acquisition/attestation-verification.ts",
    lazy: true,
    runtime: "cli",
    compression: "configured",
  },
} as const satisfies Record<string, BundleDefinition>;
export type BundleName = keyof typeof bundles;
export const bundleEntries = Object.keys(bundles) as BundleName[];
export const lazyBundles = bundleEntries.filter((name) => bundles[name].lazy);
export const compressedBundles = bundleEntries.filter((name) => bundles[name].compression !== "none");
export const bundleSources = Object.fromEntries(bundleEntries.map((name) => [name, bundles[name].source])) as Record<
  BundleName,
  string
>;
export function bundleDefinition(name: string): BundleDefinition {
  if (!Object.hasOwn(bundles, name)) throw new Error(`Unknown runtime bundle: ${name}`);
  return bundles[name as BundleName];
}
export function bundleSource(name: string): string {
  return bundleDefinition(name).source;
}
