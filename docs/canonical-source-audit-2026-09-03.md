# Canonical source audit — 2026-09-03

## Result

The source of candidate 25 cannot be proven from the Git object database that
is available in this checkout. The checkout has no configured remote, no tags,
and only the commits `7fd625c`, `1a12eff`, and the current PR commits. Therefore
`master` is neither reachable nor comparable here. The current PR commit is the
only reproducible Git source baseline, but it must **not** be called the proven
candidate-25 source.

The supplied container runtime is also unavailable in this workspace (`docker`
is not installed), so image
`sha256:71a7de5d82499727e98026b64030eb7de57c4a63eeff11027efa885d89f39671`
cannot be inspected or exported locally. A server-side source/image fingerprint
check is consequently a mandatory acceptance gate.

## Why 355 is not 783

The root `tests/` directory contains 44 test files and currently registers 355
Node tests. `production-snapshot/api/tests` and
`production-snapshot/worker/tests` each contain 111 test files and register 632
tests when combined with the repository's Admin integration fixtures. They are
deployment snapshots, not Git histories, and API and worker snapshots differ in
runtime source files. Neither snapshot reproduces the reported 783 green tests:
the API snapshot produced 623 pass, 4 fail and 5 skip; the worker snapshot
produced 622 pass, 5 fail and 5 skip. Blindly copying either snapshot would both
lose later root changes and perpetuate API/worker drift.

Thus the difference is not 428 silently skipped root tests. The 783 result came
from an image/source set which is absent from the reachable Git objects. The
claim can only be closed by exporting candidate 25 or providing its source
commit/remote. Until then, release acceptance remains blocked.

## Canonicalization gate

The GitHub Actions release-image job resolves the configured base tag to an OCI
digest, builds exactly the checked-out commit with that immutable reference and
checks the resulting OCI revision label. It also creates API, worker and
scheduler containers and compares their image IDs. The production script does
not extract candidate revisions and does not accept interactive commit input.
Instead it requires two files prepared before invocation: successful rehearsal
evidence for the exact commit and a separate operator approval for that commit.
Database credentials remain file-based throughout.
