BEGIN;

-- Data-preserving rollback: the authoritative targets remain available to an
-- older application, which ignores the additive columns. Submission locks,
-- session evidence, continuation scope and audit history are unchanged.

COMMIT;
