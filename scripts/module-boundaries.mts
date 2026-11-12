import type { Rule } from "eslint";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { projectPaths } from "../app/src/core/projects/project-paths.ts";

const sharedProjectPaths = new Set<string>(Object.values(projectPaths));

export const centralizedProjectPaths: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: { literal: "Use projectPaths for shared Workbench project-file paths." },
  },
  create(context) {
    return {
      Literal(node: Rule.Node) {
        if (node.type === "Literal" && typeof node.value === "string" && sharedProjectPaths.has(node.value))
          context.report({ node, messageId: "literal" });
      },
    };
  },
};

const moduleSources = [
  "ImportDeclaration > Literal.source",
  "ExportNamedDeclaration > Literal.source",
  "ExportAllDeclaration > Literal.source",
  "ImportExpression > Literal.source",
  "TSImportType Literal",
  "CallExpression[callee.name='require'] > Literal.arguments",
].join(", ");

/** Resolve paths without reading files, so static and deferred imports obey the same interface boundary. */
export const interfaceBoundaries: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      forbidden: "{{source}} modules cannot import {{target}} modules; compose interfaces at startup.",
      tooling: "Application modules cannot import repository scripts; share runtime contracts through core.",
    },
  },
  create(context) {
    const filename = resolve(context.cwd, context.filename);
    let root = dirname(filename);
    while (basename(root) !== "src" || basename(dirname(root)) !== "app") {
      const parent = dirname(root);
      if (parent === root) return {};
      root = parent;
    }
    const layer = (file: string) => relative(root, file).split(sep)[0];
    const source = layer(filename);
    if (source !== "core" && source !== "server" && source !== "cli") return {};
    return {
      [moduleSources](node: Rule.Node) {
        if (node.type !== "Literal" || typeof node.value !== "string") return;
        if (!node.value.startsWith(".") && !isAbsolute(node.value)) return;
        const targetFile = resolve(dirname(filename), node.value);
        const target = layer(targetFile);
        if (relative(resolve(root, "../.."), targetFile).split(sep)[0] === "scripts")
          context.report({ node, messageId: "tooling" });
        else if (source !== "cli" && (target === "cli" || (source === "core" && target === "server")))
          context.report({ node, messageId: "forbidden", data: { source, target } });
      },
    };
  },
};
