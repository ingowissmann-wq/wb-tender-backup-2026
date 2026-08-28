BEGIN;

-- Writers must not be able to omit or spoof a company tenant. The binding is
-- derived only from the reconciled Green company/tenant map and then remains
-- subject to each table's FORCE RLS policy.
CREATE OR REPLACE FUNCTION tender.assign_authoritative_company_tenant()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,tender,saas AS $$
DECLARE bound_tenant uuid;
BEGIN
  IF NEW.company_id IS NULL THEN RAISE EXCEPTION 'company_scope_required'; END IF;
  SELECT binding.tenant_id INTO bound_tenant
  FROM saas.legacy_company_tenant_bindings binding
  WHERE binding.company_id=NEW.company_id;
  IF bound_tenant IS NULL THEN RAISE EXCEPTION 'authoritative_company_tenant_binding_required'; END IF;
  IF NEW.tenant_id IS NULL THEN NEW.tenant_id:=bound_tenant;
  ELSIF NEW.tenant_id<>bound_tenant THEN RAISE EXCEPTION 'company_tenant_binding_mismatch';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION tender.assign_authoritative_company_tenant() FROM PUBLIC;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'portal_credential_companies','portal_read_sessions','calculations','calculation_input_snapshots',
    'management_outputs','approval_requests','bid_packages','submission_contexts','required_documents',
    'required_document_uploads','required_document_working_copies'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS authoritative_company_tenant_guard ON tender.%I',table_name);
    EXECUTE format('CREATE TRIGGER authoritative_company_tenant_guard BEFORE INSERT OR UPDATE OF tenant_id,company_id ON tender.%I FOR EACH ROW EXECUTE FUNCTION tender.assign_authoritative_company_tenant()',table_name);
  END LOOP;
END $$;

-- Replay only active, exact-scope contexts that failed because of the repaired
-- tenant/RLS/IAM/idempotency defects. Portal or MFA failures remain closed and
-- no submission action is eligible for this reconciliation.
INSERT INTO tender.autopilot_queue(
  tender_id,tender_version_id,reason,status,attempt,next_attempt_at,request_id,action_type,notice_id,lot_id,
  company_id,service_scope,portal_id,credential_id,enrichment_version_id,idempotency_key,created_by,lot_key,max_attempts
)
SELECT q.tender_id,q.tender_version_id,'DLQ_RUNTIME_SCOPE_RECONCILIATION_V2','QUEUED',0,
  now()+make_interval(secs=>mod(row_number() OVER(ORDER BY q.created_at,q.id)::int,600)),gen_random_uuid(),q.action_type,
  q.notice_id,q.lot_id,q.company_id,q.service_scope,q.portal_id,q.credential_id,q.enrichment_version_id,
  encode(digest('repair-replay-v2:'||q.id::text,'sha256'),'hex'),q.created_by,q.lot_key,coalesce(q.max_attempts,5)
FROM tender.autopilot_queue q
JOIN tender.tenders t ON t.id=q.tender_id AND t.source_lifecycle_status='ACTIVE'
JOIN tender.current_registered_tender_company_portals scope
  ON scope.tender_id=q.tender_id AND scope.company_id=q.company_id AND scope.portal_id=q.portal_id
WHERE q.reason='DLQ_EXACT_SCOPE_RECONCILIATION' AND q.status='DEAD_LETTER'
  AND q.action_type NOT LIKE '%SUBMIT%'
  AND (
    (coalesce(q.safe_error_code,q.error_code)='23502' AND q.error_detail_safe LIKE 'null value in column "tenant_id"%')
    OR (coalesce(q.safe_error_code,q.error_code)='42501' AND (q.error_detail_safe LIKE 'new row violates row-level security%' OR q.error_detail_safe='permission denied for table users'))
    OR coalesce(q.safe_error_code,q.error_code)='23505'
  )
ON CONFLICT DO NOTHING;

COMMIT;
