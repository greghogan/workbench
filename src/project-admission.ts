import { projectName } from "./project-hierarchy.js";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { readProjects } from "./project-configuration.js";
import {
  Registration,
  canonicalProject,
  projectRegistration,
  registerProject,
  declineProject,
} from "./project-registry.js";
export const registrationInstruction = (root: string): string =>
  `Project is not registered. To register:\n  workbench project add ${JSON.stringify(root)}`;
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
  const project = readProjects(root)[0];
  const name = project ? projectName(project) : basename(root);
  registerProject(root, name);
}
