import crypto from 'node:crypto';
export const BOOKING_TERMS_VERSION = 'standalone-2026-09-07';
export const TRIAL_TERMS = 'Der Testzugang kostet einmalig 299 € netto und endet automatisch nach 14 Tagen. Es erfolgt keine automatische Verlängerung und keine Umwandlung in ein kostenpflichtiges Paket. Pro, Business oder Enterprise können separat und ausdrücklich gebucht werden.';
export const PACKAGE_PRICES = Object.freeze({ NORMAL: { name: 'Pro', monthly: 99000, setup: 250000 }, PROFESSIONAL: { name: 'Business', monthly: 149000, setup: 490000 }, ENTERPRISE: { name: 'Enterprise', monthly: 249000, setup: 990000 } });
export function bookingContract(input) {
  const purchaseKind = input.purchaseKind;
  const plan = input.plan;
  const billingPath = input.billingPath;
  if (!['TRIAL','PACKAGE'].includes(purchaseKind)) throw new Error('billing_purchase_kind_invalid');
  if (purchaseKind === 'TRIAL' ? plan !== 'TRIAL' : !PACKAGE_PRICES[plan]) throw new Error('billing_plan_invalid');
  if (!['AUTO_CARD','INVOICE_KLARNA','INVOICE_BILLIE'].includes(billingPath)) throw new Error('billing_path_invalid');
  if (input.consentVersion !== BOOKING_TERMS_VERSION || ![true,'on'].includes(input.bookingConfirmed)) throw new Error('billing_explicit_booking_required');
  const renewal = input.renewal === true;
  if (renewal && (purchaseKind !== 'PACKAGE' || billingPath === 'AUTO_CARD')) throw new Error('billing_manual_renewal_required');
  const amountSubtotal = purchaseKind === 'TRIAL' ? 29900 : PACKAGE_PRICES[plan].monthly + (renewal ? 0 : PACKAGE_PRICES[plan].setup);
  return { purchaseKind, plan, dbPlan: plan === 'TRIAL' ? 'ENTERPRISE' : plan, billingPath, consentVersion: BOOKING_TERMS_VERSION, renewal, amountSubtotal };
}
export function nextBillingPeriod(now) {
  const start = new Date(now), result = new Date(now);
  result.setUTCDate(1); result.setUTCMonth(result.getUTCMonth()+1);
  const last = new Date(Date.UTC(result.getUTCFullYear(),result.getUTCMonth()+1,0)).getUTCDate();
  result.setUTCDate(Math.min(start.getUTCDate(),last));
  return result;
}
export async function createBoundCheckout(db, adapter, tenantId, contract, existingBookingId) {
  const bookingId = existingBookingId || crypto.randomUUID();
  const checkout = await adapter.createCheckout({ ...contract, tenantId, bookingId });
  await db.query(`INSERT INTO saas.checkout_sessions(provider,provider_checkout_ref,tenant_id,plan_code,billing_path,purchase_kind,booking_id,consent_version,consented_at,amount_subtotal,renewal)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10) ON CONFLICT(provider,provider_checkout_ref) DO NOTHING`,
  [adapter.provider,checkout.id,tenantId,contract.dbPlan,contract.billingPath,contract.purchaseKind,bookingId,contract.consentVersion,contract.amountSubtotal,contract.renewal]);
  return checkout;
}
