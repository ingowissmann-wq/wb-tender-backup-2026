BEGIN;
SET LOCAL row_security=off;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM tenant_portal.lot_document_reviews) THEN RAISE EXCEPTION 'document_reviews_not_empty_preserve_customer_data'; END IF;
END $$;
DROP TABLE tenant_portal.lot_document_review_files;
DROP TABLE tenant_portal.lot_document_reviews;
COMMIT;
