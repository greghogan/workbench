# Workbench demonstration

Demonstration Project is a fictional, small application for browsing and searching a folder of Markdown notes. Its
project records follow a feature from design decisions through planned work, an experiment, and an illustrative release.

Start with ADR-0 for file ownership, ADR-1 for offline search, and ADR-2 for disposable indexes. The task examples
include an approved delivery plan with nested work, an evolving export plan with open questions, and a project-review
log with two coherent refactors and a deferred proposal. All use the same task record format.

Plans includes a saved bookmark plan and a preview assessment awaiting revised approval. Work retains the started
assessment and shows active work and a refactor waiting for its prerequisite. Reviews includes the completed preview
focus task, its delivery commit and ADR review, and separate reviews for changes outside that task. The demo creates
the planning branch and execution state when it starts.

Experiments cover planned, running, accepted, rejected, and inconclusive comparisons. Citations show both a local PDF
and sources that have not been downloaded.
Release records illustrate a current release and a withdrawn one.

All tasks, reviews, verification evidence, research, environments, and releases are fictional. Approval and acceptance
illustrate the workflow; they do not describe real Workbench work, measurements, policy review, or publication. The
charter retains its human-written intent.

`workbench serve --demo` copies these files into private temporary storage. The review queue includes a revised decision
and supporting-file changes. Each record appears once; file acknowledgments remain independent. Restarting the server
discards session edits.
