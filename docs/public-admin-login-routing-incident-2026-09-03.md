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

## Final production runtime proof

The corrected overlay was built from Tender image
`sha256:30d64f6334519b095f4af837380ac7b56df6ff0c90fb3652a0c100f3528335e3`
and Admin-auth image
`sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86`.
The resulting image is
`sha256:a52bfdbb8cd90aeacd48b9978e018085a53d414e927f8b102d7d53bc438924af`.

At `2026-09-03T22:19:43.277Z`, headless Chromium loaded the real public URL
`https://www.enwi.online/admin/ausschreibungen/login`, submitted the existing
password through the rendered form, and received HTTP 200 from exactly
`/api/tender/auth/login`. The response required MFA, did not request MFA setup,
and supplied a login challenge. The browser displayed the existing MFA code
input, the `Sicher anmelden` action, and the message `Passwort bestätigt. Bitte
den zweiten Faktor eingeben.` No MFA code was submitted.

The 4240 service log independently recorded the corresponding proxied
`POST /api/auth/login` as HTTP 200 in 184.85 ms. The production API container
`11aaa72d64e69001c212030cf57d78e65deae515b3de01738358acf80273d175`
was healthy on the candidate image after verification. Worker and scheduler
retained their pre-rollout container and image IDs. Runtime values
`EXTERNAL_SUBMISSION_ENABLED=false` and
`WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false`, and the image label
`wb.tender.external-submission=hard-disabled`, were re-verified after the
browser test.

The temporary verification password file was securely overwritten and removed
immediately after the successful MFA-challenge proof. The password hash and MFA
configuration were not changed.
