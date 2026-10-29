import { join } from "node:path";
export type Kind = "ADR" | "TSK" | "EXP" | "ENV" | "CIT" | "REL";
export interface RecordFile {
  number: string;
  path: string;
}
const kindDetails: Record<Kind, { directory: string; map: string; extension: string; title: string }> = {
  ADR: { directory: "decisions", map: "decision-map.md", extension: "md", title: "Decision" },
  TSK: { directory: "tasks", map: "task-map.md", extension: "md", title: "Task" },
  EXP: { directory: "experiments", map: "experiment-map.md", extension: "md", title: "Experiment" },
  ENV: { directory: "environments", map: "environment-map.md", extension: "md", title: "Environment" },
  CIT: { directory: "citations", map: "citation-map.md", extension: "json", title: "Citation" },
  REL: { directory: "releases", map: "release-map.md", extension: "yaml", title: "Release" },
};
export const kinds = Object.keys(kindDetails) as Kind[];
export function detail(kind: Kind) {
  return kindDetails[kind];
}

export function normalizedNumber(value: string): string {
  const digits = value.replaceAll("_", "").toUpperCase();
  if (!/^[0-9A-Z]+$/.test(digits)) throw new Error(`invalid base-36 number: ${value}`);
  return digits.replace(/^0+(?=.)/, "");
}

export function nextNumber(value: string): string {
  const digits = value.split("");
  for (let index = digits.length - 1; index >= 0; index--) {
    const digit = digits[index];
    if (!digit) continue;
    if (digit === "Z") {
      digits[index] = "0";
      continue;
    }
    if (digit === "9") digits[index] = "A";
    else digits[index] = String.fromCharCode(digit.charCodeAt(0) + 1);
    return digits.join("");
  }
  return `1${digits.join("")}`;
}

export function relativeRecordPath(kind: Kind, number: string): string {
  const normalized = normalizedNumber(number);
  const padded = normalized.length % 2 ? `0${normalized}` : normalized;
  const pairs = padded.match(/.{2}/g) ?? [];
  return join(detail(kind).directory, ...pairs.slice(0, -1), `${kind}-${padded}.${detail(kind).extension}`);
}
