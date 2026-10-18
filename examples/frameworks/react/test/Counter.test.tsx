import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Counter } from "../src/Counter.js";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.resetModules();
});

test("counter supports increasing, decreasing through zero, and resetting", async () => {
  const user = userEvent.setup();
  render(<Counter />);
  const count = screen.getByRole("status", { name: "Count" });
  expect(count.textContent).toBe("0");
  await user.click(screen.getByRole("button", { name: "Increase" }));
  expect(count.textContent).toBe("1");
  await user.click(screen.getByRole("button", { name: "Decrease" }));
  await user.click(screen.getByRole("button", { name: "Decrease" }));
  expect(count.textContent).toBe("-1");
  await user.click(screen.getByRole("button", { name: "Reset" }));
  expect(count.textContent).toBe("0");
});

test("application entry mounts into the page", async () => {
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  let application!: typeof import("../src/main.js");
  await act(async () => {
    application = await import("../src/main.js");
  });
  expect(screen.getByRole("heading", { name: "React counter" })).toBeTruthy();
  act(() => {
    application.root.unmount();
  });
});

test("application entry diagnoses a missing container", async () => {
  await expect(import("../src/main.js")).rejects.toThrow("Missing #root application container");
});
