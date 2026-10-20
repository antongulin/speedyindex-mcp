# Documentation contract

## Purpose

Maintain the roadmap, runtime architecture, dependency decisions, and source attribution.

## Ownership

`implementation-plan.md` owns proposed scope and delivery gates. `architecture.md` describes runtime boundaries; `dependencies.md` records compatibility decisions. `provenance.md` owns documentation sources and revisions. `dox-LICENSE.txt` preserves the upstream notice verbatim.

## Local Contracts

Describe actual state accurately: four read-only tools are implemented and eight remain on the roadmap. Document `get_task_report` as one fixed request and, for backlink reports, one explicitly bounded page; do not describe report fields as proof of completeness or fresh indexing truth. Keep operational records, credentials, account data, and machine-specific details out of public docs. Preserve source links and license attribution.

## Work Guidance

Update the roadmap as verified behavior ships. Reconcile this contract and its parent index when documentation ownership changes.

## Verification

Check relative links, source revisions, and claims against the actual tree. Run `git diff --check`. Compare the DOX notice with its recorded source when updating attribution.

## Child DOX Index

None.
