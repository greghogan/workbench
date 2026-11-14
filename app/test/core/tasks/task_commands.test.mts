import { git } from "../../fixtures/adoption.mjs";
import { Command } from "commander";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { webFixture } from "../../fixtures/web.mjs";
import { registerTaskCommands } from "../../../src/cli/tasks.ts";
import { approvePlanDraft } from "../../../src/core/tasks/planning/planning-operations.ts";
import { readPlan } from "../../../src/core/tasks/planning/planning-store.ts";
import { planIdentity } from "../../../src/core/tasks/planning/plan-model.ts";

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
  expect(initial.ready).toEqual(["demo:TSK-0", "demo:TSK-1"]);
  expect(initial.entries.map((entry) => entry.reference)).toEqual(initial.ready);
  await command("queue", "move", "TSK-1", "--before", "TSK-0");
  const reordered = JSON.parse(await command("queue", "--ready", "--json")) as { ready: string[] };
  expect(reordered.ready).toEqual(["demo:TSK-1", "demo:TSK-0"]);
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

test("named-plan CLI edits and grouped checkpoints preserve source history and require an inspected draft version", async () => {
  const file = join(root, "plan-input.md"),
    source = git(root, "rev-parse", "HEAD");
  writeFileSync(file, "---\nstatus: Planned\n---\n\n# Service installation\n\nInstall for the current user.\n");
  await command("task", "plan", "configure", "--branch", "future");
  const original = JSON.parse(await command("task", "plan", "create", "service", "--file", file, "--json")) as {
    reference: string;
    digest: string;
  };
  expect(original.reference).toBe("demo:plan/service");
  writeFileSync(file, "An incomplete local draft");
  const changed = JSON.parse(
    await command("task", "plan", "save", "service", "--file", file, "--expected", original.digest, "--json"),
  ) as { digest: string; problem: string };
  expect(changed.problem).toMatch(/frontmatter/);
  await expect(command("task", "plan", "checkpoint")).rejects.toThrow(/frontmatter/);
  await expect(
    command("task", "plan", "save", "service", "--file", file, "--expected", original.digest),
  ).rejects.toThrow(/changed/);
  writeFileSync(file, "---\nstatus: Planned\n---\n\n# Service installation\n\nInstall for all users.\n");
  await command("task", "plan", "save", "service", "--file", file, "--expected", changed.digest);
  await command("task", "plan", "checkpoint", "service");
  expect(git(root, "rev-list", "--count", "future")).toBe("1");
  expect(git(root, "rev-parse", "HEAD")).toBe(source);
  expect(git(root, "ls-tree", "-r", "--name-only", "future")).toContain("plans/demo/service/plan.md");
  expect(await command("task", "plan", "show", "service")).toContain("Install for all users.");
  expect(await command("task", "plan", "--json")).toContain("demo:plan/service");
});

test("CLI supporting-file edits and rename use inspected versions and preserve queued order", async () => {
  const input = join(root, "plan-input.md"),
    asset = join(root, "requirements.txt");
  writeFileSync(input, "---\nstatus: Planned\n---\n\n# Future service\n");
  writeFileSync(asset, "Service requirements.\n");
  const created = JSON.parse(await command("task", "plan", "create", "service", "--file", input, "--json")) as {
    digest: string;
  };
  const attached = JSON.parse(
    await command("task", "plan", "attach", "service", asset, "--expected", created.digest, "--json"),
  ) as { digest: string; files: string[] };
  expect(attached.files).toEqual(["files/requirements.txt"]);
  const exported = join(root, "exported-requirements.txt");
  await command("task", "plan", "show", "service", "--file", "requirements.txt", "--output", exported);
  expect(readFileSync(exported)).toEqual(readFileSync(asset));
  await expect(
    command("task", "plan", "show", "service", "--file", "requirements.txt", "--output", exported),
  ).rejects.toThrow(/exist/i);
  expect(await command("task", "plan", "show", "service", "--file", "requirements.txt", "--json")).toContain(
    '"encoding":"base64"',
  );
  await expect(command("queue", "add", "plan/service")).rejects.toThrow(/approve/);
  const identity = planIdentity("demo", "service"),
    approved = approvePlanDraft(root, identity, readPlan(root, identity).digest, true);
  const renamed = JSON.parse(
    await command("task", "plan", "rename", "service", "background", "--expected", approved.digest, "--json"),
  ) as { digest: string };
  expect(await command("queue", "--json")).toContain("demo:plan/background");
  expect(
    await command("task", "plan", "detach", "background", "requirements.txt", "--expected", renamed.digest, "--json"),
  ).toContain('"files": []');
  await expect(command("task", "plan", "show", "service")).rejects.toThrow(/not found/);
});
