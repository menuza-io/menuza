#!/usr/bin/env bash
# Admin (:3005) has no /login route. It reuses the App's `en_session` cookie (shared
# across localhost ports) but checks the session in packages/database/db/data.db,
# while App dev writes sessions to local D1. After logging in to the App as kody in
# a browser session, run this to copy kody's newest session row into data.db, then
# open http://localhost:3005/ in the same browser session. Never prints the id.
set -euo pipefail
REPO=/home/factory-user/repos/menuza
cd "$REPO/apps/app"
db="$REPO/packages/database/db/data.db"
U=$(sqlite3 "$db" "select id from User where username='kody'")
[ -n "$U" ] || { echo "kody not found in data.db" >&2; exit 1; }
npx wrangler d1 execute DB --local --json --command "select id, expirationDate, createdAt, updatedAt, userId from Session where userId='${U}' order by createdAt desc limit 1" 2>/dev/null |
	jq -r '.[0].results[0] | "INSERT OR REPLACE INTO Session (id, expirationDate, createdAt, updatedAt, userId) VALUES (\u0027\(.id)\u0027, \(.expirationDate), \(.createdAt), \(.updatedAt), \u0027\(.userId)\u0027);"' |
	sqlite3 "$db"
echo "Copied kody's newest App session into data.db"
