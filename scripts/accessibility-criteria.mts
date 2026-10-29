import type { AxeResults } from "axe-core";

/** Revised Section 508 incorporates WCAG 2.0 A/AA; a passed rule is only partial criterion evidence. */
const wcag20 = [
  "1.1.1",
  "1.2.1",
  "1.2.2",
  "1.2.3",
  "1.2.4",
  "1.2.5",
  "1.3.1",
  "1.3.2",
  "1.3.3",
  "1.4.1",
  "1.4.2",
  "1.4.3",
  "1.4.4",
  "1.4.5",
  "2.1.1",
  "2.1.2",
  "2.2.1",
  "2.2.2",
  "2.3.1",
  "2.4.1",
  "2.4.2",
  "2.4.3",
  "2.4.4",
  "2.4.5",
  "2.4.6",
  "2.4.7",
  "3.1.1",
  "3.1.2",
  "3.2.1",
  "3.2.2",
  "3.2.3",
  "3.2.4",
  "3.3.1",
  "3.3.2",
  "3.3.3",
  "3.3.4",
  "4.1.1",
  "4.1.2",
];
export function criterionEvidence(scans: { state: string; results: AxeResults }[]) {
  return wcag20.map((criterion) => {
    const tag = `wcag${criterion.replaceAll(".", "")}`;
    const evidence = scans.flatMap(({ state, results }) =>
      (["violations", "incomplete", "passes", "inapplicable"] as const).flatMap((outcome) =>
        results[outcome].filter((rule) => rule.tags.includes(tag)).map((rule) => ({ state, rule: rule.id, outcome })),
      ),
    );
    return {
      criterion,
      status: evidence.some((entry) => entry.outcome === "violations")
        ? "failed"
        : evidence.some((entry) => entry.outcome === "passes")
          ? "partial"
          : "not-assessed",
      evidence,
    };
  });
}
