import ts from "typescript";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, isAbsolute, join, posix, relative, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBuiltin } from "node:module";
import { parse } from "smol-toml";
import { distributionPathIncluded } from "../src/distribution-layout.ts";
import { nativeSources, type ToolingArtifact } from "./tooling-artifacts.mts";
import { isRecord } from "./values.mjs";

interface Script {
  path: string;
  contents: string;
}
interface Reference {
  origin: string;
  path: string;
}
interface RuntimeDependencyRequest {
  root: string;
  artifacts: readonly ToolingArtifact[];
  outputs: readonly { path: string; contents: Uint8Array }[];
  scripts: readonly Script[];
  references: readonly Reference[];
}

/** Validate emitted imports and declared runtime assets, rather than banning authoring-time imports. */
export function verifyRuntimeDependencies(request: RuntimeDependencyRequest): void {
  const { root } = request;
  verifyNativeTooling(root);
  const metadata: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("files" in metadata) ||
    !Array.isArray(metadata.files) ||
    !metadata.files.every((path): path is string => typeof path === "string")
  )
    throw new Error("Missing runtime package file declarations");
  const roots = [...metadata.files, "package.json"];
  const packages = new Set(
    ["dependencies", "optionalDependencies", "peerDependencies"].flatMap((group) => {
      const values: unknown = Reflect.get(metadata, group);
      return isRecord(values) ? Object.keys(values) : [];
    }),
  );
  const candidates = new Map(request.outputs.map((output) => [output.path.replaceAll("\\", "/"), output.contents]));
  const included = (path: string) =>
    !isAbsolute(path) &&
    path !== ".." &&
    !path.startsWith("../") &&
    roots.some((base) => path === base || path.startsWith(base + "/")) &&
    distributionPathIncluded(path);
  const existence = new Map<string, boolean>();
  const available = (path: string): boolean => {
    if (candidates.has(path)) return true;
    const previous = existence.get(path);
    if (previous !== undefined) return previous;
    let present: boolean;
    try {
      present = lstatSync(join(root, path)).isFile();
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      present = false;
    }
    existence.set(path, present);
    return present;
  };
  const errors = new Set<string>();
  const check = (origin: string, path: string) => {
    const normalized = posix.normalize(path.replaceAll("\\", "/"));
    if (!included(normalized) || !available(normalized))
      errors.add(`${origin}: runtime dependency is not shipped: ${normalized}`);
  };
  const scripts: Script[] = [];
  for (const artifact of request.artifacts)
    if (artifact.category === "runtime" && artifact.output !== null && included(artifact.output))
      scripts.push({ path: artifact.output, contents: readFileSync(join(root, artifact.output), "utf8") });
  if ("bin" in metadata) {
    const bins: unknown[] =
      typeof metadata.bin === "string"
        ? [metadata.bin]
        : metadata.bin && typeof metadata.bin === "object"
          ? Object.values(metadata.bin)
          : [];
    for (const path of bins)
      if (typeof path === "string") {
        const normalized = posix.normalize(path.replaceAll("\\", "/"));
        check("package.json bin", normalized);
        if (included(normalized) && available(normalized))
          scripts.push({ path: normalized, contents: readFileSync(join(root, normalized), "utf8") });
      }
  }
  scripts.push(...request.scripts);
  for (const output of request.outputs)
    if (/\.[mc]js$/.test(output.path))
      scripts.push({ path: output.path, contents: Buffer.from(output.contents).toString("utf8") });
  const inspected = new Map<string, Set<string>>();
  for (const script of scripts) {
    const versions = inspected.get(script.path) ?? new Set<string>();
    if (versions.has(script.contents)) continue;
    versions.add(script.contents);
    inspected.set(script.path, versions);
    const ast = ts.createSourceFile(script.path, script.contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const reference = (value: ts.Expression | undefined, mode: "module" | "require" | "asset" = "module") => {
      if (!value || !ts.isStringLiteralLike(value)) return;
      if (isAbsolute(value.text) || win32.isAbsolute(value.text) || value.text.startsWith("file:")) {
        errors.add(`${script.path}: runtime dependency uses an absolute path: ${value.text}`);
        return;
      }
      let path: string;
      if (mode === "asset") {
        const url = new URL(value.text, pathToFileURL(join(root, script.path)));
        if (url.protocol !== "file:") return;
        path = relative(root, fileURLToPath(url)).replaceAll("\\", "/");
      } else {
        if (!value.text.startsWith(".")) {
          const name = value.text
            .split("/")
            .slice(0, value.text.startsWith("@") ? 2 : 1)
            .join("/");
          if (!isBuiltin(value.text) && !packages.has(name))
            errors.add(`${script.path}: runtime package is not declared: ${value.text}`);
          return;
        }
        path = posix.normalize(posix.join(posix.dirname(script.path), value.text));
      }
      if (mode !== "asset" && /\.(?:[mc]?ts|tsx)$/.test(path))
        errors.add(`${script.path}: runtime imports require generated JavaScript: ${path}`);
      const paths =
        mode === "require" && !extname(path)
          ? [path, path + ".js", path + ".json", path + ".node", path + "/index.js", path + "/index.json"]
          : [path];
      const resolved = paths.find((candidate) => included(candidate) && available(candidate));
      check(script.path, resolved ?? path);
      if (resolved && /\.(?:[mc]?js)$/.test(resolved))
        scripts.push({
          path: resolved,
          contents: candidates.has(resolved)
            ? Buffer.from(candidates.get(resolved) ?? []).toString("utf8")
            : readFileSync(join(root, resolved), "utf8"),
        });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) reference(node.moduleSpecifier);
      else if (ts.isExportDeclaration(node)) reference(node.moduleSpecifier);
      else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) reference(node.arguments[0]);
        else if (ts.isIdentifier(node.expression) && node.expression.text === "require")
          reference(node.arguments[0], "require");
        else if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "require" &&
          node.expression.name.text === "resolve"
        )
          reference(node.arguments[0], "require");
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") {
        const base = node.arguments?.[1],
          value = node.arguments?.[0];
        if (
          base &&
          ts.isPropertyAccessExpression(base) &&
          base.name.text === "url" &&
          ts.isMetaProperty(base.expression) &&
          value &&
          ts.isStringLiteralLike(value) &&
          extname(value.text)
        )
          reference(value, "asset");
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  for (const reference of request.references) check(reference.origin, reference.path);
  const templates = (value: unknown, origin: string): void => {
    if (typeof value === "string" && value.startsWith("{workbench}/") && !value.slice(12).includes("{"))
      check(origin, value.slice(12));
    else if (Array.isArray(value)) for (const item of value) templates(item, origin);
    else if (value && typeof value === "object") for (const item of Object.values(value)) templates(item, origin);
  };
  const visitTemplates = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visitTemplates(path);
      else if (entry.isFile() && path.endsWith(".toml"))
        templates(parse(readFileSync(path, "utf8")), relative(root, path));
    }
  };
  visitTemplates(join(root, "languages"));
  if (errors.size) throw new Error(`Runtime payload has missing dependencies:\n${[...errors].sort().join("\n")}`);
}

/** Check source-run entry points without following their already-compiled runtime imports. */
export function verifyNativeTooling(root: string): void {
  const files = [...nativeSources].map((path) => join(root, path)).filter(existsSync);
  if (!files.length) return;
  const program = ts.createProgram(files, {
    noEmit: true,
    noResolve: true,
    noLib: true,
    types: [],
    erasableSyntaxOnly: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const failures = program
    .getSemanticDiagnostics()
    .filter((diagnostic) => diagnostic.code === 1294 || diagnostic.code === 1295);
  if (failures.length)
    throw new Error(
      failures
        .map(
          (diagnostic) =>
            `${diagnostic.file?.fileName ?? root}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
        )
        .join("\n"),
    );
}
