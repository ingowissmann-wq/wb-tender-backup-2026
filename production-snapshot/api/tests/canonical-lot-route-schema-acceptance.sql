\set ON_ERROR_STOP on

BEGIN;

PREPARE canonical_lot_selection_get(uuid,uuid,uuid) AS
SELECT selection.tender_id,selection.company_id,selection.lot_id,selection.source_lot_id,
  selection.created_at selected_at,selection.updated_at
FROM tender.tender_lot_selections selection
JOIN tender.lots lot
  ON lot.id=selection.lot_id AND lot.tender_id=selection.tender_id
  AND lot.external_id=selection.source_lot_id
WHERE selection.tenant_id=$1 AND selection.company_id=$2 AND selection.tender_id=$3;

PREPARE canonical_lot_selection_context(uuid,uuid,uuid,text,uuid) AS
SELECT lot.id lot_id,version.id tender_version_id,lifecycle.deadline_evidence_id,
  scope.canonical_service
FROM tender.lots lot
JOIN tender.tender_lot_lifecycles lifecycle
  ON lifecycle.tender_id=lot.tender_id AND lifecycle.lot_key=lot.external_id
  AND lifecycle.is_current AND lifecycle.lifecycle_status='ACTIVE'
  AND lifecycle.participation_status='ELIGIBLE' AND lifecycle.deadline_quality='EXACT'
  AND lifecycle.offer_deadline>now() AND lifecycle.deadline_evidence_id IS NOT NULL
JOIN tender.configuration_scopes scope
  ON scope.tenant_id=$1 AND scope.company_id=$2 AND scope.profile_id=$5
JOIN LATERAL(
  SELECT candidate.id FROM tender.tender_versions candidate
  WHERE candidate.tender_id=lot.tender_id ORDER BY candidate.version DESC LIMIT 1
) version ON true
WHERE lot.tender_id=$3 AND lot.external_id=$4;

PREPARE canonical_lot_selection_save(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,text,uuid,uuid) AS
INSERT INTO tender.tender_lot_selections(
  tenant_id,company_id,tender_id,tender_version_id,lot_id,source_lot_id,inbox_id,
  region_evaluation_id,canonical_service,deadline_evidence_id,selection_source,selected_by
)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'EXPLICIT_SELECTION',$11)
ON CONFLICT(tenant_id,company_id,tender_id) DO UPDATE
SET tender_version_id=excluded.tender_version_id,lot_id=excluded.lot_id,
  source_lot_id=excluded.source_lot_id,inbox_id=excluded.inbox_id,
  region_evaluation_id=excluded.region_evaluation_id,
  canonical_service=excluded.canonical_service,
  deadline_evidence_id=excluded.deadline_evidence_id,
  selection_source=excluded.selection_source,selected_by=excluded.selected_by,updated_at=now()
RETURNING tender_id,company_id,lot_id,source_lot_id,created_at selected_at,updated_at;

ROLLBACK;

SELECT 'canonical_lot_route_schema_3_of_3' result;
