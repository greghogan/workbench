// Generated from managed-inputs.mts; edit the TypeScript source.
import { required } from "./values.mjs";
import { isRecord, record, string } from "./values.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1hbmFnZWQtaW5wdXRzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXF1aXJlZCB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IGlzUmVjb3JkLCByZWNvcmQsIHN0cmluZyB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IHJlcGxhY2VNYW5hZ2VkRmlsZXMgfSBmcm9tIFwiLi9tYW5hZ2VkLWZpbGVzLm1qc1wiO1xuaW1wb3J0IHsgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBwYXJzZSBhcyBwYXJzZVRvbWwgfSBmcm9tIFwic21vbC10b21sXCI7XG5pbXBvcnQgeyBwYXJzZUFsbERvY3VtZW50cyB9IGZyb20gXCJ5YW1sXCI7XG5pbXBvcnQgeyBtYW5hZ2VkQ2hlY2tJbnB1dHMgfSBmcm9tIFwiLi9tYW5hZ2VkLWNoZWNrLWlucHV0cy5tanNcIjtcbmltcG9ydCB7IGd1aXhDaGVja0lucHV0cywgbml4Q2hlY2tJbnB1dHMgfSBmcm9tIFwiLi9tYW5hZ2VkLWlucHV0LXJlY2lwZXMubWpzXCI7XG5cbi8vIERlcml2ZSBidWlsZGVyIGFjcXVpc2l0aW9uIGlucHV0cyBmcm9tIGxhbmd1YWdlIGxvY2tzOyBuZXZlciByZXNvbHZlIHBhY2thZ2UgdmVyc2lvbnMgaGVyZS5cbmV4cG9ydCBmdW5jdGlvbiBydXN0SW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICBjb25zdCBsb2NrID0gcGFyc2VUb21sKHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIFwiQ2FyZ28ubG9ja1wiKSwgXCJ1dGY4XCIpKTtcbiAgaWYgKCFBcnJheS5pc0FycmF5KGxvY2sucGFja2FnZSkpIHRocm93IG5ldyBFcnJvcihcIkNhcmdvLmxvY2sgaGFzIG5vIHBhY2thZ2UgbGlzdFwiKTtcbiAgY29uc3QgY3JhdGVzID0gbG9jay5wYWNrYWdlXG4gICAgLm1hcCgoZW50cnkpID0+IHJlY29yZChlbnRyeSwgXCJJbnZhbGlkIGxvY2tlZCBSdXN0IHBhY2thZ2VcIikpXG4gICAgLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LnNvdXJjZSlcbiAgICAubWFwKChlbnRyeSkgPT4gKHtcbiAgICAgIHNvdXJjZTogc3RyaW5nKGVudHJ5LnNvdXJjZSwgXCJNaXNzaW5nIFJ1c3Qgc291cmNlXCIpLFxuICAgICAgbmFtZTogc3RyaW5nKGVudHJ5Lm5hbWUsIFwiTWlzc2luZyBjcmF0ZSBuYW1lXCIpLFxuICAgICAgdmVyc2lvbjogc3RyaW5nKGVudHJ5LnZlcnNpb24sIFwiTWlzc2luZyBjcmF0ZSB2ZXJzaW9uXCIpLFxuICAgICAgY2hlY2tzdW06IHN0cmluZyhlbnRyeS5jaGVja3N1bSwgXCJNaXNzaW5nIGNyYXRlIGNoZWNrc3VtXCIpLFxuICAgIH0pKTtcbiAgZm9yIChjb25zdCBjcmF0ZSBvZiBjcmF0ZXMpXG4gICAgaWYgKFxuICAgICAgY3JhdGUuc291cmNlICE9PSBcInJlZ2lzdHJ5K2h0dHBzOi8vZ2l0aHViLmNvbS9ydXN0LWxhbmcvY3JhdGVzLmlvLWluZGV4XCIgfHxcbiAgICAgICEvXlthLWYwLTldezY0fSQvLnRlc3QoY3JhdGUuY2hlY2tzdW0pXG4gICAgKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBsb2NrZWQgUnVzdCBzb3VyY2U6ICR7Y3JhdGUubmFtZX1gKTtcbiAgcmV0dXJuIChcbiAgICBcIjs7IEdlbmVyYXRlZCBmcm9tIENhcmdvLmxvY2sgYnkgc2NyaXB0cy9tYW5hZ2VkLWlucHV0cy5tanM7IGRvIG5vdCBlZGl0LlxcblwiICtcbiAgICBcIih1c2UtbW9kdWxlcyAoZ3VpeCBwYWNrYWdlcykgKGd1aXggZG93bmxvYWQpIChndWl4IGJhc2UxNikpXFxuXFxuKGxpc3RcXG5cIiArXG4gICAgY3JhdGVzXG4gICAgICAubWFwKFxuICAgICAgICAoY3JhdGUpID0+IGAgKGxpc3QgXCJydXN0LSR7Y3JhdGUubmFtZX0tJHtjcmF0ZS52ZXJzaW9ufVwiXG4gICAgICAgKG9yaWdpblxuICAgICAgICAgKG1ldGhvZCB1cmwtZmV0Y2gpXG4gICAgICAgICAodXJpIFwiaHR0cHM6Ly9zdGF0aWMuY3JhdGVzLmlvL2NyYXRlcy8ke2NyYXRlLm5hbWV9LyR7Y3JhdGUubmFtZX0tJHtjcmF0ZS52ZXJzaW9ufS5jcmF0ZVwiKVxuICAgICAgICAgKGZpbGUtbmFtZSBcIiR7Y3JhdGUubmFtZX0tJHtjcmF0ZS52ZXJzaW9ufS5jcmF0ZVwiKVxuICAgICAgICAgKGhhc2ggKGNvbnRlbnQtaGFzaCAoYmFzZTE2LXN0cmluZy0+Ynl0ZXZlY3RvciBcIiR7Y3JhdGUuY2hlY2tzdW19XCIpIHNoYTI1NikpKSlgLFxuICAgICAgKVxuICAgICAgLmpvaW4oXCJcXG5cIikgK1xuICAgIFwiKVxcblwiXG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWFjdElucHV0cyhyb290OiBzdHJpbmcpIHtcbiAgY29uc3QgZG9jdW1lbnRzID0gcGFyc2VBbGxEb2N1bWVudHMocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJwbnBtLWxvY2sueWFtbFwiKSwgXCJ1dGY4XCIpKTtcbiAgZm9yIChjb25zdCBkb2N1bWVudCBvZiBkb2N1bWVudHMpXG4gICAgaWYgKGRvY3VtZW50LmVycm9ycy5sZW5ndGgpIHRocm93IHJlcXVpcmVkKGRvY3VtZW50LmVycm9yc1swXSwgXCJNaXNzaW5nIFlBTUwgcGFyc2UgZXJyb3JcIik7XG4gIGNvbnN0IHBhY2thZ2VzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBmb3IgKGNvbnN0IGRvY3VtZW50IG9mIGRvY3VtZW50cylcbiAgICBPYmplY3QuYXNzaWduKFxuICAgICAgcGFja2FnZXMsXG4gICAgICByZWNvcmQocmVjb3JkKGRvY3VtZW50LnRvSlNPTigpLCBcIkludmFsaWQgbnBtIGxvY2sgZG9jdW1lbnRcIikucGFja2FnZXMgPz8ge30sIFwiSW52YWxpZCBucG0gcGFja2FnZSBtYXBcIiksXG4gICAgKTtcbiAgY29uc3QgbmFtZXMgPSBuZXcgU2V0KFtcInJlYWN0XCIsIFwicmVhY3QtZG9tXCIsIFwic2NoZWR1bGVyXCJdKTtcbiAgY29uc3QgaW5wdXRzID0gT2JqZWN0LmVudHJpZXMocGFja2FnZXMpXG4gICAgLmZpbHRlcigoW25hbWVdKSA9PiBuYW1lcy5oYXMobmFtZS5zbGljZSgwLCBuYW1lLmxhc3RJbmRleE9mKFwiQFwiKSkpKVxuICAgIC5tYXAoKFtrZXksIGVudHJ5XSkgPT4ge1xuICAgICAgY29uc3QgaW50ZWdyaXR5ID0gc3RyaW5nKFxuICAgICAgICByZWNvcmQocmVjb3JkKGVudHJ5LCBcIkludmFsaWQgbnBtIHBhY2thZ2VcIikucmVzb2x1dGlvbiwgXCJNaXNzaW5nIG5wbSByZXNvbHV0aW9uXCIpLmludGVncml0eSxcbiAgICAgICAgXCJNaXNzaW5nIG5wbSBpbnRlZ3JpdHlcIixcbiAgICAgICk7XG4gICAgICBjb25zdCBhdCA9IGtleS5sYXN0SW5kZXhPZihcIkBcIik7XG4gICAgICBjb25zdCBuYW1lID0ga2V5LnNsaWNlKDAsIGF0KTtcbiAgICAgIGNvbnN0IHZlcnNpb24gPSBrZXkuc2xpY2UoYXQgKyAxKTtcbiAgICAgIGlmICghL15zaGE1MTItW0EtWmEtejAtOSsvXSs9KiQvLnRlc3QoaW50ZWdyaXR5KSkgdGhyb3cgbmV3IEVycm9yKGBNaXNzaW5nIGxvY2tlZCBucG0gaW50ZWdyaXR5OiAke2tleX1gKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG5hbWUsXG4gICAgICAgIHZlcnNpb24sXG4gICAgICAgIHVybDogYGh0dHBzOi8vcmVnaXN0cnkubnBtanMub3JnLyR7bmFtZX0vLS8ke25hbWV9LSR7dmVyc2lvbn0udGd6YCxcbiAgICAgICAgaW50ZWdyaXR5OiBpbnRlZ3JpdHksXG4gICAgICB9O1xuICAgIH0pO1xuICBpZiAoaW5wdXRzLmxlbmd0aCAhPT0gbmFtZXMuc2l6ZSB8fCBuZXcgU2V0KGlucHV0cy5tYXAoKGVudHJ5KSA9PiBlbnRyeS5uYW1lKSkuc2l6ZSAhPT0gbmFtZXMuc2l6ZSlcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJUaGUgUmVhY3QgcmVsZWFzZSBuZWVkcyBleGFjdGx5IG9uZSBsb2NrZWQgdmVyc2lvbiBvZiBlYWNoIHJ1bnRpbWUgZGVwZW5kZW5jeVwiKTtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGlucHV0cywgbnVsbCwgMikgKyBcIlxcblwiO1xufVxuXG5pZiAocHJvY2Vzcy5hcmd2WzFdICYmIHJlc29sdmUocHJvY2Vzcy5hcmd2WzFdKSA9PT0gaW1wb3J0Lm1ldGEuZmlsZW5hbWUpIHtcbiAgY29uc3QgY2hlY2sgPSBwcm9jZXNzLmFyZ3YuaW5jbHVkZXMoXCItLWNoZWNrXCIpO1xuICBjb25zdCBvdXRwdXRzOiBbc3RyaW5nLCBzdHJpbmddW10gPSBbXTtcbiAgY29uc3Qgcm9vdCA9IHJlc29sdmUoaW1wb3J0Lm1ldGEuZGlybmFtZSwgXCIuLlwiKTtcbiAgZm9yIChjb25zdCBbZGlyZWN0b3J5LCBmaWxlLCBnZW5lcmF0ZV0gb2YgW1xuICAgIFtcImV4YW1wbGVzL2xhbmd1YWdlcy9ydXN0XCIsIFwiZ3VpeC1jcmF0ZXMuc2NtXCIsIHJ1c3RJbnB1dHNdLFxuICAgIFtcImV4YW1wbGVzL2ZyYW1ld29ya3MvcmVhY3RcIiwgXCJtYW5hZ2VkLWRlcGVuZGVuY2llcy5qc29uXCIsIHJlYWN0SW5wdXRzXSxcbiAgXSBhcyBjb25zdCkge1xuICAgIGNvbnN0IGxvY2F0aW9uID0gam9pbihyb290LCBkaXJlY3RvcnksIGZpbGUpO1xuICAgIGNvbnN0IGV4cGVjdGVkID0gZ2VuZXJhdGUoam9pbihyb290LCBkaXJlY3RvcnkpKTtcbiAgICBpZiAoY2hlY2spIHtcbiAgICAgIGlmIChyZWFkRmlsZVN5bmMobG9jYXRpb24sIFwidXRmOFwiKSAhPT0gZXhwZWN0ZWQpIHRocm93IG5ldyBFcnJvcihgJHtsb2NhdGlvbn06IHJlZ2VuZXJhdGUgbWFuYWdlZCBpbnB1dHNgKTtcbiAgICB9IGVsc2Ugb3V0cHV0cy5wdXNoKFtsb2NhdGlvbiwgZXhwZWN0ZWRdKTtcbiAgfVxuICBjb25zdCBwcm9qZWN0cyA9IHBhcnNlVG9tbChyZWFkRmlsZVN5bmMoam9pbihyb290LCBcIndvcmtiZW5jaC9wcm9qZWN0cy50b21sXCIpLCBcInV0ZjhcIikpO1xuICBpZiAoIUFycmF5LmlzQXJyYXkocHJvamVjdHMubGFuZ3VhZ2Vfcm9vdCkpIHRocm93IG5ldyBFcnJvcihcIk1pc3NpbmcgbGFuZ3VhZ2Ugcm9vdHNcIik7XG4gIGNvbnN0IHJvb3RzID0gcHJvamVjdHMubGFuZ3VhZ2Vfcm9vdC5tYXAoKGVudHJ5KSA9PiB7XG4gICAgaWYgKCFpc1JlY29yZChlbnRyeSkgfHwgdHlwZW9mIGVudHJ5LnBhdGggIT09IFwic3RyaW5nXCIpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgbGFuZ3VhZ2Ugcm9vdFwiKTtcbiAgICByZXR1cm4gZW50cnkucGF0aDtcbiAgfSk7XG4gIGZvciAoY29uc3QgZGlyZWN0b3J5IG9mIG5ldyBTZXQocm9vdHMpKSB7XG4gICAgZm9yIChjb25zdCBbZmlsZSwgZXhwZWN0ZWRdIG9mIFtcbiAgICAgIFtcIm1hbmFnZWQtY2hlY2staW5wdXRzLmpzb25cIiwgYCR7SlNPTi5zdHJpbmdpZnkobWFuYWdlZENoZWNrSW5wdXRzKGpvaW4ocm9vdCwgZGlyZWN0b3J5KSksIG51bGwsIDIpfVxcbmBdLFxuICAgICAgW1wiY2hlY2staW5wdXRzLnNjbVwiLCBndWl4Q2hlY2tJbnB1dHNdLFxuICAgICAgW1wiY2hlY2staW5wdXRzLm5peFwiLCBuaXhDaGVja0lucHV0c10sXG4gICAgXSBhcyBjb25zdCkge1xuICAgICAgY29uc3QgbG9jYXRpb24gPSBqb2luKHJvb3QsIGRpcmVjdG9yeSwgZmlsZSk7XG4gICAgICBpZiAoY2hlY2spIHtcbiAgICAgICAgaWYgKHJlYWRGaWxlU3luYyhsb2NhdGlvbiwgXCJ1dGY4XCIpICE9PSBleHBlY3RlZClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYCR7bG9jYXRpb259OiByZWdlbmVyYXRlIG1hbmFnZWQgY2hlY2sgaW5wdXRzYCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBvdXRwdXRzLnB1c2goW2xvY2F0aW9uLCBleHBlY3RlZF0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICBpZiAoIWNoZWNrKSByZXBsYWNlTWFuYWdlZEZpbGVzKG91dHB1dHMpO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxVQUFVLFFBQVEsY0FBYztBQUN6QyxTQUFTLDJCQUEyQjtBQUNwQyxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLE1BQU0sZUFBZTtBQUM5QixTQUFTLFNBQVMsaUJBQWlCO0FBQ25DLFNBQVMseUJBQXlCO0FBQ2xDLFNBQVMsMEJBQTBCO0FBQ25DLFNBQVMsaUJBQWlCLHNCQUFzQjtBQUd6QyxTQUFTLFdBQVcsTUFBYztBQUN2QyxRQUFNLE9BQU8sVUFBVSxhQUFhLEtBQUssTUFBTSxZQUFZLEdBQUcsTUFBTSxDQUFDO0FBQ3JFLE1BQUksQ0FBQyxNQUFNLFFBQVEsS0FBSyxPQUFPLEVBQUcsT0FBTSxJQUFJLE1BQU0sZ0NBQWdDO0FBQ2xGLFFBQU0sU0FBUyxLQUFLLFFBQ2pCLElBQUksQ0FBQyxVQUFVLE9BQU8sT0FBTyw2QkFBNkIsQ0FBQyxFQUMzRCxPQUFPLENBQUMsVUFBVSxNQUFNLE1BQU0sRUFDOUIsSUFBSSxDQUFDLFdBQVc7QUFBQSxJQUNmLFFBQVEsT0FBTyxNQUFNLFFBQVEscUJBQXFCO0FBQUEsSUFDbEQsTUFBTSxPQUFPLE1BQU0sTUFBTSxvQkFBb0I7QUFBQSxJQUM3QyxTQUFTLE9BQU8sTUFBTSxTQUFTLHVCQUF1QjtBQUFBLElBQ3RELFVBQVUsT0FBTyxNQUFNLFVBQVUsd0JBQXdCO0FBQUEsRUFDM0QsRUFBRTtBQUNKLGFBQVcsU0FBUztBQUNsQixRQUNFLE1BQU0sV0FBVywyREFDakIsQ0FBQyxpQkFBaUIsS0FBSyxNQUFNLFFBQVE7QUFFckMsWUFBTSxJQUFJLE1BQU0sbUNBQW1DLE1BQU0sSUFB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
