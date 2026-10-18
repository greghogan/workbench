import { type Command } from "commander";
import { distributionRoot } from "./core.js";
import { hasCollectionProject } from "./collections.js";
import { changeSkillSelection, inspectSkills, selectedSkills, syncSkills } from "./skills.js";
import { chooseItems, terminalAvailable } from "./terminal-choice.js";
import { terminalTable } from "./terminal-table.js";

function save(root: string, update: (names: string[]) => string[], expected?: string[]): void {
  changeSkillSelection(update, expected);
  if (hasCollectionProject(root)) {
    try {
      for (const path of syncSkills(root, distributionRoot(root))) console.log(`Updated ${path}.`);
    } catch (cause) {
      throw new Error(
        `Skill preferences were saved, but project links were not refreshed. Run workbench sync. ${String(cause)}`,
        { cause },
      );
    }
  }
}
export function registerSkillCommands(program: Command, root: string): void {
  const command = program
    .command("skills")
    .description("Select personal skills and inspect project applicability")
    .option("--json", "Inspect skills without changing preferences")
    .action(async (options: { json?: boolean }) => {
      const before = selectedSkills();
      const skills = inspectSkills(root, distributionRoot(root), before);
      if (options.json) {
        console.log(JSON.stringify(skills, null, 2));
        return;
      }
      if (!terminalAvailable()) {
        console.log(
          terminalTable(
            ["SELECTED", "SKILL", "PROJECT STATUS"],
            skills.map((skill) => [
              skill.enabled ? "[x]" : "[ ]",
              skill.name,
              skill.reason ?? (skill.enabled ? "active" : "disabled"),
            ]),
          ),
        );
        return;
      }
      const selected = await chooseItems("Select skills", skills, before);
      if (selected !== undefined) save(root, () => selected, before);
    });
  for (const operation of ["enable", "disable"] as const)
    command
      .command(operation)
      .description(`${operation === "enable" ? "Enable" : "Disable"} an individual skill for this user`)
      .argument("<name>")
      .action((name: string) => {
        const skills = inspectSkills(root, distributionRoot(root));
        save(root, (before) => {
          if (!skills.some((skill) => skill.name === name) && !(operation === "disable" && before.includes(name)))
            throw new Error(`unknown skill: ${name}`);
          return operation === "enable" ? [...before, name] : before.filter((entry) => entry !== name);
        });
        console.log(`${operation === "enable" ? "Enabled" : "Disabled"} ${name}; project applicability still applies.`);
      });
}
