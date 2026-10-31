import { generatedOutput, generatedSource } from "../src/generated-file.ts";
import { publicationTemporaryGlob } from "./file-publication.mts";

export const toolingAdditionalSources = [
  "eslint.config.mts",
  "vitest.config.mts",
  "tests/fixtures/ci-docker.mts",
  "tests/fixtures/ci-workbench.mts",
] as const;

export const maintainerSources: ReadonlySet<string> = new Set([
  ...toolingAdditionalSources,
  ...[
    "authored-tooling",
    "build-bundle",
    "build-tooling",
    "bundle-artifacts",
    "bundle-build",
    "bundle-licenses",
    "bundle-options",
    "check-bundle",
    "check-consumers",
    "check-harnesses",
    "check-release",
    "check-screen-reader",
    "check-web-browser",
    "check-workflows",
    "coverage-processing",
    "coverage-worker",
    "coverage-workers",
    "evaluate-skills",
    "jsx-rendering-lint",
    "link-dependencies",
    "node-coverage-reports",
    "package-workbench",
    "prepare-screen-reader",
    "runtime-dependencies",
    "refresh-managed-inputs",
    "setup-development",
    "skill-evaluation-cases",
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
  "scripts/owned-scratch.mts",
  "scripts/runtime-parsers.mts",
  "scripts/managed-image-import.mts",
  "scripts/maintenance/edits.mts",
  "scripts/maintenance/operation.mts",
  "scripts/runtime-dependencies.mts",
  "scripts/source-snapshot.mts",
  "scripts/prepare-screen-reader.mts",
  "scripts/check-screen-reader.mts",
  ...toolingAdditionalSources.filter((path) => path.startsWith("tests/fixtures/")),
]);

interface ArtifactIdentity {
  source: string;
  category: "runtime" | "consumer" | "maintainer";
  tracked: boolean;
}
export type ToolingArtifact = ArtifactIdentity &
  ({ emission: "none"; output: null } | { emission: "transform" | "bundle"; output: string });

/** Authoritative role, output, and emission policy for authored tooling. */
export function toolingArtifact(source: string): ToolingArtifact {
  const maintainer = source.startsWith("scripts/maintenance/") || maintainerSources.has(source);
  const identity: ArtifactIdentity = {
    source,
    category: maintainer
      ? "maintainer"
      : source.startsWith("examples/") || source.startsWith("languages/")
        ? "consumer"
        : "runtime",
    tracked: !maintainer,
  };
  if (source === "scripts/build-tooling.mts") return { ...identity, emission: "none", output: null };
  const output = generatedOutput(source);
  if (!output) throw new Error(`Not a tooling source: ${source}`);
  return { ...identity, emission: bundledSources.has(source) ? "bundle" : "transform", output };
}

/** Bundles contain third-party generated code; lint their authored sources and verify output parity. */
export const bundledOutputs = [...bundledSources].flatMap((source) => {
  const artifact = toolingArtifact(source);
  return artifact.output === null ? [] : [artifact.output];
});

export const maintainerOutputs = [
  "scripts/maintenance/**/*.mjs",
  "scripts/maintenance/**/*.cjs",
  ...[...maintainerSources].flatMap((source) => {
    const artifact = toolingArtifact(source);
    return artifact.output === null ? [] : [artifact.output];
  }),
];

/** Emitted development helpers are disposable and do not belong in the installed distribution. */
export function maintainerOutput(path: string): boolean {
  const source = generatedSource(path);
  if (!source) return false;
  const artifact = toolingArtifact(source);
  return artifact.category === "maintainer" && artifact.output === path;
}

export const toolingIgnoreStart = "# Development JavaScript; emission policy: scripts/tooling-artifacts.mts.";
export const toolingIgnoreEnd = "# End generated development JavaScript.";
export const toolingIgnoreBlock =
  [toolingIgnoreStart, ...maintainerOutputs.map((path) => `/${path}`), publicationTemporaryGlob, toolingIgnoreEnd].join(
    "\n",
  ) + "\n";

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
