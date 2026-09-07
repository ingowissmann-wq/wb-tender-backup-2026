#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
: "${RELEASE_IMAGE:?digest-pinned release image required}"
: "${POSTGRES_IMAGE:?digest-pinned PostgreSQL 16 image required}"
for ref in "$RELEASE_IMAGE" "$POSTGRES_IMAGE"; do
  [[ "$ref" =~ (^|@)sha256:[0-9a-f]{64}$ ]] || exit 64
done
temporary=$(mktemp -d /tmp/wb-release-postgres-tools.XXXXXX)
name=wb-release-postgres-tools-$$
created=false
cleanup() {
  result=$?
  trap - EXIT
  if [[ "$created" == true ]]; then docker stop "$name" >/dev/null || result=1; fi
  rm -rf -- "$temporary"
  exit "$result"
}
trap cleanup EXIT
docker run --rm -d --name "$name" --network none \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=tool_proof "$POSTGRES_IMAGE" >/dev/null
created=true
ready=false
for attempt in {1..60}; do
  if docker exec "$name" psql -h 127.0.0.1 -U postgres -d tool_proof -Atc 'SELECT 1' 2>/dev/null | grep -qx 1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]]
major=$(docker exec "$name" psql -U postgres -d tool_proof -Atc 'SHOW server_version_num')
[[ "$major" -ge 160000 && "$major" -lt 170000 ]]
docker exec "$name" psql -U postgres -d tool_proof -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE release_tool_proof(value text PRIMARY KEY); INSERT INTO release_tool_proof VALUES('synthetic archive round trip');" >/dev/null
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --network "container:$name" "$RELEASE_IMAGE" pg_dump -h 127.0.0.1 -U postgres -d tool_proof -Fc >"$temporary/archive.dump"
docker run --rm -i --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --network none "$RELEASE_IMAGE" pg_restore --list <"$temporary/archive.dump" >"$temporary/catalog"
grep -q 'TABLE DATA public release_tool_proof' "$temporary/catalog"
docker exec "$name" psql -U postgres -d tool_proof -v ON_ERROR_STOP=1 -c 'DROP TABLE release_tool_proof' >/dev/null
docker run --rm -i --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --network "container:$name" "$RELEASE_IMAGE" pg_restore -h 127.0.0.1 -U postgres -d tool_proof --exit-on-error <"$temporary/archive.dump"
[[ "$(docker exec "$name" psql -U postgres -d tool_proof -Atc 'SELECT value FROM release_tool_proof')" == 'synthetic archive round trip' ]]
printf 'POSTGRES_16_RELEASE_ARCHIVE_ROUND_TRIP=PASS\n'
