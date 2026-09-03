# Public admin login routing incident (2026-09-03)

## Proven public path

The public page `/admin/ausschreibungen/login` is routed by the active host
Nginx configuration to `127.0.0.1:4240`. Its generated `auth.js` posts to
`/api/tender/auth/login`; Nginx strips `/api/tender/` and sends the request to
the same service as `/api/auth/login`.

The previously successful probe used `/api/admin/v1/iam/login`. The active
Nginx configuration routes that different endpoint to `127.0.0.1:4341`, the
`wb-admin-rehearsal-auth-1` container and its rehearsal database. It therefore
did not test the public Tender browser login.

## Root cause

The 4341 Admin IAM uses Argon2id (`m=65536,t=3,p=1`). The 4240 owner-login
verifier accepts only `$scrypt$65536$8$1$...`. The operational password update
created an Argon2id hash in both databases. The password value is unchanged,
but the real 4240 verifier rejects the stored format before deriving a hash.

Runtime response times corroborate the branch taken: earlier Scrypt checks took
roughly 200–255 ms; the affected public requests return 401 in roughly 3–20 ms.

## Repair and rollback

`Dockerfile.tender-owner-auth-argon2-compatibility` overlays only the inspected
owner-login verifier and the Argon2 runtime already deployed in the Admin image.
It preserves Scrypt verification, accepts only the Admin IAM's exact Argon2id
cost profile, does not rewrite any password, and leaves MFA unchanged.

Build arguments must resolve to the exact inspected production Tender image and
Admin-auth image IDs. Rollback is the previous Tender image ID captured before
the API container replacement. Both external-submission flags must remain
`false`.
