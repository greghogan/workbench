import type { JSX } from "preact";
import { projectPath } from "./project-paths.js";
import { withView } from "./locations.js";
import { DifferenceLayout } from "./navigation-state.js";

export function linkButton(label: string, href: string, secondary = false): JSX.Element {
  return (
    <a class={"button" + (secondary ? " secondary" : "")} href={projectPath(href)}>
      {label}
    </a>
  );
}

export function tabs(choices: { label: string; href: string; current: boolean }[], label: string): JSX.Element {
  return (
    <nav class="tabs" aria-label={label}>
      {choices.map((choice) => (
        <a key={choice.href} href={projectPath(choice.href)} aria-current={choice.current ? "page" : undefined}>
          {choice.label}
        </a>
      ))}
    </nav>
  );
}

export function diffLayout(base: string, split: boolean): JSX.Element {
  return (
    <div class="diff-layout">
      {tabs(
        [
          { label: "Unified", href: withView(base, { layout: DifferenceLayout.Inline }), current: !split },
          { label: "Side-by-side", href: withView(base, { layout: DifferenceLayout.Split }), current: split },
        ],
        "Difference layout",
      )}
    </div>
  );
}
