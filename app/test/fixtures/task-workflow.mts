import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { parseDOM } from "./dom.mjs";
import { webServers } from "./web.mjs";

export function taskWorkflowServers() {
  const servers = webServers();
  return {
    ...servers,
    project() {
      const root = servers.project();
      vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/local-state"));
      mkdirSync(join(root, "workbench/tasks"));
      return root;
    },
  };
}

export function writeWorkflowTask(root: string, number: number, status: string, fields = "") {
  const path = join(root, `workbench/tasks/TSK-${number.toString(36).toUpperCase().padStart(2, "0")}.md`);
  writeFileSync(
    path,
    `---\nstatus: ${status}\n${fields}---\n\n# TSK-${number.toString(36).toUpperCase()}: Work ${String(number)}\n\n## Overview\n\nHuman-readable outcome.\n\n## Details\n\n- [x] Verified.\n`,
  );
  return path;
}

export function workflowForm(html: string, selector: string): { path: string; values: Record<string, string> } {
  const document = parseDOM(html).window.document;
  const selected = document.querySelector<HTMLFormElement>(selector);
  if (!selected) throw new Error(`Missing form: ${selector}`);
  const values = Object.fromEntries(
    [...selected.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [input.name, input.value]),
  );
  return { path: selected.getAttribute("action") ?? "", values };
}
