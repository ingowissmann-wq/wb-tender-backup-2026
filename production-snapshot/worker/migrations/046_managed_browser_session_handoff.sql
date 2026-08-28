ALTER TABLE tender.portal_read_sessions
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_status text,
  ADD COLUMN IF NOT EXISTS storage_state_version integer,
  ADD COLUMN IF NOT EXISTS cookie_count integer,
  ADD COLUMN IF NOT EXISTS origin_count integer;

UPDATE tender.portal_read_sessions
SET verification_status=CASE
  WHEN status='ACTIVE' AND expires_at<=now() THEN 'EXPIRED_UNVERIFIED_METADATA'
  WHEN status='ACTIVE' THEN 'LEGACY_COOKIE_ONLY_UNVERIFIED'
  ELSE coalesce(verification_status,'NOT_CURRENT')
END
WHERE verification_status IS NULL;

UPDATE tender.portal_read_sessions
SET status='EXPIRED',revoked_at=coalesce(revoked_at,now())
WHERE status='ACTIVE' AND expires_at<=now();
