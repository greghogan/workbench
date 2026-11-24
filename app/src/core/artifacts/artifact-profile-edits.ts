import { existsSync } from "node:fs";
import { parse } from "smol-toml";
import { editToml } from "../configuration/toml-edit.js";
import { readConfig, readProjects } from "../projects/project-configuration.js";
import { projectPaths } from "../projects/project-paths.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { readBoundedFile } from "../runtime/file-reads.js";
import { publishFile } from "../runtime/file-publication.mjs";
import { ownedPath } from "../runtime/paths.js";
import { record } from "../runtime/values.mjs";
import { checkArtifactProfiles, decodeArtifactCatalog, type ArtifactProfile } from "./artifact-catalog.js";

export function editArtifactProfile(
  root: string,
  operation: "add" | "edit" | "remove",
  name: string,
  source?: string | ArtifactProfile,
) {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new InvalidInput("Use a lowercase artifact profile name");
  const path = ownedPath(root, projectPaths.profiles);
  const original = existsSync(path) ? readBoundedFile(path, 2 * 1024 * 1024, "profiles catalog") : undefined;
  const text = original?.toString("utf8") ?? "schema_version = 1\n";
  const data = parse(text);
  const profiles = record(data.profiles ?? {}, "Invalid artifact profiles");
  const before = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  if ((operation === "add") !== (before === undefined))
    throw new StateConflict(before ? `Profile '${name}' already exists` : `Profile '${name}' does not exist`);
  const references = Object.entries(readConfig(root).ci?.images ?? {}).flatMap(([environment, profile]) =>
    profile === name ? [`ci.images.${environment}`] : [],
  );
  if (operation === "remove" && references.length)
    throw new InvalidInput(`Update the references to '${name}' first: ${references.join(", ")}`);
  if (operation !== "remove" && !source)
    throw new InvalidInput("Provide a TOML file containing the replacement profile table with --from");
  const after =
    typeof source === "string"
      ? parse(readBoundedFile(source, 256 * 1024, "artifact profile entry").toString("utf8"))
      : source;
  const updated =
    after === undefined
      ? Object.fromEntries(Object.entries(profiles).filter(([key]) => key !== name))
      : { ...profiles, [name]: after };
  const document = { ...data, profiles: updated };
  checkArtifactProfiles(root, decodeArtifactCatalog(document, new Set(readProjects(root).map(({ id }) => id))));
  const preview = { name, operation, before, after, references, applied: false };
  return {
    preview,
    apply: () => {
      publishFile(path, editToml(text, document), original);
      return { ...preview, applied: true };
    },
  };
}
