import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { expect, test } from "vitest";
import { validateManagedImageInputs } from "../src/image-input-validation.ts";

test("managed image input validation covers declarations, selected roots, and directory inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-image-validation-"));
  try {
    for (const path of ["workbench", "app", "other"]) mkdirSync(join(root, path));
    writeFileSync(
      join(root, "workbench/projects.toml"),
      '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="go"\npath="app"\n[[language_root]]\nlanguage="go"\npath="other"\n',
    );
    const declaration = { schema_version: 1, source_hashes: { "go.sum": "a".repeat(64) }, inputs: [] };
    for (const path of ["app", "other"])
      writeFileSync(join(root, path, "managed-check-inputs.json"), JSON.stringify(declaration));
    const profile = {
      name: "guix",
      builder: "guix",
      workspace: "host",
      container_config: ".devcontainer/guix.json",
      offline: { paths: ["app"], inputs: ["app/managed-check-inputs.json"], verify: ["true"] },
    };
    const save = () => {
      writeFileSync(
        join(root, "workbench/config.toml"),
        stringify({
          schema_version: 1,
          markdown: { wrap_width: 120 },
          compatibility: { required: false },
          development: { profiles: [profile] },
        }),
      );
    };
    save();
    expect(() => {
      validateManagedImageInputs(root);
    }).toThrow(/guix.*app\/go.sum/);
    profile.offline.inputs.push("app/go.sum");
    save();
    expect(() => {
      validateManagedImageInputs(root);
    }).not.toThrow();
    profile.offline.paths.push("other");
    save();
    expect(() => {
      validateManagedImageInputs(root);
    }).toThrow(/other\/managed-check-inputs/);
    profile.offline.inputs.push("other");
    save();
    expect(() => {
      validateManagedImageInputs(root);
    }).not.toThrow();
    profile.builder = "native";
    profile.offline.inputs = ["irrelevant"];
    save();
    expect(() => {
      validateManagedImageInputs(root);
    }).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
