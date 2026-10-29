import { generatedOutput, generatedSource } from "../src/generated-file.ts";
import { publicationTemporaryGlob } from "./file-publication.mts";

export const toolingAdditionalSources = [
  "eslint.config.mts",
  "vitest.config.mts",
  "tests/fixtures/ci-docker.mts",
  "tests/fixtures/clock.mts",
  "tests/fixtures/ci-workbench.mts",
  "tests/fixtures/release-gh.mts",
] as const;

/** CI runs these authored, erasable TypeScript modules with its selected Node runtime. */
export const nativeSources: ReadonlySet<string> = new Set([
  "scripts/ci-cache.mts",
  "scripts/ci-cache-metrics.mts",
  "scripts/ci-acquire.mts",
  "scripts/ci-errors.mts",
  "scripts/image-acquisition.mts",
  "scripts/network-retry.mts",
  "scripts/network-command.mts",
  "scripts/ci-candidate.mts",
  "scripts/ci-hosted.mts",
  "scripts/ci-native-prerequisites.mts",
  "scripts/ci-plan-contract.mts",
  "scripts/ci-plan.mts",
  "scripts/ci-platform.mts",
  "scripts/ci-release-ready.mts",
  "scripts/ci-status.mts",
  "scripts/github-release.mts",
  "scripts/release-contract.mts",
  "scripts/publish-release.mts",
  "scripts/metadata-http.mts",
]);
/** These modules are consumed inside bundles and need no standalone JavaScript file. */
export const bundledOnlySources: ReadonlySet<string> = new Set([
  "scripts/check-network.mts",
  "scripts/ci-image.mts",
  "scripts/diagnostic-records.mts",
]);
/** These probes deliberately execute on interpreters too old to load TypeScript. */
export const bootstrapProbeSources: ReadonlySet<string> = new Set([
  "scripts/check-bootstrap.mts",
  "scripts/check-node-runtime.mts",
]);
/** Standalone helpers required by fresh Git installations before development setup. */
export const bootstrapSources: ReadonlySet<string> = new Set([
  "scripts/script-entry.mts",
  "scripts/check-security-results.mts",
  "scripts/builder-store-gc.mts",
  "scripts/cache-generation.mts",
  "scripts/cache-ownership.mts",
  "scripts/check-bootstrap.mts",
  "scripts/check-coverage-summary.mts",
  "scripts/check-detail-data.mts",
  "scripts/check-node-runtime.mts",
  "scripts/check-pgo.mts",
  "scripts/check-python.mts",
  "scripts/check-rust.mts",
  "scripts/ci-contract.mts",
  "scripts/ci-execution.mts",
  "scripts/ci-guix-bootstrap.mts",
  "scripts/ci-image-contract.mts",
  "scripts/ci-image-transfer.mts",
  "scripts/ci-layout.mts",
  "scripts/ci-lifecycle.mts",
  "scripts/ci-linux/job.mts",
  "scripts/ci-linux/run.mts",
  "scripts/ci-operations.mts",
  "scripts/ci-reports.mts",
  "scripts/ci-results.mts",
  "scripts/ci-run.mts",
  "scripts/ci-worker-request.mts",
  "scripts/clean.mts",
  "scripts/compiler-catalog.mts",
  "scripts/coverage-summary.mts",
  "scripts/cpu-budget.mts",
  "scripts/dependency-identity.mts",
  "scripts/diagnostic-contract.mts",
  "scripts/diagnostic-errors.mts",
  "scripts/diagnostic-text.mts",
  "scripts/diagnostic-writer.mts",
  "scripts/diagnostics.mts",
  "scripts/elf.mts",
  "scripts/engineering-run.mts",
  "scripts/executable-hardening.mts",
  "scripts/file-publication.mts",
  "scripts/guix-profile-command.mts",
  "scripts/java-coverage.mts",
  "scripts/java-sources.mts",
  "scripts/managed-check-inputs.mts",
  "scripts/managed-contract.mts",
  "scripts/managed-files.mts",
  "scripts/managed-image-import.mts",
  "scripts/managed-input-recipes.mts",
  "scripts/managed-inputs.mts",
  "scripts/managed-process.mts",
  "scripts/managed-source-contract.mts",
  "scripts/managed-system.mts",
  "scripts/native-c-checks.mts",
  "scripts/native-coverage.mts",
  "scripts/native-host-requirements.mts",
  "scripts/native-pgo.mts",
  "scripts/optimization-artifact.mts",
  "scripts/owned-child.mts",
  "scripts/owned-scratch.mts",
  "scripts/pack-guix-image.mts",
  "scripts/package-managed.mts",
  "scripts/package-output.mts",
  "scripts/pnpm-lock.mts",
  "scripts/pnpm-metadata.mts",
  "scripts/prepare-development.mts",
  "scripts/prepare-guix-profiles.mts",
  "scripts/prepare-host-managed-development.mts",
  "scripts/prepare-managed-development.mts",
  "scripts/prepare-nix-profiles.mts",
  "scripts/process-outcome.mts",
  "scripts/python-checks.mts",
  "scripts/release-rust.mts",
  "scripts/ruby-coverage.mts",
  "scripts/runtime-parsers.mts",
  "scripts/split-prepared-inputs.mts",
  "scripts/values.mts",
  "scripts/verify-managed-preparation.mts",
  "scripts/verify-managed.mts",
  "scripts/windows-arguments.mts",
  "scripts/windows-utf8-console.mts",
  "bin/bundle-runtime.cts",
]);

export const maintainerSources: ReadonlySet<string> = new Set([
  ...toolingAdditionalSources,
  ...nativeSources,
  ...bundledOnlySources,
  ...bootstrapProbeSources,
  ...[
    "accessibility-criteria",
    "authored-tooling",
    "build-bundle",
    "build-tooling",
    "bundle-artifacts",
    "bundle-build",
    "bundle-licenses",
    "bundle-options",
    "check-bundle",
    "check-consumers",
    "security-lint",
    "check-fuzz",
    "check-mutations",
    "check-reproducibility",
    "check-security-results",
    "compare-artifacts",
    "document-properties",
    "profile-case",
    "property-case",
    "profile-model",
    "profile-measurement",
    "rebuild-workbench",
    "profile-workbench",
    "check-harnesses",
    "check-release",
    "check-screen-reader",
    "check-rust-cache",
    "check-web-browser",
    "check-workflows",
    "ci-actions",
    "coverage-processing",
    "coverage-worker",
    "coverage-workers",
    "evaluate-skills",
    "jsx-rendering-lint",
    "link-dependencies",
    "node-coverage-reports",
    "node-runtimes",
    "package-workbench",
    "prepare-screen-reader",
    "runtime-dependencies",
    "refresh-managed-inputs",
    "setup-development",
    "skill-evaluation-cases",
    "skill-evaluation-policy",
    "skill-evaluation-rebase",
    "source-checkout",
    "source-snapshot",
    "test-coverage",
    "test-failures",
    "tooling-artifacts",
    "web-accessibility",
    "web-browser-fixtures",
    "web-browser-scenarios",
    "work-admission",
  ].map((name) => `scripts/${name}.mts`),
]);
const bundledSources = new Set<string>([
  // Sent as a standalone program into managed shells; no checkout-relative imports may remain.
  "scripts/cache-ownership.mts",
  "scripts/check-security-results.mts",
  "examples/languages/rust/scripts/release-verify.mts",
  "scripts/owned-scratch.mts",
  "scripts/node-coverage-reports.mts",
  "scripts/native-pgo.mts",
  "scripts/check-pgo.mts",
  "scripts/engineering-run.mts",
  "scripts/optimization-artifact.mts",
  "scripts/document-properties.mts",
  "scripts/property-case.mts",
  "scripts/check-reproducibility.mts",
  "scripts/check-fuzz.mts",
  "scripts/check-mutations.mts",
  "scripts/profile-case.mts",
  "scripts/profile-workbench.mts",
  "scripts/rebuild-workbench.mts",
  "scripts/runtime-parsers.mts",
  "scripts/managed-image-import.mts",
  "scripts/maintenance/edits.mts",
  "scripts/maintenance/operation.mts",
  "scripts/runtime-dependencies.mts",
  "scripts/source-snapshot.mts",
  "scripts/prepare-screen-reader.mts",
  "scripts/check-screen-reader.mts",
  "scripts/check-rust-cache.mts",
  ...toolingAdditionalSources.filter((path) => path.startsWith("tests/fixtures/")),
]);

/** Shipment is independent of the bootstrap files retained in Git. */
export const shippedSources: ReadonlySet<string> = new Set(
  [...bootstrapSources].filter((source) => !maintainerSources.has(source)),
);

interface ArtifactIdentity {
  source: string;
  category: "runtime" | "consumer" | "maintainer";
  tracked: boolean;
  shipped: boolean;
}
export type ToolingArtifact = ArtifactIdentity &
  ({ emission: "none"; output: null } | { emission: "transform" | "bundle"; output: string });

/** Authoritative role, output, and emission policy for authored tooling. */
export function toolingArtifact(source: string): ToolingArtifact {
  const consumer = source.startsWith("examples/") || source.startsWith("languages/");
  const shipped =
    consumer || shippedSources.has(source) || (!source.startsWith("scripts/") && !maintainerSources.has(source));
  const identity: ArtifactIdentity = {
    source,
    category: consumer ? "consumer" : shipped ? "runtime" : "maintainer",
    tracked: bootstrapSources.has(source) || consumer,
    shipped,
  };
  if (source === "scripts/build-tooling.mts" || nativeSources.has(source) || bundledOnlySources.has(source))
    return { ...identity, emission: "none", output: null };
  const output = generatedOutput(source);
  if (!output) throw new Error(`Not a tooling source: ${source}`);
  return { ...identity, emission: bundledSources.has(source) ? "bundle" : "transform", output };
}

/** Bundles contain third-party generated code; lint their authored sources and verify output parity. */
export const bundledOutputs = [...bundledSources].flatMap((source) => {
  const artifact = toolingArtifact(source);
  return artifact.output === null ? [] : [artifact.output];
});

export const untrackedToolingOutputs = [
  "scripts/maintenance/**/*.mjs",
  "scripts/maintenance/**/*.cjs",
  ...[...maintainerSources].flatMap((source) => {
    const artifact = toolingArtifact(source);
    const output = generatedOutput(source);
    return artifact.tracked || output === undefined ? [] : [output];
  }),
];

/** Emitted development helpers are disposable and do not belong in the installed distribution. */
export function untrackedToolingOutput(path: string): boolean {
  const source = generatedSource(path);
  if (!source || (!source.startsWith("scripts/") && !maintainerSources.has(source))) return false;
  const artifact = toolingArtifact(source);
  return !artifact.tracked && generatedOutput(source) === path;
}

/** Distribution membership does not depend on whether an output is committed. */
export function unshippedToolingOutput(path: string): boolean {
  const source = generatedSource(path);
  return source !== undefined && !toolingArtifact(source).shipped && generatedOutput(source) === path;
}

export const toolingIgnoreStart = "# Development JavaScript; emission policy: scripts/tooling-artifacts.mts.";
export const toolingIgnoreEnd = "# End generated development JavaScript.";
export const toolingIgnoreBlock =
  [
    toolingIgnoreStart,
    "/scripts/**/*.mjs",
    "/scripts/**/*.cjs",
    ...[...bootstrapSources].flatMap((source) => {
      const output = generatedOutput(source);
      return !output?.startsWith("scripts/") ? [] : [`!/${output}`];
    }),
    ...untrackedToolingOutputs.filter((path) => !path.startsWith("scripts/")).map((path) => `/${path}`),
    publicationTemporaryGlob,
    toolingIgnoreEnd,
  ].join("\n") + "\n";

/** Replace only the owned block, preserving unrelated ignore rules. */
export function toolingIgnores(contents: string): string {
  const starts = contents.split(toolingIgnoreStart).length - 1,
    ends = contents.split(toolingIgnoreEnd).length - 1;
  if (starts > 1 || ends > 1 || (starts === 0 && ends !== 0))
    throw new Error("Generated tooling ignore policy must contain one complete owned block");
  const start = contents.indexOf(toolingIgnoreStart);
  if (start < 0) return contents + (contents.endsWith("\n") ? "\n" : "\n\n") + toolingIgnoreBlock;
  const end = contents.indexOf(toolingIgnoreEnd, start);
  if (end < 0) throw new Error("Generated tooling ignore block has no end marker");
  const after = end + toolingIgnoreEnd.length;
  return contents.slice(0, start) + toolingIgnoreBlock + contents.slice(contents[after] === "\n" ? after + 1 : after);
}
