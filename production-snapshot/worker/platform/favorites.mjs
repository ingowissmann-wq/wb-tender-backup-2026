const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const validFavoriteId = (value) => UUID.test(String(value || ""));

export function favoriteMetadata(body = {}, { partial = false } = {}) {
  const value = {};
  if (!partial || Object.hasOwn(body, "name")) {
    const name = String(body.name ?? "").trim();
    if (name.length > 160) throw Object.assign(Error("favorite_name_too_long"), { statusCode: 400 });
    value.name = name || null;
  }
  if (!partial || Object.hasOwn(body, "note")) {
    const note = String(body.note ?? "").trim();
    if (note.length > 2000) throw Object.assign(Error("favorite_note_too_long"), { statusCode: 400 });
    value.note = note || null;
  }
  if (!partial || Object.hasOwn(body, "priority")) {
    const priority = Number(body.priority ?? 3);
    if (!Number.isInteger(priority) || priority < 1 || priority > 5)
      throw Object.assign(Error("favorite_priority_invalid"), { statusCode: 400 });
    value.priority = priority;
  }
  return value;
}

export function favoriteContext(body = {}) {
  const companyId = String(body.company_id ?? body.companyId ?? "").trim() || null;
  const lotKey = String(body.lot_key ?? body.lotKey ?? "").trim() || null;
  if (companyId && !validFavoriteId(companyId))
    throw Object.assign(Error("favorite_company_invalid"), { statusCode: 400 });
  if (!companyId && lotKey)
    throw Object.assign(Error("favorite_company_required_for_lot"), { statusCode: 400 });
  if (lotKey && lotKey.length > 240)
    throw Object.assign(Error("favorite_lot_too_long"), { statusCode: 400 });
  return { companyId, lotKey };
}

export async function saveFavorite(pool, { userId, tenderId, companyId = null, lotKey = null, name = null, note = null, priority = 3 }) {
  const inserted = (await pool.query(
    `INSERT INTO tender.favorites(user_id,tender_id,company_id,lot_key,name,note,priority)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING
     RETURNING id,user_id,tender_id,company_id,lot_key,name,note,priority,created_at,updated_at`,
    [userId, tenderId, companyId, lotKey, name, note, priority],
  )).rows[0];
  if (inserted) return { item: inserted, idempotent: false };
  const item = (await pool.query(
    `SELECT id,user_id,tender_id,company_id,lot_key,name,note,priority,created_at,updated_at
       FROM tender.favorites
      WHERE user_id=$1 AND tender_id=$2
        AND company_id IS NOT DISTINCT FROM $3::uuid
        AND lot_key IS NOT DISTINCT FROM $4::text`,
    [userId, tenderId, companyId, lotKey],
  )).rows[0];
  return { item, idempotent: true };
}
