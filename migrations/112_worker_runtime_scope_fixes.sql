BEGIN;

-- The worker resolves an existing human actor for review/approval artifacts.
-- It receives read-only access to exactly the IAM relations used for that
-- resolution; session mutation and IAM administration remain unavailable.
GRANT SELECT ON iam.users,iam.user_roles,iam.roles,iam.role_permissions,iam.permissions
  TO tender_worker_runtime;

COMMIT;
