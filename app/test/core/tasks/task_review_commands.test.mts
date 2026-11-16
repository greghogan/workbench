import { expect, test, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { webServers } from "../../fixtures/web.mjs";
import { distribution } from "../../fixtures/adoption.mjs";
import { registerTaskCommands } from "../../../src/cli/tasks.ts";
import { formatDocument } from "../../../src/core/records/formatting.ts";
import { planIdentity } from "../../../src/core/tasks/planning/plan-model.ts";
import { readPlan } from "../../../src/core/tasks/planning/planning-store.ts";
import { savePlanDraft } from "../../../src/core/tasks/planning/planning-operations.ts";
import { readTaskGraph } from "../../../src/core/tasks/task-model.ts";

const prompt = vi.hoisted(() => ({ question: vi.fn<() => Promise<string>>() }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question: prompt.question, close: () => undefined }),
}));
vi.mock("../../../src/cli/terminal/terminal-choice.ts", async (original) => ({
  ...(await original<typeof import("../../../src/cli/terminal/terminal-choice.ts")>()),
  terminalAvailable: () => true,
}));
const servers = webServers();

test.each([false, true])(
  "CLI shows the formatted plan before asking for approval and retains that approved version (saved=%s)",
  async (saved) => {
    const root = servers.project();
    vi.stubEnv("WORKBENCH_STATE_HOME", join(root, ".git/local-state"));
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    const config = join(root, "workbench/config.toml");
    writeFileSync(config, readFileSync(config, "utf8") + "\n[review]\ntask_approvals=true\n");
    const contents =
      "---\nstatus: Planned\n---\n\n# " +
      (saved ? "Service plan" : "TSK-0: Service plan") +
      "\n\n" +
      "Preserve existing user work while installing and restarting the service. ".repeat(10).trim() +
      "\n";
    const path = join(root, "workbench/tasks/TSK-00.md"),
      identity = planIdentity("demo", "service");
    if (saved) savePlanDraft(root, identity, contents);
    else {
      mkdirSync(join(root, "workbench/tasks"));
      writeFileSync(path, contents);
    }
    const original = saved ? readPlan(root, identity).contents : contents,
      expected = saved ? readPlan(root, identity).digest : readTaskGraph(root).require("demo:TSK-0").digest,
      formatted = await formatDocument(original, "plan.md", 120),
      messages: string[] = [];
    const output = vi.spyOn(console, "log").mockImplementation((message: unknown) => {
      messages.push(String(message));
    });
    prompt.question.mockImplementationOnce(() => {
      expect(messages[0]).toBe(formatted);
      expect(saved ? readPlan(root, identity).contents : readFileSync(path, "utf8")).toBe(formatted);
      expect(
        saved ? readPlan(root, identity).approval : readTaskGraph(root).require("demo:TSK-0").approval,
      ).toBeUndefined();
      return Promise.resolve("yes");
    });
    try {
      const command = new Command().exitOverride();
      registerTaskCommands(command, root);
      await command.parseAsync(
        saved
          ? ["task", "plan", "approve", "service", "--expected", expected]
          : ["task", "approve", "TSK-0", "--expected", expected],
        { from: "user" },
      );
    } finally {
      output.mockRestore();
    }
    expect(prompt.question).toHaveBeenCalled();
    const approved = saved ? readPlan(root, identity) : readTaskGraph(root).require("demo:TSK-0");
    expect(approved.approval?.current).toBe(true);
    expect(approved.approval?.contents).toBe(formatted.replace("status: Planned", "status: Approved"));
  },
);
