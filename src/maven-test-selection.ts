import { pomChild, pomContents, pomDocument, pomXml, type PomElement } from "./maven-pom.js";

/** Select tests only in the invocation's target module; upstream modules still compile their test sources. */
export function mavenTestSelectionPom(pom: Buffer, selection: string | undefined): Buffer {
  const text = pom.toString("utf8"),
    model = pomDocument(text);
  const plugins: PomElement[] = [];
  const visit = (node: PomElement) => {
    if (
      node.name === "plugin" &&
      pomChild(node, "artifactId")?.text.trim() === "maven-surefire-plugin" &&
      [undefined, "org.apache.maven.plugins"].includes(pomChild(node, "groupId")?.text.trim())
    )
      plugins.push(node);
    if (node.name !== "configuration") for (const child of node.children) visit(child);
  };
  visit(model);
  if (!plugins.length) throw new Error("Focused Java tests require a declared Maven Surefire plugin in every module");
  const changes: { start: number; end: number; text: string }[] = [];
  for (const plugin of plugins) {
    const executions = pomChild(plugin, "executions");
    for (const target of [plugin, ...(executions?.children.filter((node) => node.name === "execution") ?? [])]) {
      const configuration = pomChild(target, "configuration"),
        prefix = target.qualifiedName.replace(/[^:]+$/u, "");
      const values = {
        skipTests: selection === undefined ? "true" : "false",
        ...(selection === undefined
          ? {}
          : {
              skip: "false",
              testFailureIgnore: "false",
              test: selection,
              failIfNoTests: "true",
              failIfNoSpecifiedTests: "true",
            }),
      };
      let content =
        configuration && !configuration.selfClosing ? text.slice(configuration.openEnd, configuration.closeStart) : "";
      const edits: { start: number; end: number; text: string }[] = [];
      let additional = "";
      for (const [name, value] of Object.entries(values)) {
        const current = configuration && pomChild(configuration, name),
          rendered = `<${prefix}${name}>${pomXml(value)}</${prefix}${name}>`;
        if (current)
          edits.push({
            start: current.start - configuration.openEnd,
            end: current.end - configuration.openEnd,
            text: rendered,
          });
        else additional += rendered;
      }
      for (const edit of edits.sort((left, right) => right.start - left.start))
        content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
      content += additional;
      if (configuration)
        changes.push({
          start: configuration.start,
          end: configuration.end,
          text: pomContents(text, configuration, content),
        });
      else
        changes.push({
          start: target.closeStart,
          end: target.closeStart,
          text: `<${prefix}configuration>${content}</${prefix}configuration>`,
        });
    }
  }
  let result = text;
  for (const change of changes.sort((left, right) => right.start - left.start))
    result = result.slice(0, change.start) + change.text + result.slice(change.end);
  return Buffer.from(result);
}
