# mend — one patch tool for every AI edit format

Agent harnesses apply edits that models write, and models write them in four
formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks,
the V4A patch format, and text-editor tool calls as JSON. Each public applier
reads one of them. `mend` reads all four to one written specification, finds
the lines an edit names even when the model drifted their whitespace or
indentation, and changes every file or none.

Built for the make.fun bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
The whole contract is `SPEC.md`, which ships in this repository.

[![Bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/portgas-commits/mend-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/portgas-commits/mend-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed file (`A`, `D`, `M`, or `R old -> new`)
and `ok: <n> files`. Exit 1 lists every edit that failed and
`failed: <k> of <n> edits`, and no file is written. Exit 2 is a usage,
missing-patch, format or parse error, with exactly one line on stdout.

## Matching

An edit's old lines are found at the first of three tiers at which they occur:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed;
- tier 2: every line equal once leading and trailing spaces and tabs are removed.

At tier 2 the new lines are re-indented to the file's own indentation.
Unified hunks take the occurrence nearest the (possibly wrong) line number
the patch names; SEARCH/REPLACE blocks require exactly one occurrence;
V4A chunks walk the file with a cursor and anchors.

## Requirements

Node 22 and its standard library only — nothing is installed before the
program runs. Deterministic, and atomic: every file changes, or none does.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's trial runner (kept as shipped).
- `SPEC.md` — the specification.
- `LICENSE` — MIT.

## Repository

Maintained under the GitHub account
[portgas-commits](https://github.com/portgas-commits).
