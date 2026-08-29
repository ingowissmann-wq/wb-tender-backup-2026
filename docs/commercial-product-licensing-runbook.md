# Commercial product licensing runbook

Commercial licensing remains downstream of the stable technical core. The authoritative implementation is defined by `platform/commercial-licensing.mjs`, the SaaS catalog modules, migration `100_commercial_product_licensing.sql`, and their tests.

## Safety and scope

- Licensing changes must not enable external tender submission.
- Tenant, user, company, module, and capability enforcement is server-side; navigation hiding is not an authorization boundary.
- Unknown, retired, ambiguous, unpaid, expired, suspended, or mismatched commercial records fail closed.
- Billing event idempotency and provider binding are mandatory.
- Secrets and provider credentials are not stored in migrations, source, logs, or audit metadata.

## Rehearsal order

1. Restore a verified database backup into an isolated PostgreSQL clone.
2. Record the current `app.schema_migrations` ledger and SaaS/IAM/RLS invariants.
3. Run the complete source tests and `npm run gate`.
4. Apply `100_commercial_product_licensing.sql` only if its ledger version is absent.
5. Run `scripts/commercial-licensing-rehearsal.sql` and the commercial licensing tests.
6. Verify tenant isolation, active-offer uniqueness, entitlement resolution, revocation precedence, and billing idempotency.
7. Exercise `deployment/rollback-commercial-product-licensing.sql` in the clone and verify that business evidence is preserved.

## Release evidence

Record the committed source revision, candidate digest, migration ledger delta, test output, tenant-isolation result, RLS result, and rollback result. Production configuration of prices or commercial offers requires a separate commercial approval after the technical release is stable.
