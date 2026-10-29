import { isCompilerFamily } from "../scripts/compiler-catalog.mjs";
import { parse, type TomlTable } from "smol-toml";
import { editToml } from "./toml-edit.js";
import { approveReview } from "./review.js";
import { proposedReview } from "./review-service.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Behavioral faults compile successfully, so rejection must come from the application's tests. */
export const consumerFaults: Record<string, { path: string; before: string; after: string }> = {
  typescript: { path: "src/arithmetic.ts", before: "total + value", after: "total - value" },
  javascript: { path: "src/arithmetic.js", before: "total + value", after: "total - value" },
  java: { path: "src/main/java/org/example/workbench/Count.java", before: "count++;", after: "count--;" },
  rust: { path: "src/lib.rs", before: "left.checked_add(right)", after: "left.checked_sub(right)" },
  python: {
    path: "src/workbench_python_reference/arithmetic.py",
    before: "return left + right",
    after: "return left - right",
  },
  c: {
    path: "src/count.c",
    before: "count += data[index] == needle ? 1U : 0U;",
    after: "count += data[index] == needle ? 0U : 1U;",
  },
  cpp: {
    path: "src/count.cpp",
    before: "std::ranges::count(data, needle)",
    after: "std::ranges::count(data, needle) + 1",
  },
  go: {
    path: "count.go",
    before: "return bytes.Count(data, []byte{needle})",
    after: "return bytes.Count(data, []byte{needle}) + 1",
  },
  ruby: { path: "lib/workbench_ruby_reference.rb", before: "values.sum", after: "-values.sum" },
  php: { path: "src/Arithmetic.php", before: "return array_sum($values);", after: "return -array_sum($values);" },
};

export function consumerFault(language: string, project: string): { path: string; original: string; broken: string } {
  const fault = consumerFaults[language];
  assert.ok(fault, `${language}: add an integration fault for the new language`);
  const path = join(project, fault.path),
    original = readFileSync(path, "utf8");
  assert.equal(original.split(fault.before).length, 2, `${language}: expected exactly one fault location`);
  return { path, original, broken: original.replace(fault.before, fault.after) };
}

export function consumerSnapshot(project: string, paths: string[]): Record<string, string> {
  return Object.fromEntries(
    paths.map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(join(project, path)))
        .digest("hex"),
    ]),
  );
}

/** Applies only to disposable consumer fixtures; ordinary adoption retains the project's existing policy. */
export function configureConsumerCompiler(
  project: string,
  distribution: string,
  compiler: import("../scripts/compiler-catalog.mjs").CompilerFamily,
): void {
  const file = join(project, "workbench/projects.toml"),
    contents = readFileSync(file, "utf8");
  const registry = parse(contents);
  for (const raw of (registry.language_root as Record<string, unknown>[] | undefined) ?? []) {
    if (raw.language !== "c" && raw.language !== "cpp") continue;
    if (raw.compilers === undefined) {
      const template = parse(
        readFileSync(join(distribution, `languages/${raw.language}/config.toml`), "utf8"),
      ).starter_root;
      assert.ok(template && typeof template === "object" && !Array.isArray(template));
      Object.assign(raw, template);
    }
    raw.compiler = compiler;
  }
  writeFileSync(file, editToml(contents, registry));
}

/** Runs in a child with the fixture's explicit environment, never by replacing the parent's process.env. */
export function approveConsumerFixture(project: string, fixtureCharter: string): void {
  assert.ok(
    existsSync(join(project, ".workbench-consumer-fixture")),
    "Receipt creation requires an owned disposable fixture",
  );
  assert.equal(
    readFileSync(join(project, "workbench/CHARTER.md"), "utf8"),
    readFileSync(fixtureCharter, "utf8"),
    "Fixture charter must match the shipped human-written test charter",
  );
  approveReview(project, proposedReview(project).digest, true);
}

/** Preserve the adopted custom check while adding the real shipped application suite to the disposable fixture. */
export function enableAdoptedApplicationChecks(project: string, distribution: string, language: string): void {
  const metadata = parse(readFileSync(join(distribution, `languages/${language}/config.toml`), "utf8")) as {
    reference: string;
  };
  const quality = join(distribution, metadata.reference, "workbench/quality.json");
  mkdirSync(join(project, "workbench"), { recursive: true });
  if (existsSync(quality)) cpSync(quality, join(project, "workbench/quality.json"));
  const path = join(project, "workbench/automation.toml"),
    contents = readFileSync(path, "utf8"),
    automation = parse(contents);
  automation.check_suite = [...((automation.check_suite as TomlTable[] | undefined) ?? []), { language, path: "." }];
  writeFileSync(path, editToml(contents, automation));
  if (language === "c" || language === "cpp") {
    const registry = parse(readFileSync(join(project, "workbench/projects.toml"), "utf8"));
    const entry = (registry.language_root as Record<string, unknown>[]).find((entry) => entry.language === language);
    const compiler = entry?.compiler;
    configureConsumerCompiler(project, distribution, isCompilerFamily(compiler) ? compiler : "clang");
  }
}
