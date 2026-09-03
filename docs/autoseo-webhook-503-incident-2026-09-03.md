# AutoSEO webhook HTTP 503 incident (2026-09-03)

## Endpoint and data flow

The configured public target is
`https://www.enwi.online/api/integrations/autoseo/webhook?key=<redacted>`.
The production flow is:

1. AutoSEO sends JSON to the public `www.enwi.online` endpoint.
2. DNS resolves `www.enwi.online` to `31.70.120.7`; valid TLS terminates at
   Nginx.
3. The exact Nginx location proxies to `127.0.0.1:4341`.
4. The AutoSEO handler authenticates either the existing derived URL key or
   the Bearer/HMAC header contract and resolves the internal tenant.
5. The handler stores the editable article in PostgreSQL `app.resources`, SEO
   metadata in `cms.seo_metadata`, media metadata in `files.objects` and
   `app.resource_files`, and media bytes below the mounted private storage
   root.
6. `www.wb-holding.ag` reads the published PostgreSQL CMS resource through
   the read-only public CMS API. Public media is served from
   `https://www.enwi.online/api/public/v1/autoseo/media/<uuid>` only when it is
   a verified public object referenced by a published AutoSEO resource.

The origins are intentionally separate:

- CMS/API origin: `AUTOSEO_CMS_API_ORIGIN=https://www.enwi.online`
- media origin: `AUTOSEO_MEDIA_ORIGIN=https://www.enwi.online`
- public website origin: `AUTOSEO_PUBLIC_SITE_ORIGIN=https://www.wb-holding.ag`

Article and canonical URLs therefore remain on `www.wb-holding.ag`; only the
CMS API and its guarded media delivery are on `www.enwi.online`.

## Root cause

DNS, TLS, firewall, request size, method, content type, Nginx and the healthy
4341 upstream were not the source of HTTP 503. Application and PostgreSQL logs
correlated the failed deliveries with:

`there is no unique or exclusion constraint matching the ON CONFLICT specification`

Migration 084 had replaced the global resource uniqueness constraint with the
tenant-scoped partial index
`(tenant_id,source_system,resource_type,external_id) WHERE external_id IS NOT NULL`.
The media upsert still named the old three-column conflict target.

End-to-end verification also exposed three downstream defects that would have
kept a correct delivery from completing:

- historical, hash-matched media rows could refer to missing local bytes;
- the generated `/cms-media/<uuid>` URL was deliberately rejected by Nginx;
- verification and the public renderer used different CMS field envelopes and
  aliases. The handler additionally wrote a redundant SQLite blog projection,
  which was not the website's source and could diverge from PostgreSQL.

## Fix

Local commits `93ac2813f418b4e1140588944a2a42ea2ef23baf` and
`32f2ad0` contain the handler and public-rendering fixes. The complete final
file set is published on GitHub as commit
`4375134e4b41cebefaec3d9a0c5cfdaa5d438994`:

- target the exact tenant-scoped partial unique index;
- preserve the already deployed URL-key, raw-body compatibility and explicit
  tenant-context behavior;
- repair missing media bytes only from a freshly downloaded, hash-verified
  source, with reversible compensation;
- use the existing guarded read-only AutoSEO media route and store an absolute
  CMS-origin media URL;
- store both canonical CMS fields and renderer aliases (`fullContent`,
  `content`, `coverImage`) so the public site renders the same PostgreSQL row;
- accept the active wrapped public API response while retaining strict field,
  canonical, sitemap and media checks;
- serialize rollback JSON values explicitly as JSONB;
- stop writing the redundant SQLite blog projection. PostgreSQL is the sole
  mutable article source; the authenticated CMS PATCH route and the public
  renderer both read/write `app.resources`.
- return newly created published `blogposts` first from the shared public CMS
  query, while retaining the existing ordering of every other resource type;
- permit cross-origin embedding only on the guarded public AutoSEO media route
  with `Cross-Origin-Resource-Policy: cross-origin`. Nginx continues to limit
  CORS to `https://www.wb-holding.ag`.

No Nginx file, webhook secret, password, MFA setting or unrelated website
content was changed. External Submission remains hard-disabled.

## Runtime proof

Final runtime:

- container: `wb-admin-rehearsal-auth-1`
- container ID: `4338a0437d7bdc6535b8893425524c0873805009de40a6b04f07e2b3f9a430ea`
- image: `wb-admin:autoseo-tenant-upsert-fix.10`
- image ID: `sha256:ae19c715c81c6c8b227c2ca903741ad6fa336ebc58a6e9a79c4789adb5c487ec`
- binding: `127.0.0.1:4341 -> 3400/tcp`
- state: healthy, zero restarts after start at `2026-09-03T23:24:19Z`

Public URL-key authentication returned HTTP 200 for a test event; a wrong key
returned HTTP 401. A signed realistic two-image delivery returned HTTP 200 and
an identical replay returned HTTP 200 without a second resource-version bump.

The originally reported article, external ID `2389001`, was retried by AutoSEO
and delivery `f7e3764b-aaa3-4e48-85ae-6df2221c55a6` completed as `published`
at `2026-09-03T23:08:05Z`. Its stored source payload was then processed through
the final handler to materialize the renderer aliases and guarded media URLs.
The result is one editable PostgreSQL CMS resource, version 2, and zero matching
SQLite blog rows. The public page is HTTP 200 at:

`https://www.wb-holding.ag/blog/hausmeisterservice-unternehmen-in-augsburg-munchen`

Its canonical and sitemap entry use `www.wb-holding.ag`. Its hero and
infographic objects return HTTP 200 with `image/jpeg` from the guarded enwi
media endpoint (149008 and 356506 bytes respectively).

A separate production E2E article (`wb-autoseo-e2e-20260903-2308`) proved the
create-and-edit lifecycle without touching existing content. The webhook
created one PostgreSQL CMS row and no SQLite blog row. A controlled CMS
persistence edit, using the same versioned mutation contract as the
authenticated CMS PATCH route, changed title, body, metadata and image title,
created a revision/audit event, and advanced version 3 to 4. A cache-busted
request to `www.wb-holding.ag` immediately returned the edited title, body and
image title from that same row; the image remained HTTP 200.

Verification completed with:

- repository tests: 373 passed, 0 failed, 0 skipped;
- production gate: passed, External Submission hard-disabled;
- artifact verification: passed;
- SaaS gate: passed with feature flag and External Submission disabled;
- production-configured readiness gate: passed, API HTTP 200, all three
  constraints validated, zero external/submission receipts, zero stale jobs,
  zero active scope mismatches;
- production worker and scheduler: healthy and unchanged.

## Blog index and media follow-up

### Root cause and affected query

The detail route could resolve the Winterdienst article by slug, and the
shared public CMS API contained it, but `/blog` initially displayed only the
first 12 results in the browser. The generic public query in `server.js`
ordered every resource type by `created_at ASC`. The recent AutoSEO rows were
therefore at the end of the 86-item response. There was no source, category,
tenant, visibility or AutoSEO exclusion and no server-side `LIMIT`; the
browser applied its normal 12-card pagination to the wrongly ordered result.

After correcting that query, Chromium exposed the remaining image failure:
the stored card URLs were distinct, but Helmet attached
`Cross-Origin-Resource-Policy: same-origin` to media served by `enwi.online`.
Chromium correctly rejected those resources when embedded by
`wb-holding.ag`, even though Nginx already supplied the correct CORS origin.
The website then showed its generic visual fallback.

### Fix and data integrity

Only `blogposts` now use `created_at DESC`; other public CMS resource types
retain their previous ascending order. The public media route now overrides
CORP to `cross-origin` after it has verified that the UUID belongs to a
verified public file referenced by a published AutoSEO CMS resource. No media
row, article row or manually maintained content was modified by this response
header fix.

The stored AutoSEO source and CMS linkage were checked for two real articles:

- Winterdienst: source hero image with query string -> media UUID
  `f2ce6d36-19d7-4c64-82ad-d2f2f653864e`, JPEG, 165007 bytes, SHA-256
  `babe6cc8cfe618231196d3c64a1f4191cdb1a2be417a41f1c218efe4f8c79b69`;
- Hausmeisterservice: different source hero image -> media UUID
  `f841e499-4968-4013-9fe6-f47c6a1f8d64`, JPEG, 149008 bytes, SHA-256
  `85a613f131b635dc50d72be8bb241b1858f2fb8d3355f01f22dd9d197a86186c`.

For both, the hash of the persistent file equals `files.objects.sha256`, the
article has its own `app.resource_files` hero relation and its own editable
CMS media resource, and the AutoSEO alt text is retained in the article data,
media data and relation metadata. AutoSEO supplied no image title for these
two deliveries, so the stored title is intentionally empty. JPEG, PNG and
WebP are signature-checked; redirects are limited to three, downloads to 10
seconds and 10 MB, TLS/HTTPS and public-address validation are mandatory, and
query strings are preserved.

### Chromium proof

Chromium 140 loaded the real public `/blog` page after the deploy. The first
card was `Winterdienst für Gewerbe in München & Augsburg`, with the expected
title, teaser and media UUID. The second card was the Hausmeisterservice
article with its different UUID. Both images completed at 1200 x 675, returned
HTTP 200 `image/jpeg`, and produced the exact expected SHA-256 values inside
the browser. There were zero failed AutoSEO media requests.

Direct Chromium navigation to both slug detail pages returned HTTP 200 and
loaded the same article-specific media UUID and hash used by its index card.
This proves the path `AutoSEO raw source -> CMS resource -> files.objects ->
resource_files -> guarded media endpoint -> blog index/detail` without an
external hotlink or a shared fallback image.

The deployed wb-holding frontend currently chooses the article title for the
HTML `alt` attribute. This is its existing presentation rule; the original
AutoSEO alt text remains intact and editable in the CMS and media relation.
Changing that frontend rule requires the separate website source/deployment,
which is not present in this repository or accessible on the website host
from this runtime.

## Rollback

The pre-change rollback set is retained at
`/srv/wb-tender-recovery/admin-runtime-rehearsal-4/autoseo-webhook-fix-20260903T224056Z/`.
It contains the original handler and Nginx configuration, a targeted PostgreSQL
dump of all affected AutoSEO/CMS/audit tables, the career SQLite database and a
copy of the private media tree.

The exact previous runtime is retained as stopped container
`wb-admin-rehearsal-auth-rollback-autoseo-20260903T224056Z` and tagged image
`wb-admin:rollback-autoseo-webhook-20260903T224056Z`, image ID
`sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86`.
Rollback therefore does not depend on rebuilding an image. The rollback image,
container and manifest/dumps must not be deleted.

The immediately preceding media-capable runtime is also retained as stopped
container `wb-admin-rehearsal-auth-pre-media-corp-20260903T2326Z` with image
`wb-admin:autoseo-tenant-upsert-fix.9` for a one-step application rollback.
