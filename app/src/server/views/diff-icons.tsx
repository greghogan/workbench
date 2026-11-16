import type { JSX } from "preact";

export function diffIcon(kind: "up" | "down" | "chevron" | "files" | "folder" | "file"): JSX.Element {
  const paths = {
    up: "M3 10l5-5 5 5M8 5v9M3 2h10",
    down: "M3 6l5 5 5-5M8 2v9M3 14h10",
    chevron: "m6 3 5 5-5 5",
    files: "M2 2h12v12H2zM6 2v12M3 5h1M3 8h1M3 11h1",
    folder: "M1.5 4h5l1.5 2h6.5v7h-13zM1.5 4V2.5h5L8 4h6.5v2",
    file: "M3 1.5h6l4 4v9H3zM9 1.5v4h4",
  };
  return (
    <svg
      class={`diff-icon diff-icon-${kind}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[kind]} />
    </svg>
  );
}
