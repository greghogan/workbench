import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ownedPath } from "./paths.js";
import { writeAtomic } from "./core.js";
import { ensureLocalIgnore } from "./environments.js";
import { updateUserOption, userConfigValues } from "./user-config.js";
import { skillApplicability, skillCatalog, type Skill } from "./skill-catalog.js";
import { withCacheLockSync } from "./cache-lock.js";
import { prepareSkillIgnores } from "./skill-ignores.js";
import { randomUUID } from "node:crypto";

export interface SkillSelection extends Skill {
  enabled: boolean;
  active: boolean;
  reason: string | undefined;
}
export function selectedSkills(): string[] {
  return userConfigValues()["skills.enabled"] as string[];
}
export function changeSkillSelection(update: (names: string[]) => string[], expected?: string[]): void {
  const canonical = (names: string[]) => JSON.stringify([...new Set(names)].sort());
  updateUserOption("skills.enabled", (current) => {
    const names = (current ?? []) as string[];
    if (expected !== undefined && canonical(names) !== canonical(expected))
      throw new Error("Skill preferences changed while the checklist was open; reopen workbench skills before saving.");
    return [...new Set(update([...names]))].sort();
  });
}
export function inspectSkills(root: string, distribution: string, enabled = selectedSkills()): SkillSelection[] {
  const selected = new Set(enabled);
  const catalog = skillCatalog(distribution);
  const applicability = skillApplicability(root, catalog);
  return catalog.map((skill) => ({
    ...skill,
    enabled: selected.has(skill.name),
    active: selected.has(skill.name) && !applicability.get(skill.name),
    reason: applicability.get(skill.name),
  }));
}
interface State {
  links: Record<string, string>;
}
function stateAt(root: string): State {
  const path = ownedPath(root, "workbench/.skill-links.json");
  if (!existsSync(path)) return { links: {} };
  const state = JSON.parse(readFileSync(path, "utf8")) as Partial<State> | null;
  if (!state?.links || typeof state.links !== "object" || Array.isArray(state.links))
    throw new Error(`${path}: invalid local skill state`);
  for (const [name, source] of Object.entries(state.links))
    if (!/^\.(?:agents|claude)\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || typeof source !== "string")
      throw new Error(`${path}: invalid managed skill link`);
  return { links: state.links };
}
function linkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function skillLinkPath(root: string, name: string): string {
  return join(ownedPath(root, dirname(name)), basename(name));
}
/** Personal discovery links are disposable; shared validation does not require them. */
export function syncSkills(rootInput: string, distributionInput: string): string[] {
  const root = realpathSync(rootInput),
    distribution = realpathSync(distributionInput);
  return withCacheLockSync(ownedPath(root, "workbench/.skill-links.json"), () => synchronizeSkills(root, distribution));
}
function synchronizeSkills(root: string, distribution: string): string[] {
  const skills = inspectSkills(root, distribution);
  const state = stateAt(root);
  for (const skill of skills)
    for (const folder of [".agents/skills", ".claude/skills"]) {
      const name = `${folder}/${skill.name}`;
      if (linkTarget(skillLinkPath(root, name)) === skill.source) state.links[name] = skill.source;
    }
  const desired: Record<string, string> = {};
  for (const skill of skills.filter((entry) => entry.active))
    for (const folder of [".agents/skills", ".claude/skills"]) desired[`${folder}/${skill.name}`] = skill.source;
  const names = [...new Set([...Object.keys(state.links), ...Object.keys(desired)])].sort();
  for (const folder of [".agents", ".agents/skills", ".claude", ".claude/skills"])
    if (
      present(join(root, folder)) &&
      (!lstatSync(join(root, folder)).isDirectory() || lstatSync(join(root, folder)).isSymbolicLink())
    )
      throw new Error(`${folder}: skill discovery directory must be a real directory`);
  for (const [name, target] of Object.entries(desired)) {
    const path = skillLinkPath(root, name),
      actual = linkTarget(path);
    if (present(path) && actual !== state.links[name] && actual !== target)
      throw new Error(`${path}: existing user-owned skill blocks Workbench activation`);
  }
  const changed: string[] = [];
  const publishIgnores = prepareSkillIgnores(root, Object.keys(desired));
  ensureLocalIgnore(root);
  publishIgnores();
  for (const name of names) {
    const path = skillLinkPath(root, name),
      actual = linkTarget(path),
      target = desired[name];
    if (target === actual) continue;
    if (present(path) && actual !== state.links[name]) {
      if (target) throw new Error(`${path}: preserving a changed user-owned skill`);
      continue;
    }
    if (target) {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.pending`;
      let created = false;
      try {
        symlinkSync(relative(dirname(path), target), temporary, "dir");
        created = true;
        // Windows cannot replace a directory symlink with rename. These owned discovery links are reconstructible.
        if (process.platform === "win32" && actual !== undefined) unlinkSync(path);
        renameSync(temporary, path);
      } finally {
        if (created && linkTarget(temporary) === target) unlinkSync(temporary);
      }
    } else if (actual !== undefined) unlinkSync(path);
    changed.push(path);
  }
  writeAtomic(ownedPath(root, "workbench/.skill-links.json"), JSON.stringify({ links: desired }, null, 2) + "\n");
  return changed;
}
