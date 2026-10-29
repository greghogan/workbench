/** Test-owned policies isolate workflow behavior from edits to Workbench's published policy collection. */
export const evaluationPolicy = {
  "ADR-00.md":
    "---\nsummary: Human authority over intent and policy.\nagent_instruction: Humans write charters and approve ADR changes before commit.\n---\n\n# ADR-0: Authority\n\nCharters express human intent. Humans approve changes to decision records.\n",
  "ADR-01.md":
    "---\nsummary: Preserve behavior with repeatable local checks.\n---\n\n# ADR-1: Verification\n\nUse declared tools and checks. Test observable outcomes and boundary cases; do not weaken assertions to pass. Keep tests isolated and retain regression evidence for repaired defects.\n",
  "ADR-02.md":
    "---\nsummary: Adaptive planning and approval.\nagent_instruction: Obtain human approval of a concrete plan before implementing a major feature.\n---\n\n# ADR-2: Planning\n\nPlans can evolve as questions are answered. Retain material questions, answers, verification, and unresolved decisions. Distinguish proposals from authorized work and human acceptance from passing tests.\n",
  "ADR-03.md":
    "---\nsummary: Review coherent changes before publication.\nagent_instruction: Review the complete changeset before commit; keep implementation unpublished until human acceptance and publication authorization.\n---\n\n# ADR-3: Review\n\nInspect changes and their interactions, fix verified in-scope defects, and retain meaningful evidence. Authorized local commits and amendments may precede human acceptance. Project reviews retain findings and proposed coherent follow-ups for developer review.\n",
};
