import { pomDocument as document, pomChild as child, pomXml as xml, type PomElement } from "./maven-pom.js";

interface MavenBootstrap {
  text: string;
  namespaces: Readonly<Record<string, string>>;
}
function resolverPlugins(root: PomElement): PomElement[] {
  const build = child(root, "build"),
    plugins = build && child(build, "plugins");
  return (
    plugins?.children.filter(
      (node) =>
        node.name === "plugin" &&
        (child(node, "groupId")?.text.trim() ?? "org.apache.maven.plugins") === "org.apache.maven.plugins" &&
        child(node, "artifactId")?.text.trim() === "maven-dependency-plugin",
    ) ?? []
  );
}

/** The consuming root owns the resolver bootstrap graph for every staged source module. */
export function mavenBootstrapPlugin(pom: Buffer, resolver: string): MavenBootstrap {
  const text = pom.toString("utf8"),
    root = document(text),
    plugins = resolverPlugins(root),
    version = resolver.split(":")[2];
  if (!version || plugins.length > 1) throw new Error("Maven acquisition requires one pinned resolver declaration");
  const plugin = plugins[0];
  if (!plugin)
    return {
      text: `<plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-dependency-plugin</artifactId><version>${xml(version)}</version></plugin>`,
      namespaces: {},
    };
  if (child(plugin, "version")?.text.trim() !== version)
    throw new Error("The Maven resolver plugin version must match .mvn/acquisition.json");
  for (const dependency of child(plugin, "dependencies")?.children ?? []) {
    const selected = child(dependency, "version")?.text.trim() ?? "";
    if (
      dependency.name === "dependency" &&
      (!/^[A-Za-z0-9_+.-]+$/.test(selected) ||
        ["LATEST", "RELEASE"].includes(selected) ||
        selected.endsWith("-SNAPSHOT"))
    )
      throw new Error("Maven resolver dependency overrides require literal pinned versions");
  }
  if (plugin.declared.size)
    throw new Error("Declare Maven resolver namespaces on the project element, not the plugin element");
  return { text: text.slice(plugin.start, plugin.end), namespaces: plugin.namespaces };
}

/** Add or replace only the resolver declaration in a disposable metadata POM. */
export function mavenBootstrapPom(pom: Buffer, bootstrap: MavenBootstrap): Buffer {
  const text = pom.toString("utf8"),
    root = document(text),
    existing = resolverPlugins(root);
  const plugin = bootstrap.text;
  let declarations = "";
  for (const [prefix, uri] of Object.entries(bootstrap.namespaces)) {
    const current = root.namespaces[prefix];
    if (current !== undefined && current !== uri)
      throw new Error(`Conflicting Maven resolver namespace: ${prefix || "default"}`);
    if (current === undefined) declarations += ` xmlns${prefix ? ":" + prefix : ""}="${xml(uri)}"`;
  }
  // Maven permits namespace declarations on the project element, not on build/plugins/plugin.
  const output = (value: string): Buffer => {
    const at = root.openEnd - (root.selfClosing ? 2 : 1);
    return Buffer.from(value.slice(0, at) + declarations + value.slice(at));
  };
  if (existing.length > 1) throw new Error("Duplicate Maven resolver plugin declarations");
  const selected = existing[0];
  if (selected) return output(text.slice(0, selected.start) + plugin + text.slice(selected.end));
  const build = child(root, "build"),
    plugins = build && child(build, "plugins"),
    target = plugins ?? build ?? root;
  const contents = plugins ? plugin : `<plugins>${plugin}</plugins>`;
  const inserted = build ? contents : `<build>${contents}</build>`;
  if (target.selfClosing) {
    const opening = text.slice(target.start, target.openEnd).replace(/\/>$/u, ">");
    const qualified = /^<([^\s/>]+)/u.exec(opening)?.[1];
    if (!qualified) throw new Error("Invalid Maven metadata element");
    return output(text.slice(0, target.start) + opening + inserted + `</${qualified}>` + text.slice(target.end));
  }
  return output(text.slice(0, target.closeStart) + inserted + text.slice(target.closeStart));
}
