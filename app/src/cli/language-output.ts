import { join } from "node:path";
import { catalog, initLanguage as initializeLanguage, languageReport } from "../core/toolchains/languages.js";
import { quote } from "../core/toolchains/toolchains.js";
export function reportLanguages(root: string, selected?: string): void {
  for (const { project, name, configured, evidence, cmake, languages } of languageReport(root, selected)) {
    console.log(
      `${name}${project.name ? ` (${project.id})` : ""}: ${configured.map((entry) => `${entry.language}@${entry.path}`).join(", ") || "none"}`,
    );
    console.log(
      `  detected manifests: ${evidence.map(([language, description]) => `${language} (${description})`).join(", ") || "none"}`,
    );
    if (cmake && !evidence.some(([language]) => ["c", "cpp"].includes(language)))
      console.log(
        "  CMake language selection is not statically identified. CMake is not executed during discovery; use 'workbench init --adopt --language c' or 'cpp' for explicit registration.",
      );
    const reported = new Set<string>();
    for (const languageId of [
      ...configured.map((entry) => entry.language),
      ...evidence.map(([language]) => language),
    ]) {
      if (reported.has(languageId)) continue;
      reported.add(languageId);
      const language = languages.find((candidate) => candidate.id === languageId);
      console.log(
        language
          ? `  ${language.name} definition: ${language.source} (${language.directory}); reference: ${language.reference} (${language.summary})`
          : `  ${languageId}: no built-in reference project; configured checks remain authoritative`,
      );
    }
  }
}

export function initLanguage(root: string, languageId: string, path = "."): void {
  initializeLanguage(root, languageId, path);
  console.log(`Initialized ${languageId} at ${path}. Copied files and checks are project-owned.`);
  console.log(`Next: workbench tools install --path ${quote(path)}\nThen: workbench check --path ${quote(path)}`);
}

export function listLanguages(root: string): void {
  for (const language of catalog(root)) {
    console.log(`${language.id} (${language.name}): ${language.summary}`);
    console.log(
      `  initializer: ${language.starter ? "available" : "adopt existing code"}; native tool installation follows exact project pins; managed environments require project-owned definitions`,
    );
    console.log(`  definition: ${language.source} (${language.directory})`);
    console.log(`  reference: ${join(language.referenceRoot, language.reference)}`);
    for (const check of language.command) {
      console.log(`  role ${check.role}: ${check.command.join(" ")}`);
    }
  }
}
