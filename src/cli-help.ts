import { Help, type Command } from "commander";

type Groups = readonly (readonly [string, readonly string[]])[];

// Keep discovery order independent of where commands are registered.
const layouts: Readonly<Record<string, Groups>> = {
  "": [
    ["Workspace:", ["setup", "project", "collection", "language"]],
    ["Records and context:", ["record", "citation", "sync", "feedback"]],
    ["Development:", ["development", "shell", "tools", "paths", "release"]],
    [
      "Checks and review:",
      ["check", "pre-commit", "pre-push", "ci", "format", "validate", "review", "docs", "secrets", "advisories"],
    ],
    ["Workbench settings:", ["config", "skills", "cache", "update", "install", "completion"]],
    ["Help:", ["help"]],
  ],
  collection: [
    ["Project collections:", ["install", "changes", "compare", "update", "fetch", "stage"]],
    ["Local guidance:", ["context", "local", "compatibility"]],
    ["Collection authoring:", ["inspect", "export", "check-export"]],
  ],
  "collection local": [["Commands:", ["review", "approve", "remove", "retain", "sync"]]],
  "collection compatibility": [["Commands:", ["check", "acknowledge"]]],
  language: [["Commands:", ["init", "roots"]]],
  citation: [["Commands:", ["add", "fetch", "import"]]],
  feedback: [["Commands:", ["add", "show", "resolve"]]],
  development: [["Commands:", ["use", "images", "prepare", "verify", "publish"]]],
  tools: [["Commands:", ["profiles", "install"]]],
  release: [["Commands:", ["profiles", "prepare"]]],
  check: [["Commands:", ["matrix"]]],
  config: [["Commands:", ["get", "set", "unset"]]],
  skills: [["Commands:", ["enable", "disable"]]],
  cache: [["Commands:", ["prune"]]],
};

export function configureCommandHelp(
  program: Command,
  filter: (parent: Command, commands: Command[]) => Command[],
): void {
  function visit(parent: Command, path: string): void {
    const groups = layouts[path] ?? [];
    const names = groups.flatMap(([, commands]) => commands);
    const ranks = new Map(names.map((name, index) => [name, index]));
    parent.configureHelp({
      visibleCommands(command) {
        return filter(command, new Help().visibleCommands(command)).sort(
          (a, b) => (ranks.get(a.name()) ?? names.length) - (ranks.get(b.name()) ?? names.length),
        );
      },
      // Commander otherwise orders headings by registration, even when visible commands are ordered.
      groupItems(_unsorted, visible, getGroup) {
        return new Help().groupItems(visible, visible, getGroup);
      },
    });
    for (const [heading, commands] of groups)
      for (const child of parent.commands) if (commands.includes(child.name())) child.helpGroup(heading);
    for (const child of parent.commands) visit(child, path ? `${path} ${child.name()}` : child.name());
  }
  visit(program, "");
}
