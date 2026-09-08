# Separate paid trial and package booking

The trial is a separate one-time 299 EUR net purchase granting exactly 14 days
from verified payment. It has no subscription, setup fee, deferred invoice item,
conversion or recurring charge. Trial entitlements use the full Enterprise module
bundle internally; `purchase_kind=TRIAL` and Stripe `plan_code=TRIAL` distinguish
this access from a separately purchased Enterprise package.

Pro, Business and Enterprise are explicitly booked in registration or the existing
customer account. Card package checkouts collect setup and the first monthly fee
immediately, then renew monthly. Billie package checkouts collect setup and one
month as a separate one-time payment. Subsequent manual months require a separate
customer-initiated payment without another setup fee. Access expires unless paid.
Only card and Billie are offered. Signed event binding includes tenant, session, booking ID,
purchase kind, plan, method, recorded consent and net amount. Neither a success
page nor a trial invoice can activate a package. Two successful events referring
to the same checkout do not activate it twice.

Migration 164 adds nullable explicit booking provenance so legacy sessions cannot
be silently treated as consent. It also prevents native provisioning from changing
an existing user's password or MFA. Rollback restores migration 162's exact prior
function definition and the preceding schema. The previous application must not
be used to accept new standalone trial purchases after rollback.

## Production acceptance

Release evidence is recorded separately from source code. The final unchanged
image must pass the complete production-data restore, browser, SMTP, checkout,
limits and rollback acceptance before controlled cutover. Unit tests alone do
not establish PRODUCTION_PASS or LIVE_GO.
