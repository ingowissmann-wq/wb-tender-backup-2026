DROP INDEX IF EXISTS iam.tender_login_challenges_expiry_idx;
DROP TABLE IF EXISTS iam.tender_login_challenges;
ALTER TABLE saas.plans DROP CONSTRAINT IF EXISTS saas_approved_tender_price_boundary_chk;
