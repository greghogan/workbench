import type { MetadataByKind } from "../../src/record-document.ts";
const task: MetadataByKind["TSK"] = { status: "Approved" };
const decision: MetadataByKind["ADR"] = { summary: "Decided outcome" };
// @ts-expect-error A task must use a declared task status.
const invalidTask: MetadataByKind["TSK"] = { status: "Unknown" };
// @ts-expect-error Experiment fields cannot appear on decisions.
const invalidDecision: MetadataByKind["ADR"] = { summary: "Outcome", environment: null };
export const metadataExamples = [task, decision, invalidTask, invalidDecision];
