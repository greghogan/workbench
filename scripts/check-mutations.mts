import assert from "node:assert/strict";
import { build, type Plugin } from "esbuild";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { authoredTooling } from "./authored-tooling.mts";
import { linkDependencies } from "./link-dependencies.mjs";
import { processFailure } from "./process-outcome.mjs";
import { withEngineeringRun, withEngineeringReport } from "./engineering-run.mjs";
import { writeAtomic } from "./file-publication.mjs";
import { readBoundedFile } from "../src/file-reads.ts";
import { isPropertyID, propertyTitles, type PropertyID } from "./document-properties.mjs";

// Small, named faults in critical contracts; this is intentionally not a general source-mutation engine.
const mutants = [
  {
    name: "accept parent-directory traversal",
    property: "relative-paths",
    path: "src/paths.ts",
    before: 'part === ".."',
    after: 'part === "__mutant__"',
  },
  {
    name: "accept Windows separators and drive-relative paths",
    property: "relative-paths",
    path: "src/paths.ts",
    before: "/[\\\\:]/.test(value)",
    after: "false",
  },
  {
    name: "accept ambiguous project ownership",
    property: "scope-ownership",
    path: "src/project-configuration.ts",
    before: "ids.has(project.id) || paths.has(project.path)",
    after: "false",
  },
  {
    name: "return the unedited TOML document",
    property: "toml-values",
    path: "src/toml-edit.ts",
    start: "export function editToml",
    before: "return result;",
    after: "return source;",
  },
];
const root = process.cwd();
const parent = process.env.WORKBENCH_BUILD_DIR;
if (!parent) throw new Error("Run mutation checks through a configured Workbench check or shell");
const report = {
  status: "running" as "running" | "passed" | "failed",
  error: "",
  schema_version: 1,
  outcomes: [] as { name: string; property: PropertyID; status: "detected" | "survived" | "infrastructure-failed" }[],
};
const save = () => {
  writeAtomic(join(parent, "mutation-results.json"), JSON.stringify(report, null, 2) + "\n");
};
await withEngineeringReport(report, save, async () => {
  await withEngineeringRun(parent, "mutation", async (job) => {
    const scratch = job.directory;
    linkDependencies(join(root, "node_modules"), join(scratch, "node_modules"));
    for (const mutant of [undefined, ...mutants]) {
      let applied = false;
      const inject: Plugin = {
        name: "selected-contract-fault",
        setup(builder) {
          builder.onLoad({ filter: /\.ts$/ }, (args) => {
            if (!mutant) return;
            if (relative(root, args.path).replaceAll("\\", "/") !== mutant.path) return;
            const original = readFileSync(args.path, "utf8");
            const offset = mutant.start ? original.indexOf(mutant.start) : 0;
            assert.ok(offset >= 0, "Mutation boundary changed; review this fault definition");
            const region = original.slice(offset);
            assert.equal(
              region.split(mutant.before).length,
              2,
              "Mutation location changed; review this fault definition",
            );
            applied = true;
            return { contents: original.slice(0, offset) + region.replace(mutant.before, mutant.after), loader: "ts" };
          });
        },
      };
      const artifact = join(scratch, "case.mjs"),
        evidence = join(scratch, "outcome.json");
      const selected = mutant?.property;
      await build({
        absWorkingDir: root,
        stdin: {
          contents:
            'import {writeFileSync} from "node:fs"; import {documentProperties} from "./scripts/document-properties.mts"; const [selected,evidence] = process.argv.slice(2); if(!evidence) throw new Error("Missing outcome destination"); const results = Object.entries(documentProperties).filter(([id])=>selected === "all" || id===selected).map(([,verify])=>verify({numRuns:100,seed:20261103})); writeFileSync(evidence, JSON.stringify(results));',
          resolveDir: root,
          loader: "ts",
        },
        outfile: artifact,
        platform: "node",
        format: "esm",
        target: "node22",
        bundle: true,
        packages: "external",
        plugins: [authoredTooling(), inject],
        logLevel: "silent",
      });
      if (mutant) assert.ok(applied, "The selected fault was not applied");
      const result = await job.command(process.execPath, [artifact, selected ?? "all", evidence], {
        cwd: root,
        capture: true,
        limit: 1024 * 1024,
      });
      const failure = processFailure("contract property execution", result, result);
      if (failure) {
        if (mutant && isPropertyID(mutant.property))
          report.outcomes.push({ name: mutant.name, property: mutant.property, status: "infrastructure-failed" });
        throw failure; // A crash or import failure is never evidence that the mutation was detected.
      }
      const outcomes: unknown = JSON.parse(
        readBoundedFile(evidence, 1024 * 1024, "mutation outcomes").toString("utf8"),
      );
      assert.ok(Array.isArray(outcomes));
      if (!mutant)
        assert.ok(
          outcomes.length === Object.keys(propertyTitles).length &&
            outcomes.every(
              (result: unknown) =>
                !!result && typeof result === "object" && "status" in result && result.status === "passed",
            ),
          "Unmodified property baseline failed",
        );
      else {
        const outcome: unknown = outcomes[0];
        assert.ok(isPropertyID(mutant.property));
        const detected =
          outcomes.length === 1 &&
          !!outcome &&
          typeof outcome === "object" &&
          "id" in outcome &&
          outcome.id === mutant.property &&
          "status" in outcome &&
          outcome.status === "failed" &&
          "path" in outcome &&
          typeof outcome.path === "string" &&
          "counterexample" in outcome &&
          outcome.counterexample !== null;
        report.outcomes.push({
          name: mutant.name,
          property: mutant.property,
          status: detected
            ? "detected"
            : outcome && typeof outcome === "object" && "status" in outcome && outcome.status === "passed"
              ? "survived"
              : "infrastructure-failed",
        });
        save();
        assert.ok(detected, `${mutant.name}: selected property did not produce a counterexample`);
        console.log(`Detected: ${mutant.name}`);
      }
    }
    // Real partial-publication and recovery regressions complement the pure-contract faults above.
    const failures = await job.command(
      process.execPath,
      [
        resolve("node_modules/vitest/vitest.mjs"),
        "run",
        "tests/task_transition.test.mts",
        "tests/maintenance_publications.test.mts",
      ],
      { cwd: root },
    );
    const failure = processFailure("partial-failure regressions", failures);
    if (failure) throw failure;
    console.log(`Detected all ${String(mutants.length)} targeted faults and passed partial-failure regressions.`);
  });
});
