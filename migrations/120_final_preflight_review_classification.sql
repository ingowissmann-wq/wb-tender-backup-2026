BEGIN;

ALTER TABLE tender.final_preflight_requirements
  ADD CONSTRAINT final_preflight_requirements_classification_review_chk
  CHECK(requirement_classification IS NULL OR requirement_classification IN(
    'FILLABLE_BIDDER_FORM','BID_TIME_UPLOAD_EVIDENCE','POST_AWARD_EVIDENCE',
    'CONTRACT_PERFORMANCE_CLAUSE','INFORMATIONAL_TEXT','REVIEW_REQUIRED'
  )) NOT VALID;

ALTER TABLE tender.final_preflight_requirements
  DROP CONSTRAINT final_preflight_requirements_classification_chk;

ALTER TABLE tender.final_preflight_requirements
  RENAME CONSTRAINT final_preflight_requirements_classification_review_chk
  TO final_preflight_requirements_classification_chk;

ALTER TABLE tender.final_preflight_requirements
  VALIDATE CONSTRAINT final_preflight_requirements_classification_chk;

INSERT INTO app.schema_migrations(version,description)
VALUES('0120-final-preflight-review-classification','Allow the explicit fail-closed REVIEW_REQUIRED classification in final preflight reconciliation')
ON CONFLICT(version) DO NOTHING;

COMMIT;
