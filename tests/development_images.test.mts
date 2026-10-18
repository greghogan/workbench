import { promised } from "./fixtures/promised.mjs";
import { required } from "../src/invariants.ts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { developmentImages, runOfflineOperation } from "../src/development-images.ts";
import { inspectOfflineImages } from "../src/offline-profiles.ts";
import { chooseItems, terminalAvailable } from "../src/terminal-choice.ts";
import { runCommand } from "../src/checks.ts";
import { terminal } from "./fixtures/terminal.mjs";

vi.mock("../src/offline-profiles.ts", () => ({
  inspectOfflineImages: vi.fn<typeof import("../src/offline-profiles.ts").inspectOfflineImages>(),
}));
vi.mock("../src/terminal-choice.ts", () => ({
  chooseItems: vi.fn<typeof import("../src/terminal-choice.ts").chooseItems>(),
  terminalAvailable: vi.fn<typeof import("../src/terminal-choice.ts").terminalAvailable>(),
}));
vi.mock("../src/checks.ts", () => ({ runCommand: vi.fn<typeof import("../src/checks.ts").runCommand>() }));

const root = "/fixture";
let rows: Awaited<ReturnType<typeof inspectOfflineImages>>;
let events: (
  | { title: string; names: string[]; selected: string[] | undefined }
  | { operation: string | undefined; name: string | undefined }
)[];
let answers: (string[] | undefined)[];
let columnsDescriptor: PropertyDescriptor | undefined;
const image = (profile: string, local = "not prepared", registry = "missing") => ({
  profile,
  local,
  registry,
  reference: `registry.example/project/${profile}:linux-x64-pinned`,
});
beforeEach(() => {
  columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  vi.stubEnv("CI", undefined);
  vi.stubEnv("GITHUB_ACTIONS", undefined);
  vi.stubEnv("GITLAB_CI", undefined);
  rows = [image("native")];
  events = [];
  answers = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(terminalAvailable).mockReturnValue(true);
  vi.mocked(inspectOfflineImages).mockImplementation((_root, names) =>
    rows
      .filter(
        (row) =>
          !required(names, "Expected fixture value: names").length ||
          required(names, "Expected fixture value: names").includes(row.profile),
      )
      .map((row) => ({ ...row })),
  );
  vi.mocked(chooseItems).mockImplementation((title, items, selected) => {
    return promised(() => {
      events.push({ title, names: items.map((item) => item.name), selected });
      return answers.shift();
    });
  });
  vi.mocked(runCommand).mockImplementation((_root, _label, args) => {
    const [, , , operation, name] = args;
    events.push({ operation, name });
    const row = required(
      rows.find((row) => row.profile === name),
      "Selected image fixture",
    );
    if (operation === "prepare") row.local = "prepared";
    else if (operation === "publish") row.registry = "available";
  });
});
afterEach(() => {
  if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
  else Reflect.deleteProperty(process.stdout, "columns");
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
const interactive = test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch));

test.each(["list", "json", "require", "redirected", "CI", "GITHUB_ACTIONS", "GITLAB_CI"])(
  "%s inspection never prompts or prepares images",
  async (mode) => {
    const options: Record<string, boolean> = {};
    if (["list", "json", "require"].includes(mode)) options[mode] = true;
    else if (mode === "redirected") vi.mocked(terminalAvailable).mockReturnValue(false);
    else vi.stubEnv(mode, "true");
    if (mode === "require") required(rows[0], "Fixture value rows[0]").registry = "available";
    await developmentImages(root, [], options);
    expect(chooseItems).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    if (mode === "json")
      expect(
        JSON.parse(
          String(
            required(
              vi.mocked(console.log).mock.calls[0],
              "Expected fixture value: vi.mocked(console.log).mock.calls[0]",
            )[0],
          ),
        ),
      ).toEqual(rows);
    else
      expect(
        String(
          required(
            vi.mocked(console.log).mock.calls[0],
            "Expected fixture value: vi.mocked(console.log).mock.calls[0]",
          )[0],
        ),
      ).toContain("REGISTRY");
  },
);

test.each(["missing", "unavailable", "not configured", "empty"])(
  "--require rejects %s registry state without offering repairs",
  async (registry) => {
    rows = registry === "empty" ? [] : [image("native", "prepared", registry)];
    await expect(developmentImages(root, [], { require: true })).rejects.toThrow(/Required registry images/);
    expect(chooseItems).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  },
);

interactive(
  "selection prepares only chosen profiles, refreshes state, and separately selects publication",
  async () => {
    rows = [image("native"), image("nix"), image("ready", "prepared"), image("published", "prepared", "available")];
    answers = [["nix"], ["nix", "ready"]];
    await developmentImages(root, [], {});
    expect(events).toEqual([
      { title: "Prepare selected development images", names: ["native", "nix"], selected: ["native", "nix"] },
      { operation: "prepare", name: "nix" },
      { title: "Publish selected development images", names: ["nix", "ready"], selected: ["nix", "ready"] },
      { operation: "publish", name: "nix" },
      { operation: "publish", name: "ready" },
    ]);
    expect(required(rows[0], "Expected fixture value: rows[0]").local).toBe("not prepared");
    expect(rows[1]).toMatchObject({ local: "prepared", registry: "available" });
    expect(vi.mocked(console.log).mock.calls.filter(([text]) => String(text).includes("| PROFILE"))).toHaveLength(3);
  },
);

interactive("declining publication retains a newly prepared local image", async () => {
  answers = [["native"], undefined];
  await developmentImages(root, [], {});
  expect(rows[0]).toMatchObject({ local: "prepared", registry: "missing" });
  expect(runCommand).toHaveBeenCalledTimes(1);
});

interactive("cancelling preparation stops the entire interaction without publication", async () => {
  rows.push(image("ready", "prepared"));
  await developmentImages(root, [], {});
  expect(chooseItems).toHaveBeenCalledTimes(1);
  expect(runCommand).not.toHaveBeenCalled();
});

interactive("selecting no preparations still allows publishing an already prepared profile", async () => {
  rows.push(image("ready", "prepared"));
  answers = [[], ["ready"]];
  await developmentImages(root, [], {});
  expect(events.filter((event) => "operation" in event && event.operation)).toEqual([
    { operation: "publish", name: "ready" },
  ]);
});

interactive.each(["prepare", "publish"])("%s failure stops subsequent actions", async (operation) => {
  if (operation === "publish") required(rows[0], "Fixture value rows[0]").local = "prepared";
  answers = [["native"]];
  vi.mocked(runCommand).mockImplementation(() => {
    throw new Error("fixture failure");
  });
  await expect(developmentImages(root, [], {})).rejects.toThrow("fixture failure");
  expect(chooseItems).toHaveBeenCalledTimes(1);
  expect(required(rows[0], "Fixture value rows[0]").registry).toBe("missing");
});

interactive(
  "selected roots exclude other profiles and images without registries are never offered for publication",
  async () => {
    rows = [image("native", "not prepared", "not configured"), image("nix")];
    answers = [["native"]];
    await developmentImages(root, ["native"], {});
    expect(events.filter((event) => "operation" in event && event.operation)).toEqual([
      { operation: "prepare", name: "native" },
    ]);
    expect(chooseItems).toHaveBeenCalledTimes(1);
  },
);

interactive("already published profiles require no actions and remote images can be prepared locally", async () => {
  rows[0] = image("native", "prepared", "available");
  await developmentImages(root, [], {});
  expect(chooseItems).not.toHaveBeenCalled();
  rows[0].local = "not prepared";
  answers = [["native"]];
  await developmentImages(root, [], {});
  expect(events.filter((event) => "operation" in event && event.operation)).toEqual([
    { operation: "prepare", name: "native" },
  ]);
});

interactive.each(["prepare", "publish"])(
  "changed inputs during %s selection are rejected before execution",
  async (operation) => {
    if (operation === "publish") required(rows[0], "Fixture value rows[0]").local = "prepared";
    vi.mocked(chooseItems).mockImplementation(() => {
      return promised(() => {
        required(rows[0], "Fixture value rows[0]").reference += "-changed";
        return ["native"];
      });
    });
    await expect(developmentImages(root, [], {})).rejects.toThrow("Image inputs changed during selection");
    expect(runCommand).not.toHaveBeenCalled();
  },
);

interactive.each(["not prepared", "prepared"])(
  "concurrently completed actions are skipped after refreshing %s status",
  async (local) => {
    required(rows[0], "Fixture value rows[0]").local = local;
    vi.mocked(chooseItems).mockImplementation(() => {
      return promised(() => {
        required(rows[0], "Fixture value rows[0]").local = "prepared";
        required(rows[0], "Fixture value rows[0]").registry = "available";
        return ["native"];
      });
    });
    await developmentImages(root, [], {});
    expect(runCommand).not.toHaveBeenCalled();
  },
);

interactive("publication is not offered unless refreshed local inspection confirms preparation", async () => {
  answers = [["native"]];
  vi.mocked(runCommand).mockImplementation(() => undefined);
  await developmentImages(root, [], {});
  expect(chooseItems).toHaveBeenCalledTimes(1);
  expect(required(rows[0], "Fixture value rows[0]").registry).toBe("missing");
});

interactive.each(["return", "escape", "interrupt"])(
  "terminal selection prepares first and requires a separate publication choice: %s",
  async (publication) => {
    const actual = await vi.importActual<typeof import("../src/terminal-choice.ts")>("../src/terminal-choice.ts");
    const { input, output } = terminal();
    let text = "",
      ready: (value: unknown) => void;
    output.on("data", (data: Buffer) => {
      text += data.toString("utf8");
    });
    const nextPrompt = () =>
      new Promise((resolve) => {
        ready = resolve;
      });
    vi.mocked(chooseItems).mockImplementation((title, items, selected) => {
      const pending = actual.chooseItems(title, items, selected, input, output);
      ready(title);
      return pending;
    });
    const first = nextPrompt();
    const pending = developmentImages(root, [], {});
    try {
      expect(await first).toBe("Prepare selected development images");
      expect(runCommand).not.toHaveBeenCalled();
      const second = nextPrompt();
      input.emit("keypress", "", { name: "return" });
      expect(await second).toBe("Publish selected development images");
      expect(rows[0]).toMatchObject({ local: "prepared", registry: "missing" });
      input.emit("keypress", "", publication === "interrupt" ? { name: "c", ctrl: true } : { name: publication });
      await pending;
      expect(required(rows[0], "Fixture value rows[0]").registry).toBe(
        publication === "return" ? "available" : "missing",
      );
      expect(text).toContain("Select all");
      expect(text).toContain("Select none");
      expect(input.isRaw).toBe(false);
      expect(input.listenerCount("keypress")).toBe(0);
      expect(text.endsWith("\u001b[?25h")).toBe(true);
    } finally {
      input.emit("end");
      await pending;
      input.destroy();
      output.destroy();
    }
  },
);

test.each([80, 120, undefined])(
  "one table fits width %s and preserves references and diagnostics with their profile",
  async (columns) => {
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
    rows = [image("native", "prepared", "available"), image("guix", "assembled; unverified", "unavailable")];
    required(rows[0], "Expected fixture value: rows[0]").reference += "a".repeat(100);
    required(rows[1], "Expected fixture value: rows[1]").detail = "Registry credentials unavailable";
    required(rows[1], "Expected fixture value: rows[1]").local_issues = ["Missing ownership receipt"];
    await developmentImages(root, [], { list: true });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    const lines = String(
      required(vi.mocked(console.log).mock.calls[0], "Expected fixture value: vi.mocked(console.log).mock.calls[0]")[0],
    ).split("\n");
    expect(lines.every((line: string) => line.length < (columns ?? 80))).toBe(true);
    const content = lines.filter((line: string) => line.startsWith("|")).slice(1);
    const split = content.findIndex(
      (line: string) => required(line.split("|")[1], 'Expected fixture value: line.split("|")[1]').trim() === "guix",
    );
    const details = (section: string[]) =>
      section
        .map((line: string) => required(line.split("|")[4], 'Expected fixture value: line.split("|")[4]').trim())
        .join("")
        .replaceAll(/\s/g, "");
    expect(details(content.slice(0, split))).toBe(required(rows[0], "Expected fixture value: rows[0]").reference);
    expect(details(content.slice(split))).toBe(
      (
        required(rows[1], "Expected fixture value: rows[1]").reference +
        "Registry: Registry credentials unavailable" +
        "Local image inspection: Missing ownership receipt"
      ).replaceAll(/\s/g, ""),
    );
  },
);

test("empty profiles and unsafe diagnostic text are reported without terminal control execution", async () => {
  required(rows[0], "Fixture value rows[0]").detail = "registry\u001b[31m failure";
  required(rows[0], "Fixture value rows[0]").local_issues = ["local\u001b[2J error"];
  await developmentImages(root, [], { list: true });
  const output = String(
    required(vi.mocked(console.log).mock.calls[0], "Expected fixture value: vi.mocked(console.log).mock.calls[0]")[0],
  );
  expect(output).not.toContain("\u001b");
  expect(output).toContain("Registry:");
  expect(output).toContain("Local image inspection:");
  expect(console.error).not.toHaveBeenCalled();
  rows = [];
  await developmentImages(root, [], {});
  expect(chooseItems).not.toHaveBeenCalled();
});

test.each(["build", "pullOnly"])("explicit preparation retains the %s option and controlled runner", (option) => {
  vi.mocked(runCommand).mockImplementation(() => undefined);
  runOfflineOperation(root, "prepare", "native", { [option]: true });
  expect(
    required(vi.mocked(runCommand).mock.calls[0], "Expected fixture value: vi.mocked(runCommand).mock.calls[0]")[2],
  ).toEqual([
    "node",
    "{workbench}/bin/workbench.mjs",
    "offline-exec",
    "prepare",
    "native",
    option === "build" ? "--build" : "--pull-only",
  ]);
  runOfflineOperation(root, "publish", "native", { image: "registry.example/project:exact" });
  expect(
    required(vi.mocked(runCommand).mock.calls[1], "Expected fixture value: vi.mocked(runCommand).mock.calls[1]")[2].at(
      -1,
    ),
  ).toBe("registry.example/project:exact");
});
