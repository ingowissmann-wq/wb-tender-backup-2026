BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';
DROP TABLE IF EXISTS tender.tender_expiry_reviews;
COMMIT;
