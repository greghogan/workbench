---
summary: Assessable comparisons, candidate refinement, proportionate evidence, follow-on learning, and human review.
agent_instruction:
  Obtain human review of completed experiments, environment records, and their supporting files before commit. Before
  recommending rejection, evaluate plausible improvements to the candidate's design and implementation.
---

# ADR-8: Experiments and measurement evidence

Experiment records identify the candidate and baseline, controlled difference, workload, correctness criterion, metric,
and evaluation and stopping rules. Evidence accounts for measured variation, drift, and adaptive sampling in proportion
to the claimed effect. No arbitrary percentage improvement cutoff establishes success; insufficient evidence yields an
inconclusive result. Exploratory profiling and routine verification need not become experiments; their files remain
disposable unless required as experimental evidence.

Experiment records use the `EXP` type code under `workbench/experiments/`; hardware environment records use `ENV` under
`workbench/environments/`. Both are project-owned Markdown records with YAML frontmatter and are not inherited.
Environments identify hardware platforms and the characteristics needed to place experiments in context and assess
meaningful comparisons. They may describe one machine or a hardware family, using public specifications where suitable.
Inventories and characterization are optional evidence when they materially aid interpretation. Software versions and
run-specific settings belong in the experiment when they affect the comparison.

Retain the minimum evidence needed to assess the findings and inform follow-on experiments, including material hardware,
software, resource, and measurement conditions. Software changes do not require new hardware environments. Record
material deviations, without duplicating facts fixed by the tested revision and canonical build or requiring a complete
reproduction bundle.

Each completed experiment has its own commit, containing the record and any accepted implementation; its parent is the
baseline. Retain an applicable candidate patch against that baseline for rejected and inconclusive experiments. Do not
duplicate accepted implementation as a patch or require a commit to name itself. Microbenchmarks establish mechanisms;
workflow claims need representative end-to-end evidence.

Retain evidence under ADR-4, including variation, exclusions, and failures that summaries would hide. Verify extracted
evidence against source reports; the record remains assessable after disposable reports are deleted without requiring a
complete copy. Different experimental questions receive separate records. Keep repeated runs, protocol revisions, and
candidate refinements for the same question together with their evidence. Distinguish exploratory refinements from
confirmatory evidence.

Before recommending rejection, assess whether material weaknesses in the candidate's design, implementation, or
measurement explain the result. Evaluate plausible improvements in proportion to their expected benefit and cost, and
explain why further refinement is unwarranted. Limit conclusions to what the evidence establishes: an unsuccessful
implementation alone does not establish that the underlying approach is unsuitable. Unresolved material limitations
leave broader claims inconclusive.

Agents may plan, run, and refine experiments within authorized work without separate protocol approval. Humans review
completed experiments, new and changed environment records, and their supporting files before commit, including changes
to committed conclusions. ADR-1 defines acknowledgment and provisional-commit rules. Human acceptance of the completed
evidence is independent of the candidate verdict: rejected and inconclusive comparisons can be completed experiments,
and favorable measurements do not establish human acceptance. Keep measurement methods and execution recipes in the
records guide.

Rationale: Declared comparisons and retained evidence make empirical conclusions assessable. Reviewing candidate
limitations prevents premature rejection of promising approaches. Human review controls which conclusions enter the
durable project record.
