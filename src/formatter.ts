import { extname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Options } from "prettier";
import { parseDocument } from "yaml";
import { splitFrontmatter } from "./record-document.js";

function yamlValue(contents: string, path: string): unknown {
  const document = parseDocument(contents);
  if (document.errors.length)
    throw new Error(`${path}: invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  return document.toJS();
}

/** The bundled plugins require no formatter installation in a consuming project. */
export async function formatDocument(contents: string, path: string, width: number): Promise<string> {
  const extension = extname(path).toLowerCase();
  const parser =
    extension === ".md"
      ? "markdown"
      : extension === ".json"
        ? "json"
        : [".yaml", ".yml"].includes(extension)
          ? "yaml"
          : undefined;
  if (!parser) throw new Error(`${path}: supported formats are Markdown (.md), JSON (.json), and YAML (.yaml or .yml)`);
  const jsonValue: unknown = parser === "json" ? JSON.parse(contents) : undefined;
  // Keep the formatter bundled and offline, but initialize it only for formatting work.
  const [{ format }, markdownPlugin, yamlPlugin, babelPlugin, estreePlugin] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/markdown"),
    import("prettier/plugins/yaml"),
    import("prettier/plugins/babel"),
    import("prettier/plugins/estree"),
  ]);
  const options: Options = {
    plugins: [markdownPlugin, yamlPlugin, babelPlugin, estreePlugin],
    printWidth: width,
    proseWrap: "always",
    embeddedLanguageFormatting: "off",
    endOfLine: "lf",
    tabWidth: 2,
    useTabs: false,
  };
  const frontmatter = parser === "markdown" ? splitFrontmatter(contents) : undefined;
  // Disabling embedded code formatting also disables frontmatter formatting in Markdown.
  // Format its YAML explicitly so metadata is canonical while fenced evidence stays untouched.
  const input = frontmatter
    ? `---\n${await format(frontmatter.yaml, { ...options, parser: "yaml" })}---\n\n${frontmatter.body}`
    : contents;
  const formatted = await format(input, { ...options, parser });
  // YAML reflow must preserve scalar values, types, and sequence order, including in frontmatter.
  if (parser === "yaml" && !isDeepStrictEqual(yamlValue(contents, path), yamlValue(formatted, path)))
    throw new Error(`${path}: formatting would change YAML values`);
  if (parser === "json" && !isDeepStrictEqual(jsonValue, JSON.parse(formatted)))
    throw new Error(`${path}: formatting would change JSON values`);
  if (frontmatter) {
    const result = splitFrontmatter(formatted);
    if (!result || !isDeepStrictEqual(yamlValue(frontmatter.yaml, path), yamlValue(result.yaml, path)))
      throw new Error(`${path}: formatting would change frontmatter values`);
  }
  return formatted;
}
