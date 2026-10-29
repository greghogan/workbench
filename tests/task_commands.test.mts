import { Command } from "commander";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { webFixture } from "./fixtures/web.mjs";
import { registerTaskCommands } from "../src/cli/tasks.ts";

let root: string;
beforeEach(() => {
  root = webFixture();
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/local-state"));
  mkdirSync(join(root, "workbench/tasks"));
  for (const number of [0, 1])
    writeFileSync(
      join(root, `workbench/tasks/TSK-0${String(number)}.md`),
      `---\nstatus: Planned\n---\n\n# TSK-${String(number)}: Task ${String(number)}\n\n## Overview\n\nDeliver useful behavior.\n`,
    );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
async function command(...args: string[]): Promise<string> {
  const messages: string[] = [];
  const capture = vi.spyOn(console, "log").mockImplementation((message: unknown) => messages.push(String(message)));
  try {
    const cli = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
    registerTaskCommands(cli, root);
    await cli.parseAsync(args, { from: "user" });
    return messages.join("\n");
  } finally {
    capture.mockRestore();
  }
}

test("CLI separates shared human decisions from local progress and reports every ready task in queue order", async () => {
  await command("task", "approve", "TSK-0");
  await command("task", "approve", "TSK-1");
  const record = readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8");
  await command("queue", "add", "TSK-1", "TSK-0");
  const initial = JSON.parse(await command("queue", "--ready", "--json")) as {
    ready: string[];
    entries: { reference: string }[];
  };
  expect(initial.ready).toEqual(["demo:TSK-1", "demo:TSK-0"]);
  expect(initial.entries.map((entry) => entry.reference)).toEqual(initial.ready);
  await command("queue", "move", "TSK-0", "--before", "TSK-1");
  expect(await command("queue")).toContain("Ready");
  await command("queue", "start", "TSK-0");
  await command("queue", "implemented", "TSK-0", "--evidence", "Integration tests passed.");
  expect(readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8")).toBe(record);
  await command("task", "accept", "TSK-0");
  expect(await command("task", "--status", "Accepted", "--json")).toContain('"status": "Accepted"');
  await expect(command("q")).rejects.toThrow();
  await expect(command("queue", "next")).rejects.toThrow();
});

test("CLI scope selection resolves short task IDs and retains hierarchy in structured listings", async () => {
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="demo"\npath="."\n[[project]]\nid="api"\npath="services/api"\n',
  );
  mkdirSync(join(root, "services/api/workbench/tasks"), { recursive: true });
  writeFileSync(
    join(root, "services/api/workbench/tasks/TSK-00.md"),
    "---\nstatus: Planned\n---\n\n# TSK-0: Service plan\n",
  );
  await command("task", "--project", "api", "approve", "TSK-0");
  const shown = JSON.parse(await command("task", "--project", "api", "show", "TSK-0", "--json")) as {
    reference: string;
    status: string;
  };
  expect(shown).toMatchObject({ reference: "api:TSK-0", status: "Approved" });
  expect(readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8")).toContain("status: Planned");
  await command("queue", "--project", "api", "add", "TSK-0");
  expect(await command("queue", "--json")).toContain("api:TSK-0");
  await expect(command("task", "--project", "demo", "show", "api:TSK-0")).rejects.toThrow(/conflicts/);
  vi.spyOn(process, "cwd").mockReturnValue(join(root, "services/api"));
  expect(await command("task", "show", "TSK-0", "--json")).toContain("api:TSK-0");
  await expect(command("task", "--project", "missing")).rejects.toThrow(/unknown project/);
  writeFileSync(
    join(root, "workbench/tasks/TSK-01.md"),
    "---\nstatus: Planned\nparent: demo:TSK-0\n---\n\n# TSK-1: Child\n",
  );
  const listed = JSON.parse(await command("task", "--json")) as { reference: string; title: string; depth: number }[];
  expect(listed.find((task) => task.reference === "demo:TSK-1")).toMatchObject({ title: "Child", depth: 1 });
});
