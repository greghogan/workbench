import { projectPaths } from "../core/projects/project-paths.js";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { registerConsumingProject, registrationRoot } from "../core/projects/project-registration.js";
import {
  Registration,
  canonicalProject,
  declineProject,
  projectRegistration,
} from "../core/projects/project-registry.js";
export const registrationInstruction = (root: string): string =>
  `Project is not registered. To register:\n  workbench project add ${JSON.stringify(root)}`;
export async function requireProjectRegistration(root: string): Promise<void> {
  root = registrationRoot(root);
  if (!existsSync(join(root, projectPaths.projects))) return;
  await approveProjectRegistration(root);
}
/** Ask before acquiring or executing a checkout-selected executable revision. */
export async function approveProjectRegistration(directory: string): Promise<void> {
  const root = canonicalProject(directory),
    state = projectRegistration(root);
  if (state === Registration.Registered) return;
  const instruction = registrationInstruction(root);
  if (state === Registration.Declined || !process.stdin.isTTY || !process.stderr.isTTY) throw new Error(instruction);
  const input = createInterface({ input: process.stdin, output: process.stderr });
  let answer: string;
  try {
    answer = await input.question(`Register Workbench project ${JSON.stringify(root)} and continue? [y/N] `);
  } finally {
    input.close();
  }
  if (!/^y(?:es)?$/i.test(answer.trim())) {
    declineProject(root, basename(root));
    throw new Error(instruction);
  }
  await registerConsumingProject(root);
}
