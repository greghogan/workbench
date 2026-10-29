// Generated from managed-inputs.mts; edit the TypeScript source.
import { required, isRecord, record, string } from "./values.mjs";
import { replaceManagedFiles } from "./managed-files.mjs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseAllDocuments } from "yaml";
import { managedCheckInputs } from "./managed-check-inputs.mjs";
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
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const check = process.argv.includes("--check");
  const outputs = [];
  const root = resolve(import.meta.dirname, "..");
  for (const [directory, file, generate] of [
    ["examples/languages/rust", "guix-crates.scm", rustInputs],
    ["examples/frameworks/react", "managed-dependencies.json", reactInputs]
  ]) {
    const location = join(root, directory, file);
    const expected = generate(join(root, directory));
    if (check) {
      if (readFileSync(location, "utf8") !== expected) throw new Error(`${location}: regenerate managed inputs`);
    } else outputs.push([location, expected]);
  }
  const projects = parseToml(readFileSync(join(root, "workbench/projects.toml"), "utf8"));
  if (!Array.isArray(projects.language_root)) throw new Error("Missing language roots");
  const roots = projects.language_root.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") throw new Error("Invalid language root");
    return entry.path;
  });
  for (const directory of new Set(roots)) {
    for (const [file, expected] of [
      ["managed-check-inputs.json", `${JSON.stringify(managedCheckInputs(join(root, directory)), null, 2)}
`],
      ["check-inputs.scm", guixCheckInputs],
      ["check-inputs.nix", nixCheckInputs]
    ]) {
      const location = join(root, directory, file);
      if (check) {
        if (readFileSync(location, "utf8") !== expected)
          throw new Error(`${location}: regenerate managed check inputs`);
      } else {
        outputs.push([location, expected]);
      }
    }
  }
  if (!check) replaceManagedFiles(outputs);
}
export {
  reactInputs,
  rustInputs
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1hbmFnZWQtaW5wdXRzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXF1aXJlZCwgaXNSZWNvcmQsIHJlY29yZCwgc3RyaW5nIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuXG5pbXBvcnQgeyByZXBsYWNlTWFuYWdlZEZpbGVzIH0gZnJvbSBcIi4vbWFuYWdlZC1maWxlcy5tanNcIjtcbmltcG9ydCB7IHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcGFyc2UgYXMgcGFyc2VUb21sIH0gZnJvbSBcInNtb2wtdG9tbFwiO1xuaW1wb3J0IHsgcGFyc2VBbGxEb2N1bWVudHMgfSBmcm9tIFwieWFtbFwiO1xuaW1wb3J0IHsgbWFuYWdlZENoZWNrSW5wdXRzIH0gZnJvbSBcIi4vbWFuYWdlZC1jaGVjay1pbnB1dHMubWpzXCI7XG5pbXBvcnQgeyBndWl4Q2hlY2tJbnB1dHMsIG5peENoZWNrSW5wdXRzIH0gZnJvbSBcIi4vbWFuYWdlZC1pbnB1dC1yZWNpcGVzLm1qc1wiO1xuXG4vLyBEZXJpdmUgYnVpbGRlciBhY3F1aXNpdGlvbiBpbnB1dHMgZnJvbSBsYW5ndWFnZSBsb2NrczsgbmV2ZXIgcmVzb2x2ZSBwYWNrYWdlIHZlcnNpb25zIGhlcmUuXG5leHBvcnQgZnVuY3Rpb24gcnVzdElucHV0cyhyb290OiBzdHJpbmcpIHtcbiAgY29uc3QgbG9jayA9IHBhcnNlVG9tbChyZWFkRmlsZVN5bmMoam9pbihyb290LCBcIkNhcmdvLmxvY2tcIiksIFwidXRmOFwiKSk7XG4gIGlmICghQXJyYXkuaXNBcnJheShsb2NrLnBhY2thZ2UpKSB0aHJvdyBuZXcgRXJyb3IoXCJDYXJnby5sb2NrIGhhcyBubyBwYWNrYWdlIGxpc3RcIik7XG4gIGNvbnN0IGNyYXRlcyA9IGxvY2sucGFja2FnZVxuICAgIC5tYXAoKGVudHJ5KSA9PiByZWNvcmQoZW50cnksIFwiSW52YWxpZCBsb2NrZWQgUnVzdCBwYWNrYWdlXCIpKVxuICAgIC5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeS5zb3VyY2UpXG4gICAgLm1hcCgoZW50cnkpID0+ICh7XG4gICAgICBzb3VyY2U6IHN0cmluZyhlbnRyeS5zb3VyY2UsIFwiTWlzc2luZyBSdXN0IHNvdXJjZVwiKSxcbiAgICAgIG5hbWU6IHN0cmluZyhlbnRyeS5uYW1lLCBcIk1pc3NpbmcgY3JhdGUgbmFtZVwiKSxcbiAgICAgIHZlcnNpb246IHN0cmluZyhlbnRyeS52ZXJzaW9uLCBcIk1pc3NpbmcgY3JhdGUgdmVyc2lvblwiKSxcbiAgICAgIGNoZWNrc3VtOiBzdHJpbmcoZW50cnkuY2hlY2tzdW0sIFwiTWlzc2luZyBjcmF0ZSBjaGVja3N1bVwiKSxcbiAgICB9KSk7XG4gIGZvciAoY29uc3QgY3JhdGUgb2YgY3JhdGVzKVxuICAgIGlmIChcbiAgICAgIGNyYXRlLnNvdXJjZSAhPT0gXCJyZWdpc3RyeStodHRwczovL2dpdGh1Yi5jb20vcnVzdC1sYW5nL2NyYXRlcy5pby1pbmRleFwiIHx8XG4gICAgICAhL15bYS1mMC05XXs2NH0kLy50ZXN0KGNyYXRlLmNoZWNrc3VtKVxuICAgIClcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgbG9ja2VkIFJ1c3Qgc291cmNlOiAke2NyYXRlLm5hbWV9YCk7XG4gIHJldHVybiAoXG4gICAgXCI7OyBHZW5lcmF0ZWQgZnJvbSBDYXJnby5sb2NrIGJ5IHNjcmlwdHMvbWFuYWdlZC1pbnB1dHMubWpzOyBkbyBub3QgZWRpdC5cXG5cIiArXG4gICAgXCIodXNlLW1vZHVsZXMgKGd1aXggcGFja2FnZXMpIChndWl4IGRvd25sb2FkKSAoZ3VpeCBiYXNlMTYpKVxcblxcbihsaXN0XFxuXCIgK1xuICAgIGNyYXRlc1xuICAgICAgLm1hcChcbiAgICAgICAgKGNyYXRlKSA9PiBgIChsaXN0IFwicnVzdC0ke2NyYXRlLm5hbWV9LSR7Y3JhdGUudmVyc2lvbn1cIlxuICAgICAgIChvcmlnaW5cbiAgICAgICAgIChtZXRob2QgdXJsLWZldGNoKVxuICAgICAgICAgKHVyaSBcImh0dHBzOi8vc3RhdGljLmNyYXRlcy5pby9jcmF0ZXMvJHtjcmF0ZS5uYW1lfS8ke2NyYXRlLm5hbWV9LSR7Y3JhdGUudmVyc2lvbn0uY3JhdGVcIilcbiAgICAgICAgIChmaWxlLW5hbWUgXCIke2NyYXRlLm5hbWV9LSR7Y3JhdGUudmVyc2lvbn0uY3JhdGVcIilcbiAgICAgICAgIChoYXNoIChjb250ZW50LWhhc2ggKGJhc2UxNi1zdHJpbmctPmJ5dGV2ZWN0b3IgXCIke2NyYXRlLmNoZWNrc3VtfVwiKSBzaGEyNTYpKSkpYCxcbiAgICAgIClcbiAgICAgIC5qb2luKFwiXFxuXCIpICtcbiAgICBcIilcXG5cIlxuICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVhY3RJbnB1dHMocm9vdDogc3RyaW5nKSB7XG4gIGNvbnN0IGRvY3VtZW50cyA9IHBhcnNlQWxsRG9jdW1lbnRzKHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIFwicG5wbS1sb2NrLnlhbWxcIiksIFwidXRmOFwiKSk7XG4gIGZvciAoY29uc3QgZG9jdW1lbnQgb2YgZG9jdW1lbnRzKVxuICAgIGlmIChkb2N1bWVudC5lcnJvcnMubGVuZ3RoKSB0aHJvdyByZXF1aXJlZChkb2N1bWVudC5lcnJvcnNbMF0sIFwiTWlzc2luZyBZQU1MIHBhcnNlIGVycm9yXCIpO1xuICBjb25zdCBwYWNrYWdlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgZm9yIChjb25zdCBkb2N1bWVudCBvZiBkb2N1bWVudHMpXG4gICAgT2JqZWN0LmFzc2lnbihcbiAgICAgIHBhY2thZ2VzLFxuICAgICAgcmVjb3JkKHJlY29yZChkb2N1bWVudC50b0pTT04oKSwgXCJJbnZhbGlkIG5wbSBsb2NrIGRvY3VtZW50XCIpLnBhY2thZ2VzID8/IHt9LCBcIkludmFsaWQgbnBtIHBhY2thZ2UgbWFwXCIpLFxuICAgICk7XG4gIGNvbnN0IG5hbWVzID0gbmV3IFNldChbXCJyZWFjdFwiLCBcInJlYWN0LWRvbVwiLCBcInNjaGVkdWxlclwiXSk7XG4gIGNvbnN0IGlucHV0cyA9IE9iamVjdC5lbnRyaWVzKHBhY2thZ2VzKVxuICAgIC5maWx0ZXIoKFtuYW1lXSkgPT4gbmFtZXMuaGFzKG5hbWUuc2xpY2UoMCwgbmFtZS5sYXN0SW5kZXhPZihcIkBcIikpKSlcbiAgICAubWFwKChba2V5LCBlbnRyeV0pID0+IHtcbiAgICAgIGNvbnN0IGludGVncml0eSA9IHN0cmluZyhcbiAgICAgICAgcmVjb3JkKHJlY29yZChlbnRyeSwgXCJJbnZhbGlkIG5wbSBwYWNrYWdlXCIpLnJlc29sdXRpb24sIFwiTWlzc2luZyBucG0gcmVzb2x1dGlvblwiKS5pbnRlZ3JpdHksXG4gICAgICAgIFwiTWlzc2luZyBucG0gaW50ZWdyaXR5XCIsXG4gICAgICApO1xuICAgICAgY29uc3QgYXQgPSBrZXkubGFzdEluZGV4T2YoXCJAXCIpO1xuICAgICAgY29uc3QgbmFtZSA9IGtleS5zbGljZSgwLCBhdCk7XG4gICAgICBjb25zdCB2ZXJzaW9uID0ga2V5LnNsaWNlKGF0ICsgMSk7XG4gICAgICBpZiAoIS9ec2hhNTEyLVtBLVphLXowLTkrL10rPSokLy50ZXN0KGludGVncml0eSkpIHRocm93IG5ldyBFcnJvcihgTWlzc2luZyBsb2NrZWQgbnBtIGludGVncml0eTogJHtrZXl9YCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBuYW1lLFxuICAgICAgICB2ZXJzaW9uLFxuICAgICAgICB1cmw6IGBodHRwczovL3JlZ2lzdHJ5Lm5wbWpzLm9yZy8ke25hbWV9Ly0vJHtuYW1lfS0ke3ZlcnNpb259LnRnemAsXG4gICAgICAgIGludGVncml0eTogaW50ZWdyaXR5LFxuICAgICAgfTtcbiAgICB9KTtcbiAgaWYgKGlucHV0cy5sZW5ndGggIT09IG5hbWVzLnNpemUgfHwgbmV3IFNldChpbnB1dHMubWFwKChlbnRyeSkgPT4gZW50cnkubmFtZSkpLnNpemUgIT09IG5hbWVzLnNpemUpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiVGhlIFJlYWN0IHJlbGVhc2UgbmVlZHMgZXhhY3RseSBvbmUgbG9ja2VkIHZlcnNpb24gb2YgZWFjaCBydW50aW1lIGRlcGVuZGVuY3lcIik7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeShpbnB1dHMsIG51bGwsIDIpICsgXCJcXG5cIjtcbn1cblxuaWYgKHByb2Nlc3MuYXJndlsxXSAmJiByZXNvbHZlKHByb2Nlc3MuYXJndlsxXSkgPT09IGltcG9ydC5tZXRhLmZpbGVuYW1lKSB7XG4gIGNvbnN0IGNoZWNrID0gcHJvY2Vzcy5hcmd2LmluY2x1ZGVzKFwiLS1jaGVja1wiKTtcbiAgY29uc3Qgb3V0cHV0czogW3N0cmluZywgc3RyaW5nXVtdID0gW107XG4gIGNvbnN0IHJvb3QgPSByZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiLi5cIik7XG4gIGZvciAoY29uc3QgW2RpcmVjdG9yeSwgZmlsZSwgZ2VuZXJhdGVdIG9mIFtcbiAgICBbXCJleGFtcGxlcy9sYW5ndWFnZXMvcnVzdFwiLCBcImd1aXgtY3JhdGVzLnNjbVwiLCBydXN0SW5wdXRzXSxcbiAgICBbXCJleGFtcGxlcy9mcmFtZXdvcmtzL3JlYWN0XCIsIFwibWFuYWdlZC1kZXBlbmRlbmNpZXMuanNvblwiLCByZWFjdElucHV0c10sXG4gIF0gYXMgY29uc3QpIHtcbiAgICBjb25zdCBsb2NhdGlvbiA9IGpvaW4ocm9vdCwgZGlyZWN0b3J5LCBmaWxlKTtcbiAgICBjb25zdCBleHBlY3RlZCA9IGdlbmVyYXRlKGpvaW4ocm9vdCwgZGlyZWN0b3J5KSk7XG4gICAgaWYgKGNoZWNrKSB7XG4gICAgICBpZiAocmVhZEZpbGVTeW5jKGxvY2F0aW9uLCBcInV0ZjhcIikgIT09IGV4cGVjdGVkKSB0aHJvdyBuZXcgRXJyb3IoYCR7bG9jYXRpb259OiByZWdlbmVyYXRlIG1hbmFnZWQgaW5wdXRzYCk7XG4gICAgfSBlbHNlIG91dHB1dHMucHVzaChbbG9jYXRpb24sIGV4cGVjdGVkXSk7XG4gIH1cbiAgY29uc3QgcHJvamVjdHMgPSBwYXJzZVRvbWwocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJ3b3JrYmVuY2gvcHJvamVjdHMudG9tbFwiKSwgXCJ1dGY4XCIpKTtcbiAgaWYgKCFBcnJheS5pc0FycmF5KHByb2plY3RzLmxhbmd1YWdlX3Jvb3QpKSB0aHJvdyBuZXcgRXJyb3IoXCJNaXNzaW5nIGxhbmd1YWdlIHJvb3RzXCIpO1xuICBjb25zdCByb290cyA9IHByb2plY3RzLmxhbmd1YWdlX3Jvb3QubWFwKChlbnRyeSkgPT4ge1xuICAgIGlmICghaXNSZWNvcmQoZW50cnkpIHx8IHR5cGVvZiBlbnRyeS5wYXRoICE9PSBcInN0cmluZ1wiKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIGxhbmd1YWdlIHJvb3RcIik7XG4gICAgcmV0dXJuIGVudHJ5LnBhdGg7XG4gIH0pO1xuICBmb3IgKGNvbnN0IGRpcmVjdG9yeSBvZiBuZXcgU2V0KHJvb3RzKSkge1xuICAgIGZvciAoY29uc3QgW2ZpbGUsIGV4cGVjdGVkXSBvZiBbXG4gICAgICBbXCJtYW5hZ2VkLWNoZWNrLWlucHV0cy5qc29uXCIsIGAke0pTT04uc3RyaW5naWZ5KG1hbmFnZWRDaGVja0lucHV0cyhqb2luKHJvb3QsIGRpcmVjdG9yeSkpLCBudWxsLCAyKX1cXG5gXSxcbiAgICAgIFtcImNoZWNrLWlucHV0cy5zY21cIiwgZ3VpeENoZWNrSW5wdXRzXSxcbiAgICAgIFtcImNoZWNrLWlucHV0cy5uaXhcIiwgbml4Q2hlY2tJbnB1dHNdLFxuICAgIF0gYXMgY29uc3QpIHtcbiAgICAgIGNvbnN0IGxvY2F0aW9uID0gam9pbihyb290LCBkaXJlY3RvcnksIGZpbGUpO1xuICAgICAgaWYgKGNoZWNrKSB7XG4gICAgICAgIGlmIChyZWFkRmlsZVN5bmMobG9jYXRpb24sIFwidXRmOFwiKSAhPT0gZXhwZWN0ZWQpXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGAke2xvY2F0aW9ufTogcmVnZW5lcmF0ZSBtYW5hZ2VkIGNoZWNrIGlucHV0c2ApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgb3V0cHV0cy5wdXNoKFtsb2NhdGlvbiwgZXhwZWN0ZWRdKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgaWYgKCFjaGVjaykgcmVwbGFjZU1hbmFnZWRGaWxlcyhvdXRwdXRzKTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsVUFBVSxVQUFVLFFBQVEsY0FBYztBQUVuRCxTQUFTLDJCQUEyQjtBQUNwQyxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLE1BQU0sZUFBZTtBQUM5QixTQUFTLFNBQVMsaUJBQWlCO0FBQ25DLFNBQVMseUJBQXlCO0FBQ2xDLFNBQVMsMEJBQTBCO0FBQ25DLFNBQVMsaUJBQWlCLHNCQUFzQjtBQUd6QyxTQUFTLFdBQVcsTUFBYztBQUN2QyxRQUFNLE9BQU8sVUFBVSxhQUFhLEtBQUssTUFBTSxZQUFZLEdBQUcsTUFBTSxDQUFDO0FBQ3JFLE1BQUksQ0FBQyxNQUFNLFFBQVEsS0FBSyxPQUFPLEVBQUcsT0FBTSxJQUFJLE1BQU0sZ0NBQWdDO0FBQ2xGLFFBQU0sU0FBUyxLQUFLLFFBQ2pCLElBQUksQ0FBQyxVQUFVLE9BQU8sT0FBTyw2QkFBNkIsQ0FBQyxFQUMzRCxPQUFPLENBQUMsVUFBVSxNQUFNLE1BQU0sRUFDOUIsSUFBSSxDQUFDLFdBQVc7QUFBQSxJQUNmLFFBQVEsT0FBTyxNQUFNLFFBQVEscUJBQXFCO0FBQUEsSUFDbEQsTUFBTSxPQUFPLE1BQU0sTUFBTSxvQkFBb0I7QUFBQSxJQUM3QyxTQUFTLE9BQU8sTUFBTSxTQUFTLHVCQUF1QjtBQUFBLElBQ3RELFVBQVUsT0FBTyxNQUFNLFVBQVUsd0JBQXdCO0FBQUEsRUFDM0QsRUFBRTtBQUNKLGFBQVcsU0FBUztBQUNsQixRQUNFLE1BQU0sV0FBVywyREFDakIsQ0FBQyxpQkFBaUIsS0FBSyxNQUFNLFFBQVE7QUFFckMsWUFBTSxJQUFJLE1BQU0sbUNBQW1DLE1BQU0sSUFBSSxFQUFFO0FBQ25FLFNBQ0UscUpBRUEsT0FDRztBQUFBLElBQ0MsQ0FBQyxV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
