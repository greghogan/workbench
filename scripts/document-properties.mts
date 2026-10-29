import assert from "node:assert/strict";
import fc from "fast-check";
import { parse } from "smol-toml";
import { editToml } from "../src/toml-edit.ts";
import { relativePath, registeredRootPath } from "../src/paths.ts";
import { projectsFromData } from "../src/project-configuration.ts";

const scalar = fc.oneof(fc.string(), fc.boolean(), fc.integer());

export interface PropertyOptions {
  numRuns: number;
  seed: number;
  path?: string;
}
export interface PropertyOutcome {
  id: string;
  status: "passed" | "failed" | "aborted";
  seed: number;
  path?: string;
  counterexample?: unknown;
  error?: string;
}
export const propertyTitles = {
  "toml-values": "generated TOML edits preserve independent values, comments, and idempotence",
  "toml-structure": "generated TOML structural edits retain comments when values become tables or disappear",
  "relative-paths": "generated project names preserve spaces and Unicode while rejecting path escapes",
  "scope-ownership": "generated scope registrations preserve identities and reject ambiguous ownership",
} as const;
export type PropertyID = keyof typeof propertyTitles;
export function isPropertyID(value: string): value is PropertyID {
  return Object.hasOwn(propertyTitles, value);
}
export const documentProperties: Record<PropertyID, (options: PropertyOptions) => PropertyOutcome> = {
  "toml-values": (options) => {
    return outcome(
      "toml-values",
      fc.check(
        fc.property(fc.oneof(scalar, fc.array(scalar, { maxLength: 12 })), (value) => {
          const source =
            '# document comment\n[values] # table comment\nkeep = "unchanged" # preserved comment\nchange = 0 # value comment\n';
          const desired = { values: { keep: "unchanged", change: value } };
          const edited = editToml(source, desired);
          assert.deepEqual(JSON.parse(JSON.stringify(parse(edited))) as unknown, desired);
          assert.ok(edited.includes('keep = "unchanged" # preserved comment'));
          for (const comment of ["# document comment", "# table comment", "# preserved comment", "# value comment"])
            assert.equal(edited.split(comment).length, 2);
          assert.equal(editToml(edited, desired), edited);
        }),
        options,
      ),
    );
  },
  "toml-structure": (options) => {
    return outcome(
      "toml-structure",
      fc.check(
        fc.property(fc.string(), fc.integer(), (name, count) => {
          const source = "# root\n[settings]\nreplace = 1 # retain this\nremove = true # retain that\n";
          const desired = { settings: { replace: { name, count } } };
          const edited = editToml(source, desired);
          assert.deepEqual(JSON.parse(JSON.stringify(parse(edited))) as unknown, desired);
          assert.ok(edited.includes("# retain this"));
          assert.ok(edited.includes("# retain that"));
          assert.equal(editToml(edited, desired), edited);
        }),
        options,
      ),
    );
  },
  "relative-paths": (options) => {
    const segment = fc
      .array(fc.constantFrom("a", "Z", "0", " ", "λ", "🍌", "-", "_"), { minLength: 1, maxLength: 16 })
      .map((parts) => parts.join(""));
    return outcome(
      "relative-paths",
      fc.check(
        fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (parts) => {
          const path = parts.join("/");
          relativePath(path, "generated path");
          registeredRootPath(path, "generated scope");
          for (const escaped of [
            `../${path}`,
            `/${path}`,
            `${path}/..`,
            `C:\\${path}`,
            `${path}//child`,
            `${path}\\child`,
            `${path}:child`,
            `${path}/bad\0name`,
          ])
            assert.throws(() => {
              relativePath(escaped, "generated path");
            }, /unsafe relative path/);
        }),
        options,
      ),
    );
  },
  "scope-ownership": (options) => {
    return outcome(
      "scope-ownership",
      fc.check(
        fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 100_000 }), { maxLength: 20 }), (ids) => {
          const project = [
            { id: "root", path: "." },
            { id: "anchor", path: "library" },
            ...ids.map((id) => ({ id: `scope-${String(id)}`, path: `components ${String(id)}/λ` })),
          ];
          assert.deepEqual(projectsFromData({ project }, "generated registry"), project);
          for (const duplicate of [
            { id: "other", path: "library" },
            { id: "anchor", path: "another" },
          ])
            assert.throws(
              () => projectsFromData({ project: [...project, duplicate] }, "generated registry"),
              /duplicate/,
            );
        }),
        options,
      ),
    );
  },
};

function outcome<T>(id: PropertyID, result: fc.RunDetails<T>): PropertyOutcome {
  return {
    id,
    status: result.interrupted ? "aborted" : result.failed ? "failed" : "passed",
    seed: result.seed,
    ...(result.failed
      ? {
          ...(result.counterexamplePath === null ? {} : { path: result.counterexamplePath }),
          counterexample: result.counterexample,
          error: String(result.errorInstance),
        }
      : {}),
  };
}
export function verifyProperty(id: PropertyID, options: PropertyOptions): void {
  const result = documentProperties[id](options);
  assert.equal(result.status, "passed", JSON.stringify(result));
}

export function decodePropertyOutcome(value: unknown, id: PropertyID): PropertyOutcome {
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    value.id !== id ||
    !("status" in value) ||
    !["passed", "failed", "aborted"].includes(String(value.status)) ||
    !("seed" in value) ||
    typeof value.seed !== "number" ||
    !Number.isSafeInteger(value.seed)
  )
    throw new Error("Invalid property outcome");
  if (
    value.status === "failed" &&
    (!("path" in value) ||
      typeof value.path !== "string" ||
      !("counterexample" in value) ||
      !Array.isArray(value.counterexample))
  )
    throw new Error("Missing property counterexample");
  return value as PropertyOutcome;
}
