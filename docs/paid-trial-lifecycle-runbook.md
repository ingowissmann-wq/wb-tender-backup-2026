# Paid-trial lifecycle runbook

The paid-trial lifecycle is implemented by `platform/trial-lifecycle.mjs`, `platform/trial-lifecycle-worker.mjs`, migration `101_paid_trial_lifecycle.sql`, the Green package migration, and the associated tests.

## Mandatory invariants

- Trial and subscription state is tenant-bound and server-enforced.
- Missing, unpaid, expired, canceled, suspended, or ambiguous state fails closed.
- Event replay is idempotent and provider identifiers remain bound to one authoritative lifecycle.
- Trial processing cannot enable external tender submission; both external-submission environment switches must remain `false`.
- Expiry and downgrade change access state without deleting tenant business data.

## Isolated rehearsal

1. Use a checksum-verified isolated database restore.
2. Record the migration ledger and existing tenant/subscription/trial counts.
3. Apply `101_paid_trial_lifecycle.sql` only when its full ledger version is absent.
4. Run `scripts/paid-trial-rehearsal.mjs` and the paid-trial, Stripe webhook, entitlement, and tenant-isolation tests.
5. Verify activation, renewal, payment failure, cancellation, expiry, duplicate-event handling, and immediate server-side revocation.
6. Rehearse `deployment/rollback-paid-trial-lifecycle.sql` and confirm that tenant business data and audit evidence remain intact.

The Green commercial package migration is rehearsed separately and only after the base trial lifecycle is green. Price configuration is an explicit commercial action and is not part of a technical repair deployment.

## Production gate

Production activation requires the full release gates, a committed candidate digest, successful isolated rollback rehearsal, browser acceptance, and an explicit commercial approval. Monitor lifecycle jobs and entitlement denials after cutover; never repair a failed lifecycle by editing a running container.
