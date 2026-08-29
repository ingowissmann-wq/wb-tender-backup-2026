BEGIN;
CREATE TABLE IF NOT EXISTS tender.company_profile_field_evidence(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_profile_id uuid NOT NULL REFERENCES tender.company_profiles(id), company_id uuid NOT NULL,
 field_key text NOT NULL, evidence_version integer NOT NULL, filename text NOT NULL, media_type text NOT NULL, size_bytes bigint NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), content bytea NOT NULL, malware_scan_status text NOT NULL,
 validation_status text NOT NULL DEFAULT 'UPLOADED_PENDING_VALIDATION', source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 is_current boolean NOT NULL DEFAULT true, uploaded_by uuid NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT now(),
 reviewed_by uuid, reviewed_at timestamptz, UNIQUE(company_profile_id,field_key,evidence_version)
);
CREATE UNIQUE INDEX IF NOT EXISTS company_profile_field_evidence_current_uq ON tender.company_profile_field_evidence(company_profile_id,field_key) WHERE is_current;
ALTER TABLE tender.company_profile_field_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender.company_profile_field_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_profile_field_evidence_scope ON tender.company_profile_field_evidence;
CREATE POLICY company_profile_field_evidence_scope ON tender.company_profile_field_evidence USING(
 current_setting('app.profile_admin',true)='true' OR company_id::text=ANY(string_to_array(current_setting('app.company_ids',true),','))
) WITH CHECK(
 current_setting('app.profile_admin',true)='true' OR company_id::text=ANY(string_to_array(current_setting('app.company_ids',true),','))
);
COMMIT;
