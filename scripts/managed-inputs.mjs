// Generated from managed-inputs.mts; edit the TypeScript source.
import { isMainScript } from "./script-entry.mjs";
import { required, isRecord, record, string } from "../app/src/core/runtime/values.mjs";
import { replaceManagedFiles } from "./managed-files.mjs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseToml, parseAllDocuments } from "../app/src/core/configuration/runtime-parsers.mjs";
import { managedCheckInputs } from "../app/src/core/execution/environments/managed/managed-check-inputs.mjs";
import { guixCheckInputs, nixCheckInputs } from "./managed-input-recipes.mjs";
function rustInputs(root) {
  const lock = parseToml(readFileSync(join(root, "Cargo.lock"), "utf8"));
  if (!Array.isArray(lock.package)) throw new Error("Cargo.lock has no package list");
  const crates = lock.package.map((entry) => record(entry, "Invalid locked Rust package")).filter((entry) => entry.source).map((entry) => ({
    source: string(entry.source, "Missing Rust source"),
    name: string(entry.name, "Missing crate name"),
    version: string(entry.version, "Missing crate version"),
    checksum: string(entry.checksum, "Missing crate checksum")
  }));
  for (const crate of crates)
    if (crate.source !== "registry+https://github.com/rust-lang/crates.io-index" || !/^[a-f0-9]{64}$/.test(crate.checksum))
      throw new Error(`Unsupported locked Rust source: ${crate.name}`);
  return ";; Generated from Cargo.lock by scripts/managed-inputs.mjs; do not edit.\n(use-modules (guix packages) (guix download) (guix base16))\n\n(list\n" + crates.map(
    (crate) => ` (list "rust-${crate.name}-${crate.version}"
       (origin
         (method url-fetch)
         (uri "https://static.crates.io/crates/${crate.name}/${crate.name}-${crate.version}.crate")
         (file-name "${crate.name}-${crate.version}.crate")
         (hash (content-hash (base16-string->bytevector "${crate.checksum}") sha256))))`
  ).join("\n") + ")\n";
}
function reactInputs(root) {
  const documents = parseAllDocuments(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
  for (const document of documents)
    if (document.errors.length) throw required(document.errors[0], "Missing YAML parse error");
  const packages = {};
  for (const document of documents)
    Object.assign(
      packages,
      record(record(document.toJSON(), "Invalid npm lock document").packages ?? {}, "Invalid npm package map")
    );
  const names = /* @__PURE__ */ new Set(["react", "react-dom", "scheduler"]);
  const inputs = Object.entries(packages).filter(([name]) => names.has(name.slice(0, name.lastIndexOf("@")))).map(([key, entry]) => {
    const integrity = string(
      record(record(entry, "Invalid npm package").resolution, "Missing npm resolution").integrity,
      "Missing npm integrity"
    );
    const at = key.lastIndexOf("@");
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity)) throw new Error(`Missing locked npm integrity: ${key}`);
    return {
      name,
      version,
      url: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity
    };
  });
  if (inputs.length !== names.size || new Set(inputs.map((entry) => entry.name)).size !== names.size)
    throw new Error("The React release needs exactly one locked version of each runtime dependency");
  return JSON.stringify(inputs, null, 2) + "\n";
}
function deriveManagedInputs(root, selected) {
  const outputs = [];
  const projects = parseToml(readFileSync(join(root, "workbench/projects.toml"), "utf8"));
  if (!Array.isArray(projects.language_root)) throw new Error("Missing language roots");
  const roots = projects.language_root.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") throw new Error("Invalid language root");
    return entry.path;
  });
  if (selected !== void 0 && !roots.includes(selected)) throw new Error(`Unknown language root: ${selected}`);
  for (const [directory, file, generate] of [
    ["examples/languages/rust", "guix-crates.scm", rustInputs],
    ["examples/frameworks/react", "managed-dependencies.json", reactInputs]
  ]) {
    if (selected !== void 0 && selected !== directory) continue;
    const location = join(root, directory, file);
    const expected = generate(join(root, directory));
    outputs.push([location, expected]);
  }
  for (const directory of new Set(roots)) {
    if (selected !== void 0 && selected !== directory) continue;
    for (const [file, expected] of [
      ["managed-check-inputs.json", `${JSON.stringify(managedCheckInputs(join(root, directory)), null, 2)}
`],
      ["check-inputs.scm", guixCheckInputs],
      ["check-inputs.nix", nixCheckInputs]
    ]) {
      const location = join(root, directory, file);
      outputs.push([location, expected]);
    }
  }
  return outputs;
}
if (isMainScript(import.meta.url)) {
  const { values } = parseArgs({ options: { check: { type: "boolean" }, path: { type: "string" } }, strict: true });
  const outputs = deriveManagedInputs(resolve(import.meta.dirname, ".."), values.path);
  if (values.check) {
    for (const [path, expected] of outputs)
      if (readFileSync(path, "utf8") !== expected) throw new Error(`${path}: regenerate managed inputs`);
  } else replaceManagedFiles(outputs);
}
export {
  deriveManagedInputs,
  reactInputs,
  rustInputs
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1hbmFnZWQtaW5wdXRzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBpc01haW5TY3JpcHQgfSBmcm9tIFwiLi9zY3JpcHQtZW50cnkubWpzXCI7XG5pbXBvcnQgeyByZXF1aXJlZCwgaXNSZWNvcmQsIHJlY29yZCwgc3RyaW5nIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL3ZhbHVlcy5tanNcIjtcblxuaW1wb3J0IHsgcmVwbGFjZU1hbmFnZWRGaWxlcyB9IGZyb20gXCIuL21hbmFnZWQtZmlsZXMubWpzXCI7XG5pbXBvcnQgeyByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IHBhcnNlVG9tbCwgcGFyc2VBbGxEb2N1bWVudHMgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL2NvbmZpZ3VyYXRpb24vcnVudGltZS1wYXJzZXJzLm1qc1wiO1xuaW1wb3J0IHsgbWFuYWdlZENoZWNrSW5wdXRzIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9leGVjdXRpb24vZW52aXJvbm1lbnRzL21hbmFnZWQvbWFuYWdlZC1jaGVjay1pbnB1dHMubWpzXCI7XG5pbXBvcnQgeyBndWl4Q2hlY2tJbnB1dHMsIG5peENoZWNrSW5wdXRzIH0gZnJvbSBcIi4vbWFuYWdlZC1pbnB1dC1yZWNpcGVzLm1qc1wiO1xuXG4vLyBEZXJpdmUgYnVpbGRlciBhY3F1aXNpdGlvbiBpbnB1dHMgZnJvbSBsYW5ndWFnZSBsb2NrczsgbmV2ZXIgcmVzb2x2ZSBwYWNrYWdlIHZlcnNpb25zIGhlcmUuXG5leHBvcnQgZnVuY3Rpb24gcnVzdElucHV0cyhyb290OiBzdHJpbmcpIHtcbiAgY29uc3QgbG9jayA9IHBhcnNlVG9tbChyZWFkRmlsZVN5bmMoam9pbihyb290LCBcIkNhcmdvLmxvY2tcIiksIFwidXRmOFwiKSk7XG4gIGlmICghQXJyYXkuaXNBcnJheShsb2NrLnBhY2thZ2UpKSB0aHJvdyBuZXcgRXJyb3IoXCJDYXJnby5sb2NrIGhhcyBubyBwYWNrYWdlIGxpc3RcIik7XG4gIGNvbnN0IGNyYXRlcyA9IGxvY2sucGFja2FnZVxuICAgIC5tYXAoKGVudHJ5KSA9PiByZWNvcmQoZW50cnksIFwiSW52YWxpZCBsb2NrZWQgUnVzdCBwYWNrYWdlXCIpKVxuICAgIC5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeS5zb3VyY2UpXG4gICAgLm1hcCgoZW50cnkpID0+ICh7XG4gICAgICBzb3VyY2U6IHN0cmluZyhlbnRyeS5zb3VyY2UsIFwiTWlzc2luZyBSdXN0IHNvdXJjZVwiKSxcbiAgICAgIG5hbWU6IHN0cmluZyhlbnRyeS5uYW1lLCBcIk1pc3NpbmcgY3JhdGUgbmFtZVwiKSxcbiAgICAgIHZlcnNpb246IHN0cmluZyhlbnRyeS52ZXJzaW9uLCBcIk1pc3NpbmcgY3JhdGUgdmVyc2lvblwiKSxcbiAgICAgIGNoZWNrc3VtOiBzdHJpbmcoZW50cnkuY2hlY2tzdW0sIFwiTWlzc2luZyBjcmF0ZSBjaGVja3N1bVwiKSxcbiAgICB9KSk7XG4gIGZvciAoY29uc3QgY3JhdGUgb2YgY3JhdGVzKVxuICAgIGlmIChcbiAgICAgIGNyYXRlLnNvdXJjZSAhPT0gXCJyZWdpc3RyeStodHRwczovL2dpdGh1Yi5jb20vcnVzdC1sYW5nL2NyYXRlcy5pby1pbmRleFwiIHx8XG4gICAgICAhL15bYS1mMC05XXs2NH0kLy50ZXN0KGNyYXRlLmNoZWNrc3VtKVxuICAgIClcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgbG9ja2VkIFJ1c3Qgc291cmNlOiAke2NyYXRlLm5hbWV9YCk7XG4gIHJldHVybiAoXG4gICAgXCI7OyBHZW5lcmF0ZWQgZnJvbSBDYXJnby5sb2NrIGJ5IHNjcmlwdHMvbWFuYWdlZC1pbnB1dHMubWpzOyBkbyBub3QgZWRpdC5cXG5cIiArXG4gICAgXCIodXNlLW1vZHVsZXMgKGd1aXggcGFja2FnZXMpIChndWl4IGRvd25sb2FkKSAoZ3VpeCBiYXNlMTYpKVxcblxcbihsaXN0XFxuXCIgK1xuICAgIGNyYXRlc1xuICAgICAgLm1hcChcbiAgICAgICAgKGNyYXRlKSA9PiBgIChsaXN0IFwicnVzdC0ke2NyYXRlLm5hbWV9LSR7Y3JhdGUudmVyc2lvbn1cIlxuICAgICAgIChvcmlnaW5cbiAgICAgICAgIChtZXRob2QgdXJsLWZldGNoKVxuICAgICAgICAgKHVyaSBcImh0dHBzOi8vc3RhdGljLmNyYXRlcy5pby9jcmF0ZXMvJHtjcmF0ZS5uYW1lfS8ke2NyYXRlLm5hbWV9LSR7Y3JhdGUudmVyc2lvbn0uY3JhdGVcIilcbiAgICAgICAgIChmaWxlLW5hbWUgXCIke2NyYXRlLm5hbWV9LSR7Y3JhdGUudmVyc2lvbn0uY3JhdGVcIilcbiAgICAgICAgIChoYXNoIChjb250ZW50LWhhc2ggKGJhc2UxNi1zdHJpbmctPmJ5dGV2ZWN0b3IgXCIke2NyYXRlLmNoZWNrc3VtfVwiKSBzaGEyNTYpKSkpYCxcbiAgICAgIClcbiAgICAgIC5qb2luKFwiXFxuXCIpICtcbiAgICBcIilcXG5cIlxuICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVhY3RJbnB1dHMocm9vdDogc3RyaW5nKSB7XG4gIGNvbnN0IGRvY3VtZW50cyA9IHBhcnNlQWxsRG9jdW1lbnRzKHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIFwicG5wbS1sb2NrLnlhbWxcIiksIFwidXRmOFwiKSk7XG4gIGZvciAoY29uc3QgZG9jdW1lbnQgb2YgZG9jdW1lbnRzKVxuICAgIGlmIChkb2N1bWVudC5lcnJvcnMubGVuZ3RoKSB0aHJvdyByZXF1aXJlZChkb2N1bWVudC5lcnJvcnNbMF0sIFwiTWlzc2luZyBZQU1MIHBhcnNlIGVycm9yXCIpO1xuICBjb25zdCBwYWNrYWdlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgZm9yIChjb25zdCBkb2N1bWVudCBvZiBkb2N1bWVudHMpXG4gICAgT2JqZWN0LmFzc2lnbihcbiAgICAgIHBhY2thZ2VzLFxuICAgICAgcmVjb3JkKHJlY29yZChkb2N1bWVudC50b0pTT04oKSwgXCJJbnZhbGlkIG5wbSBsb2NrIGRvY3VtZW50XCIpLnBhY2thZ2VzID8/IHt9LCBcIkludmFsaWQgbnBtIHBhY2thZ2UgbWFwXCIpLFxuICAgICk7XG4gIGNvbnN0IG5hbWVzID0gbmV3IFNldChbXCJyZWFjdFwiLCBcInJlYWN0LWRvbVwiLCBcInNjaGVkdWxlclwiXSk7XG4gIGNvbnN0IGlucHV0cyA9IE9iamVjdC5lbnRyaWVzKHBhY2thZ2VzKVxuICAgIC5maWx0ZXIoKFtuYW1lXSkgPT4gbmFtZXMuaGFzKG5hbWUuc2xpY2UoMCwgbmFtZS5sYXN0SW5kZXhPZihcIkBcIikpKSlcbiAgICAubWFwKChba2V5LCBlbnRyeV0pID0+IHtcbiAgICAgIGNvbnN0IGludGVncml0eSA9IHN0cmluZyhcbiAgICAgICAgcmVjb3JkKHJlY29yZChlbnRyeSwgXCJJbnZhbGlkIG5wbSBwYWNrYWdlXCIpLnJlc29sdXRpb24sIFwiTWlzc2luZyBucG0gcmVzb2x1dGlvblwiKS5pbnRlZ3JpdHksXG4gICAgICAgIFwiTWlzc2luZyBucG0gaW50ZWdyaXR5XCIsXG4gICAgICApO1xuICAgICAgY29uc3QgYXQgPSBrZXkubGFzdEluZGV4T2YoXCJAXCIpO1xuICAgICAgY29uc3QgbmFtZSA9IGtleS5zbGljZSgwLCBhdCk7XG4gICAgICBjb25zdCB2ZXJzaW9uID0ga2V5LnNsaWNlKGF0ICsgMSk7XG4gICAgICBpZiAoIS9ec2hhNTEyLVtBLVphLXowLTkrL10rPSokLy50ZXN0KGludGVncml0eSkpIHRocm93IG5ldyBFcnJvcihgTWlzc2luZyBsb2NrZWQgbnBtIGludGVncml0eTogJHtrZXl9YCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBuYW1lLFxuICAgICAgICB2ZXJzaW9uLFxuICAgICAgICB1cmw6IGBodHRwczovL3JlZ2lzdHJ5Lm5wbWpzLm9yZy8ke25hbWV9Ly0vJHtuYW1lfS0ke3ZlcnNpb259LnRnemAsXG4gICAgICAgIGludGVncml0eTogaW50ZWdyaXR5LFxuICAgICAgfTtcbiAgICB9KTtcbiAgaWYgKGlucHV0cy5sZW5ndGggIT09IG5hbWVzLnNpemUgfHwgbmV3IFNldChpbnB1dHMubWFwKChlbnRyeSkgPT4gZW50cnkubmFtZSkpLnNpemUgIT09IG5hbWVzLnNpemUpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiVGhlIFJlYWN0IHJlbGVhc2UgbmVlZHMgZXhhY3RseSBvbmUgbG9ja2VkIHZlcnNpb24gb2YgZWFjaCBydW50aW1lIGRlcGVuZGVuY3lcIik7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeShpbnB1dHMsIG51bGwsIDIpICsgXCJcXG5cIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlcml2ZU1hbmFnZWRJbnB1dHMocm9vdDogc3RyaW5nLCBzZWxlY3RlZD86IHN0cmluZyk6IFtzdHJpbmcsIHN0cmluZ11bXSB7XG4gIGNvbnN0IG91dHB1dHM6IFtzdHJpbmcsIHN0cmluZ11bXSA9IFtdO1xuICBjb25zdCBwcm9qZWN0cyA9IHBhcnNlVG9tbChyZWFkRmlsZVN5bmMoam9pbihyb290LCBcIndvcmtiZW5jaC9wcm9qZWN0cy50b21sXCIpLCBcInV0ZjhcIikpO1xuICBpZiAoIUFycmF5LmlzQXJyYXkocHJvamVjdHMubGFuZ3VhZ2Vfcm9vdCkpIHRocm93IG5ldyBFcnJvcihcIk1pc3NpbmcgbGFuZ3VhZ2Ugcm9vdHNcIik7XG4gIGNvbnN0IHJvb3RzID0gcHJvamVjdHMubGFuZ3VhZ2Vfcm9vdC5tYXAoKGVudHJ5KSA9PiB7XG4gICAgaWYgKCFpc1JlY29yZChlbnRyeSkgfHwgdHlwZW9mIGVudHJ5LnBhdGggIT09IFwic3RyaW5nXCIpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgbGFuZ3VhZ2Ugcm9vdFwiKTtcbiAgICByZXR1cm4gZW50cnkucGF0aDtcbiAgfSk7XG4gIGlmIChzZWxlY3RlZCAhPT0gdW5kZWZpbmVkICYmICFyb290cy5pbmNsdWRlcyhzZWxlY3RlZCkpIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBsYW5ndWFnZSByb290OiAke3NlbGVjdGVkfWApO1xuICBmb3IgKGNvbnN0IFtkaXJlY3RvcnksIGZpbGUsIGdlbmVyYXRlXSBvZiBbXG4gICAgW1wiZXhhbXBsZXMvbGFuZ3VhZ2VzL3J1c3RcIiwgXCJndWl4LWNyYXRlcy5zY21cIiwgcnVzdElucHV0c10sXG4gICAgW1wiZXhhbXBsZXMvZnJhbWV3b3Jrcy9yZWFjdFwiLCBcIm1hbmFnZWQtZGVwZW5kZW5jaWVzLmpzb25cIiwgcmVhY3RJbnB1dHNdLFxuICBdIGFzIGNvbnN0KSB7XG4gICAgaWYgKHNlbGVjdGVkICE9PSB1bmRlZmluZWQgJiYgc2VsZWN0ZWQgIT09IGRpcmVjdG9yeSkgY29udGludWU7XG4gICAgY29uc3QgbG9jYXRpb24gPSBqb2luKHJvb3QsIGRpcmVjdG9yeSwgZmlsZSk7XG4gICAgY29uc3QgZXhwZWN0ZWQgPSBnZW5lcmF0ZShqb2luKHJvb3QsIGRpcmVjdG9yeSkpO1xuICAgIG91dHB1dHMucHVzaChbbG9jYXRpb24sIGV4cGVjdGVkXSk7XG4gIH1cbiAgZm9yIChjb25zdCBkaXJlY3Rvcnkgb2YgbmV3IFNldChyb290cykpIHtcbiAgICBpZiAoc2VsZWN0ZWQgIT09IHVuZGVmaW5lZCAmJiBzZWxlY3RlZCAhPT0gZGlyZWN0b3J5KSBjb250aW51ZTtcbiAgICBmb3IgKGNvbnN0IFtmaWxlLCBleHBlY3RlZF0gb2YgW1xuICAgICAgW1wibWFuYWdlZC1jaGVjay1pbnB1dHMuanNvblwiLCBgJHtKU09OLnN0cmluZ2lmeShtYW5hZ2VkQ2hlY2tJbnB1dHMoam9pbihyb290LCBkaXJlY3RvcnkpKSwgbnVsbCwgMil9XFxuYF0sXG4gICAgICBbXCJjaGVjay1pbnB1dHMuc2NtXCIsIGd1aXhDaGVja0lucHV0c10sXG4gICAgICBbXCJjaGVjay1pbnB1dHMubml4XCIsIG5peENoZWNrSW5wdXRzXSxcbiAgICBdIGFzIGNvbnN0KSB7XG4gICAgICBjb25zdCBsb2NhdGlvbiA9IGpvaW4ocm9vdCwgZGlyZWN0b3J5LCBmaWxlKTtcbiAgICAgIG91dHB1dHMucHVzaChbbG9jYXRpb24sIGV4cGVjdGVkXSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBvdXRwdXRzO1xufVxuXG5pZiAoaXNNYWluU2NyaXB0KGltcG9ydC5tZXRhLnVybCkpIHtcbiAgY29uc3QgeyB2YWx1ZXMgfSA9IHBhcnNlQXJncyh7IG9wdGlvbnM6IHsgY2hlY2s6IHsgdHlwZTogXCJib29sZWFuXCIgfSwgcGF0aDogeyB0eXBlOiBcInN0cmluZ1wiIH0gfSwgc3RyaWN0OiB0cnVlIH0pO1xuICBjb25zdCBvdXRwdXRzID0gZGVyaXZlTWFuYWdlZElucHV0cyhyZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiLi5cIiksIHZhbHVlcy5wYXRoKTtcbiAgaWYgKHZhbHVlcy5jaGVjaykge1xuICAgIGZvciAoY29uc3QgW3BhdGgsIGV4cGVjdGVkXSBvZiBvdXRwdXRzKVxuICAgICAgaWYgKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikgIT09IGV4cGVjdGVkKSB0aHJvdyBuZXcgRXJyb3IoYCR7cGF0aH06IHJlZ2VuZXJhdGUgbWFuYWdlZCBpbnB1dHNgKTtcbiAgfSBlbHNlIHJlcGxhY2VNYW5hZ2VkRmlsZXMob3V0cHV0cyk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLFVBQVUsVUFBVSxRQUFRLGNBQWM7QUFFbkQsU0FBUywyQkFBMkI7QUFDcEMsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxNQUFNLGVBQWU7QUFDOUIsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxXQUFXLHlCQUF5QjtBQUM3QyxTQUFTLDBCQUEwQjtBQUNuQyxTQUFTLGlCQUFpQixzQkFBc0I7QUFHekMsU0FBUyxXQUFXLE1BQWM7QUFDdkMsUUFBTSxPQUFPLFVBQVUsYUFBYSxLQUFLLE1BQU0sWUFBWSxHQUFHLE1BQU0sQ0FBQztBQUNyRSxNQUFJLENBQUMsTUFBTSxRQUFRLEtB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QUFRLENBQUM7QUFBQSxJQUNuQztBQUFBLEVBQ0Y7QUFDQSxTQUFPO0FBQ1Q7QUFFQSxJQUFJLGFBQWEsWUFBWSxHQUFHLEdBQUc7QUFDakMsUUFBTSxFQUFFLE9BQU8sSUFBSSxVQUFVLEVBQUUsU0FBUyxFQUFFLE9BQU8sRUFBRSxNQUFNLFVBQVUsR0FBRyxNQUFNLEVBQUUsTUFBTSxTQUFTLEVBQUUsR0FBRyxRQUFRLEtBQUssQ0FBQztBQUNoSCxRQUFNLFVBQVUsb0JBQW9CLFFBQVEsWUFBWSxTQUFTLElBQUksR0FBRyxPQUFPLElBQUk7QUFDbkYsTUFBSSxPQUFPLE9BQU87QUFDaEIsZUFBVyxDQUFDLE1BQU0sUUFBUSxLQUFLO0FBQzdCLFVBQUksYUFBYSxNQUFNLE1BQU0sTUFBTSxTQUFVLE9BQU0sSUFBSSxNQUFNLEdBQUcsSUFBSSw2QkFBNkI7QUFBQSxFQUNyRyxNQUFPLHFCQUFvQixPQUFPO0FBQ3BDOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvbWFuYWdlZC1pbnB1dHMubWpzIn0=
