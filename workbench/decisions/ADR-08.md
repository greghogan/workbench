---
summary: Testable comparisons, candidate refinement, effect size and uncertainty, retained evidence, and human review.
agent_instruction:
  Obtain human review of completed experiments, environment records, and their supporting files before commit. Before
  recommending rejection, evaluate plausible improvements to the candidate's design and implementation.
---

# ADR-8: Experiments and measurement evidence

Create experiment records for testable comparisons: candidate and baseline, controlled difference, workload, correctness
criterion, metric, and evaluation rule. Use pilot runs to refine measurement procedures. Document evaluation and
stopping decisions, and account for adaptive sampling when assessing confidence. Use matched conditions and interleaving
when drift matters. Scale evidence to the claimed effect and measured variation: smaller effects relative to noise need
more independent evidence. Use no arbitrary percentage improvement cutoff; insufficient evidence yields an inconclusive
result. Exploratory profiling and routine verification need not become experiments; their files remain disposable unless
required as experimental evidence.

Experiment records use the `EXP` type code under `workbench/experiments/`; hardware environment records use `ENV` under
`workbench/environments/`. Both are project-owned Markdown records with YAML frontmatter and are not inherited. An
environment may describe one machine or a hardware family, with configuration-specific inventories and characterization
captures in its supporting directory under ADR-4. Add relevant profiling evidence when first using a configuration;
preserve captures referenced by earlier experiments and record the software used for characterization. Sharing an
environment does not imply equivalent performance.

Experiments identify the exact hardware configuration, profile capture, allocated resources, OS release, kernel, and
toolchain versions used, directly or through linked provenance. Software changes, including OS upgrades, do not require
new hardware environments. Record material deviations and any approved scheduler bypass or absence, without duplicating
facts fixed by the tested revision and canonical build.

Commit accepted candidates with their experiment; that commit identifies the tested source. For candidates not retained
in source, preserve an applicable patch against a named baseline, including rejected, inconclusive, and uncommitted
candidates. Record build deviations needed for reproduction; neither duplicate an exact committed candidate as a patch
nor require a commit to name itself. Microbenchmarks establish mechanisms; workflow claims need representative
end-to-end evidence.

Group retained evidence in the experiment's supporting directory under ADR-4. Preserve results and context needed to
assess the conclusion, including variation, exclusions, and failures that summaries would hide. Verify extracted
evidence against source reports; the record must remain assessable after disposable reports are deleted, without
embedding or compressing a complete copy. Create a new record for a distinct comparison; retain protocol revisions and
candidate refinements with the evidence they produced. Distinguish exploratory refinements from confirmatory evidence.

Before recommending rejection, assess whether material weaknesses in the candidate's design, implementation, or
measurement explain the result. Evaluate plausible improvements in proportion to their expected benefit and cost, and
explain why further refinement is unwarranted. Limit conclusions to what the evidence establishes: an unsuccessful
implementation alone does not establish that the underlying approach is unsuitable. Unresolved material limitations
leave broader claims inconclusive.

Agents may plan, run, and refine experiments within authorized work without separate protocol approval. Humans review
completed experiments, new and changed environment records, and their supporting files before commit. ADR-1 defines the
shared acknowledgment rules and provisional-commit exception. Changes to previously committed experimental conclusions
retain that review requirement. Review of the completed evidence is independent of accepting or rejecting the candidate:
rejected and inconclusive comparisons can still be satisfactorily completed experiments, and favorable measurements do
not establish human acceptance. Keep execution recipes in the experiment workflow.

Rationale: Declared comparisons and retained evidence make empirical conclusions assessable. Reviewing candidate
limitations prevents premature rejection of promising approaches. Human review controls which conclusions enter the
durable project record.
