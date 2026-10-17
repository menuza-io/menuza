#!/usr/bin/env bash
# Set (or delete) an organization-level ConfigFlag for local testing.
#
# Usage: set-org-flag.sh <org-slug> <flag-key> <json-value|delete>
#   set-org-flag.sh acme reservations.enabled true
#   set-org-flag.sh acme reservations.online false
#   set-org-flag.sh acme reservations.platform_fee_bp 250
#   set-org-flag.sh acme reservations.voice delete
#
# Writes local D1 (what App dev on :3001 reads) and, when the organization exists
# there, packages/database/db/data.db (what Admin dev, db scripts and Playwright
# read). riyadh-grill exists only in D1. Values are stored as JSON text ('true',
# '250'). The unique index includes a NULL userId, so the row is deleted and
# re-inserted rather than upserted.
set -euo pipefail
slug="${1:?org slug required}"
key="${2:?flag key required}"
value="${3:?json value or 'delete' required}"
REPO=/home/factory-user/repos/menuza
cd "$REPO/apps/app"

d1() { npx wrangler d1 execute DB --local --json --command "$1" 2>/dev/null; }

org_id=$(d1 "select id from Organization where slug='${slug}'" | node -e '
let s = ""
process.stdin.on("data", (d) => (s += d)).on("end", () => {
	const j = JSON.parse(s)
	const r = (Array.isArray(j) ? j[0] : j).results
	process.stdout.write(r && r[0] ? r[0].id : "")
})')
if [ -z "$org_id" ]; then
	echo "organization '${slug}' not found in local D1" >&2
	exit 1
fi

id="mission_${key//./_}_${org_id}"
now=$(date +%s%3N)
del="DELETE FROM ConfigFlag WHERE key='${key}' AND level='organization' AND organizationId='${org_id}' AND userId IS NULL;"
ins="INSERT INTO ConfigFlag (id, key, value, level, organizationId, userId, createdAt, updatedAt) VALUES ('${id}', '${key}', '${value}', 'organization', '${org_id}', NULL, ${now}, ${now});"
if [ "$value" = "delete" ]; then sql="$del"; else sql="$del $ins"; fi

d1 "$sql" >/dev/null
echo "D1: ${key}=${value} for ${slug} (${org_id})"

db="$REPO/packages/database/db/data.db"
if [ -f "$db" ] && [ -n "$(sqlite3 "$db" "select id from Organization where id='${org_id}'")" ]; then
	sqlite3 "$db" "$sql"
	echo "data.db: ${key}=${value} for ${slug}"
else
	echo "data.db: organization not present there, skipped"
fi

# tenant-api caches the reservations context for 5 minutes. Tell both local nodes
# the context changed so the flag flip is visible right away (best effort).
token="${INTERNAL_COMMAND_TOKEN:-$(sed -n 's/^INTERNAL_COMMAND_TOKEN=//p' "$REPO/packages/cache/.env.schema" | head -1)}"
for port in 3007 3009; do
	code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:${port}/internal/reservations/context-changed" \
		-H "Authorization: Bearer ${token}" -H 'Content-Type: application/json' \
		--data "{\"orgId\":\"${org_id}\"}" || true)
	echo "tenant-api :${port} context-changed -> ${code}"
done
