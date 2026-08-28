import crypto from "node:crypto";
import { withTenantContext } from "./tenant-context.mjs";

export const PAID_TRIAL_PRODUCT_KEY = "wb_business_suite_trial_14d";
export const DEFAULT_TRIAL_REMINDER_OFFSETS = Object.freeze([5, 2]);
export const TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000;

export function safeUpgradeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

export function paidTrialEnd(startedAt) {
  const start = new Date(startedAt);
  if (!Number.isFinite(start.getTime())) throw new Error("trial_start_invalid");
  return new Date(start.getTime() + TRIAL_DURATION_MS);
}

export function normalizeReminderOffsets(value = DEFAULT_TRIAL_REMINDER_OFFSETS) {
  const offsets = [...new Set((Array.isArray(value) ? value : String(value).split(",")).map(Number))].sort((a, b) => b - a);
  if (!offsets.length || offsets.some((offset) => !Number.isInteger(offset) || offset < 1 || offset > 13)) throw new Error("trial_reminder_offsets_invalid");
  return Object.freeze(offsets);
}

export function trialDaysRemaining(trialEndsAt, now = new Date()) {
  const remaining = new Date(trialEndsAt).getTime() - new Date(now).getTime();
  if (!Number.isFinite(remaining)) return 0;
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
}

export function trialBillingStatus({ trial = null, regularLicenses = [], blockers = [], upgradeUrl = "", now = new Date() } = {}) {
  const active = Boolean(trial && trial.status === "TRIAL_ACTIVE" && new Date(trial.trial_ends_at) > now);
  return Object.freeze({
    trial: trial ? {
      productKey: trial.commercial_product_key,
      status: active ? "ACTIVE" : trial.status === "EXPIRED" || new Date(trial.trial_ends_at) <= now ? "EXPIRED" : trial.status,
      startedAt: trial.trial_started_at,
      endsAt: trial.trial_ends_at,
      daysRemaining: active ? trialDaysRemaining(trial.trial_ends_at, now) : 0,
    } : null,
    regularLicenses: regularLicenses.map((row) => ({ productKey: row.commercial_product_key, status: row.status })),
    converted: regularLicenses.some((row) => ["ACTIVE", "PAST_DUE"].includes(row.status)),
    upgradeUrl: safeUpgradeUrl(upgradeUrl),
    unavailableTrialModules: blockers.map((row) => ({ moduleKey: row.module_key, code: row.blocker_code, detail: row.safe_detail })),
    externalSubmissionEnabled: false,
  });
}

export function trialReminderMessage({ trialEndsAt, upgradeUrl, offsetDays }) {
  upgradeUrl = safeUpgradeUrl(upgradeUrl);
  if (!upgradeUrl) throw new Error("trial_upgrade_url_invalid");
  const end = new Date(trialEndsAt);
  if (!Number.isFinite(end.getTime())) throw new Error("trial_end_invalid");
  const exact = new Intl.DateTimeFormat("de-DE", { dateStyle: "full", timeStyle: "long", timeZone: "Europe/Berlin" }).format(end);
  const subject = `WB Business Suite: Ihre 14-Tage-Testphase endet in ${offsetDays} Tagen`;
  const text = `Ihre bezahlte 14-Tage-Testphase endet am ${exact}.\n\nDer Zugriff auf ausschließlich durch die Testphase freigeschaltete Module wird dann deaktiviert. Ihre Mandanten-, Benutzer-, Dokument-, Konfigurations- und Auditdaten bleiben erhalten. Bereits bezahlte reguläre Lizenzen bleiben aktiv.\n\nReguläres Paket wählen: ${upgradeUrl}`;
  const html = `<p>Ihre bezahlte 14-Tage-Testphase endet am <strong>${exact}</strong>.</p><p>Der Zugriff auf ausschließlich durch die Testphase freigeschaltete Module wird dann deaktiviert. Ihre Daten und bereits bezahlte reguläre Lizenzen bleiben erhalten.</p><p><a href="${upgradeUrl}">Reguläres Paket wählen</a></p>`;
  return { subject, text, html };
}

export function classifyTrialDeliveryFailure(error) {
  return error?.deliveryAttempted === false ? "FAILED" : "DELIVERY_UNKNOWN";
}

const lifecycleEvent = async (db, row, eventType, metadata = {}) =>
  db.query("INSERT INTO saas.license_events(tenant_id,license_id,event_type,metadata) VALUES($1,$2,$3,$4)", [row.tenant_id, row.license_id, eventType, metadata]);

export async function processTrialLifecycle(pool, {
  emailAdapter, upgradeUrl, reminderOffsets = DEFAULT_TRIAL_REMINDER_OFFSETS,
  now = new Date(), workerId = `trial-worker-${process.pid}`, batchSize = 50, retryMinutes = 30,
} = {}) {
  const offsets = normalizeReminderOffsets(reminderOffsets);
  upgradeUrl = safeUpgradeUrl(upgradeUrl);
  if (!upgradeUrl) throw new Error("trial_upgrade_url_invalid");
  const client = await pool.connect();
  let reminders = [], expired = [];
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE saas.trial_reminder_deliveries SET status='DELIVERY_UNKNOWN',last_error_code='dispatch_lease_expired',updated_at=$1
      WHERE status='DISPATCHING' AND claimed_at<$1-interval '30 minutes'`, [now]);
    await client.query(`INSERT INTO saas.trial_reminder_deliveries(tenant_id,license_id,offset_days,due_at,next_attempt_at)
      SELECT l.tenant_id,l.id,o,l.trial_ends_at-make_interval(days=>o),l.trial_ends_at-make_interval(days=>o)
      FROM saas.tenant_product_licenses l JOIN saas.products p ON p.product_key=l.commercial_product_key
      CROSS JOIN unnest($2::smallint[]) o
      WHERE p.offer_class='PAID_TRIAL' AND l.status='TRIAL_ACTIVE' AND l.trial_ends_at>$1
      ON CONFLICT(license_id,offset_days) DO NOTHING`, [now, offsets]);
    expired = (await client.query(`WITH due AS (
        SELECT l.id FROM saas.tenant_product_licenses l JOIN saas.products p ON p.product_key=l.commercial_product_key
        WHERE l.status='TRIAL_ACTIVE' AND l.trial_ends_at<=$1 AND p.offer_class='PAID_TRIAL'
        ORDER BY l.trial_ends_at,l.id FOR UPDATE OF l SKIP LOCKED
      ), changed AS (
        UPDATE saas.tenant_product_licenses l SET status='EXPIRED',updated_at=$1 FROM due WHERE l.id=due.id
        RETURNING l.id license_id,l.tenant_id,l.trial_ends_at
      ), audited AS (
        INSERT INTO saas.license_events(tenant_id,license_id,event_type,metadata)
        SELECT tenant_id,license_id,'TRIAL_EXPIRED',jsonb_build_object('trialEndsAt',trial_ends_at,'workerId',$2::text) FROM changed
      ) SELECT * FROM changed`, [now, workerId])).rows;
    await client.query(`UPDATE saas.trial_reminder_deliveries r SET status='CANCELED',last_error_code='trial_expired',updated_at=$1
      FROM saas.tenant_product_licenses l WHERE r.license_id=l.id AND l.status='EXPIRED' AND r.status IN('PENDING','FAILED')`, [now]);
    const claimToken = crypto.randomUUID();
    reminders = (await client.query(`WITH candidates AS (
        SELECT r.id FROM saas.trial_reminder_deliveries r JOIN saas.tenant_product_licenses l ON l.id=r.license_id
        WHERE r.status IN('PENDING','FAILED') AND r.due_at<=$1 AND r.next_attempt_at<=$1
          AND l.status='TRIAL_ACTIVE' AND l.trial_ends_at>$1
        ORDER BY r.due_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT $2
      ) UPDATE saas.trial_reminder_deliveries r SET status='DISPATCHING',attempts=attempts+1,
          claim_token=$3,claimed_at=$1,updated_at=$1 FROM candidates WHERE r.id=candidates.id
        RETURNING r.*`, [now, Math.max(1, Math.min(500, Number(batchSize) || 50)), claimToken])).rows;
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }

  const delivery = [];
  for (const reminder of reminders) {
    let recipient;
    const lookup = await withTenantContext(pool, { tenantId: reminder.tenant_id }, async (db) =>
      (await db.query("SELECT email FROM saas.pending_registrations WHERE tenant_id=$1", [reminder.tenant_id])).rows[0]);
    recipient = lookup?.email;
    try {
      if (!emailAdapter?.configured) throw Object.assign(new Error("email_provider_not_configured"), { deliveryAttempted: false });
      if (!recipient) throw Object.assign(new Error("trial_reminder_recipient_missing"), { deliveryAttempted: false });
      const message = trialReminderMessage({ trialEndsAt: reminder.due_at && new Date(new Date(reminder.due_at).getTime() + reminder.offset_days * 86400000), upgradeUrl, offsetDays: reminder.offset_days });
      const result = await emailAdapter.sendTrialReminder({ to: recipient, ...message, idempotencyKey: `trial-reminder-${reminder.id}` });
      await withTenantContext(pool, { tenantId: reminder.tenant_id }, async (db) => {
        const updated = await db.query(`UPDATE saas.trial_reminder_deliveries SET status='SENT',sent_at=$4,provider_message_id=$5,
          claim_token=NULL,updated_at=$4 WHERE tenant_id=$1 AND id=$2 AND claim_token=$3 AND status='DISPATCHING' RETURNING license_id`,
        [reminder.tenant_id, reminder.id, reminder.claim_token, now, result?.messageId || null]);
        if (updated.rowCount) await lifecycleEvent(db, reminder, "TRIAL_REMINDER_SENT", { offsetDays: reminder.offset_days });
      });
      delivery.push({ id: reminder.id, status: "SENT" });
    } catch (error) {
      const status = classifyTrialDeliveryFailure(error);
      const knownNotSent = status === "FAILED";
      await withTenantContext(pool, { tenantId: reminder.tenant_id }, async (db) => {
        const updated = await db.query(`UPDATE saas.trial_reminder_deliveries SET status=$4,last_error_code=$5,
          next_attempt_at=$6,claim_token=NULL,updated_at=$7 WHERE tenant_id=$1 AND id=$2 AND claim_token=$3 AND status='DISPATCHING' RETURNING license_id`,
        [reminder.tenant_id, reminder.id, reminder.claim_token, status, String(error.message || "delivery_failed").slice(0, 120), new Date(now.getTime() + retryMinutes * 60000), now]);
        if (updated.rowCount) await lifecycleEvent(db, reminder, knownNotSent ? "TRIAL_REMINDER_RETRY_PENDING" : "TRIAL_REMINDER_DELIVERY_UNKNOWN", { offsetDays: reminder.offset_days, errorCode: String(error.message || "delivery_failed").slice(0, 120) });
      });
      delivery.push({ id: reminder.id, status });
    }
  }
  return { expired: expired.length, claimed: reminders.length, delivery, reminderOffsets: offsets };
}
