\set ON_ERROR_STOP on

BEGIN;

UPDATE tender.autopilot_queue queue
SET created_at=fixture.original_created_at
FROM tender.canonical_technical_retry_138_fixture_restore fixture
WHERE queue.id=fixture.queue_id;

DROP TABLE tender.canonical_technical_retry_138_fixture_restore;

COMMIT;
