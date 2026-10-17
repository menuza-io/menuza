# Validation readiness: Reservations mission

- Repo: `/home/factory-user/repos/menuza` at commit `5f61fd1c` on `main`.
- Date: 2026-10-15, 18:38 to 19:24 UTC.
- Machine: 4 CPUs, 7956 MB RAM, 6 GB swap.
- At the end, `git status --porcelain` is empty, nothing was committed, and no
  tracked files were modified.
- All services and browser sessions that were started have been stopped. Ports
  3001, 3005, 3007, 3008, 3009, 3101, 24678 and 24679 are free. No node,
  workerd, astro, esbuild or chromium processes remain, and
  `agent-browser session list` reports "No active sessions".

## Status per surface and tool

| Surface / tool                                                               | Status                     | Notes                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tenant-api US :3007                                                          | works                      | Healthy about 6 s after start.                                                                                                                                                                  |
| tenant-api KSA :3009                                                         | works, **with a fix**      | Must run with its own `TENANT_DB_DIR` (see blocker B2).                                                                                                                                         |
| App :3001 (Workers vite dev)                                                 | works, **slow cold start** | 14 min on the first start after an `npm install` (vite re-optimizes dependencies, and workerd crashed twice from running out of heap). A warm restart takes 69 s. Use `VITE_DIRECT_DEV=1` (B3). |
| Sites :3008                                                                  | works                      | Listens on `[::1]` only. Resolves the organization from the Host header. `*.localhost` does **not** work (B5).                                                                                  |
| Admin :3005                                                                  | works                      | `PORT=3005` pins it if the port is free. Otherwise it silently moves to the next free port, so check that 3005 is free first. Login needs a session row in `data.db` (B6).                      |
| Operator flow in agent-browser (login, acme, Staff, Team)                    | works, **after a DB fix**  | Browser-direct calls `GET http://localhost:3007/operator/staff…` return 200. CORS preflight returns 204. No CORS errors.                                                                        |
| Guest flow in agent-browser (acme site, sign in, OTP)                        | works                      | `POST :3007/auth/send-code` returns 200, the code appears in the log as `[SMS MOCK]`, and `/auth/verify` returns 200. Tokens are stored in `localStorage`.                                      |
| KSA organization (create, switch region to KSA, publish, site, OTP on :3009) | works                      | Slug `riyadh-grill`, id `ru0dm42cud9scs4g2duep21c`.                                                                                                                                             |
| Tenant-api email capture                                                     | **partial**                | Only `[OCI EMAIL MOCK] To: … \| Subject: …` is written to stdout. There is no body and no links (B7).                                                                                           |
| App email in Workers dev                                                     | **fails**                  | Signup shows "API key is invalid", because the request goes to the real Resend API with no key. Nothing is captured (B8).                                                                       |
| Playwright (`staff-roster.test.ts`, CI mode, :3101)                          | **pass**                   | 4 tests passed in 36.2 s (39 s wall time). The App build took 110 s. The server on 3101 was gone afterwards.                                                                                    |

## Commands for services.yaml

All paths are absolute. Each service runs in its own process group (the npm
PID), so stop it by killing that group. Killing only the npm PID or only the
listener can leave a `tsx watch` orphan behind; this was observed.

```yaml
services:
  tenant-api-us:
    start: 'cd /home/factory-user/repos/menuza/apps/tenant-api && npm run dev'
    port: 3007
    healthcheck: 'curl -sf http://localhost:3007/health' # {"status":"ok","region":"us"} about 6 s after start
    stop:
      "kill -- -$(ps -o pgid= -p $(lsof -ti tcp:3007 -sTCP:LISTEN | head -1) |
      tr -d ' ')"
  tenant-api-ksa:
    start:
      'mkdir -p /home/factory-user/repos/menuza/packages/database/db/ksa && cd
      /home/factory-user/repos/menuza/apps/tenant-api &&
      TENANT_DB_DIR=/home/factory-user/repos/menuza/packages/database/db/ksa npm
      run dev:ksa'
    port: 3009
    healthcheck: 'curl -sf http://localhost:3009/health' # region "ksa"
    stop:
      "kill -- -$(ps -o pgid= -p $(lsof -ti tcp:3009 -sTCP:LISTEN | head -1) |
      tr -d ' ')"
  app:
    start:
      'cd /home/factory-user/repos/menuza/apps/app && VITE_DIRECT_DEV=1 npm run
      dev'
    port: 3001
    healthcheck: 'curl -sf --max-time 60
      http://localhost:3001/resources/healthcheck' # warm start 69 s; cold start (after npm install) up to about 15 min
    stop: "kill -- -$(ps -o pgid= -p $(lsof -ti tcp:3001 -sTCP:LISTEN | head -1)
      | tr -d ' ')" # also stops workerd
    depends_on: [tenant-api-us]
  sites:
    start:
      'cd /home/factory-user/repos/menuza/apps/sites &&
      PUBLIC_APP_URL=http://localhost:3001 npm run dev'
    port: 3008
    healthcheck: "curl -sf -o /dev/null -H 'Host: acme.menuza.test:3008'
      http://localhost:3008/" # listening after 6 s; first page 2 s
    stop:
      "kill -- -$(ps -o pgid= -p $(lsof -ti tcp:3008 -sTCP:LISTEN | head -1) |
      tr -d ' ')"
    depends_on: [app, tenant-api-us]
  admin:
    start:
      'lsof -ti tcp:3005 -sTCP:LISTEN && exit 1; cd
      /home/factory-user/repos/menuza/apps/admin && PORT=3005 npm run dev'
    port: 3005
    healthcheck: 'curl -sf --max-time 60
      http://localhost:3005/resources/healthcheck' # listening after 5 s; first healthcheck 13 s
    stop:
      "kill -- -$(ps -o pgid= -p $(lsof -ti tcp:3005 -sTCP:LISTEN | head -1) |
      tr -d ' ')"
commands:
  e2e_app_build: 'cd /home/factory-user/repos/menuza && npm run build -w app' # 110 s
  e2e_app_spec:
    'cd /home/factory-user/repos/menuza/apps/app && PORT=3101 CI=true npx
    playwright test tests/e2e/<spec>.test.ts --workers=1 --reporter=line'
  # Fallback if a process group was lost (stops BOTH tenant-api nodes):
  stop_all_tenant_api:
    "pkill -f 'tsx watch src/index.ts'; pkill -f 'tsx/dist/loader.*src/index.ts'"
```

App warm-up after a cold start:

- Watch `app.log` until lines like `optimized dependencies changed. reloading`
  stop appearing.
- Any browser page that shows "Invalid hook call" or renders with no interactive
  elements was loaded during a dependency re-optimization. Reload it.

## Login and bootstrap steps

### Operator (App)

1. `agent-browser --session <name> open http://localhost:3001/login`
2. Fill "Email or Username" with `kody`, then click **Continue**.
3. Fill "Password" with `KodyLovesYou!2026`, then click **Sign In**.
4. You land on `http://localhost:3001/acme`.
5. Staff Team is at `/acme/staff/team`.

A first-visit cookie banner appears (Accept/Reject); it does not block the form.
Staffing flags for `acme` are already on in D1.

### Guest (Sites)

1. Open `http://acme.menuza.test:3008/`. This works through `/etc/hosts`.
2. Click "Sign in" to reach `/login`.
3. Enter a phone number such as `+15555550123` and click **Send Code**.
4. Read the code from the tenant-api log (see the next section).
5. Enter it in "Verification Code" and click **Verify**. You land on
   `/complete-name`.

The page exposes `document.documentElement.dataset.tenantApiUrl`:
`http://localhost:3007` for acme and `http://localhost:3009` for the KSA
organization.

### Organizations without an /etc/hosts entry

Launch the browser with a host-resolver rule:

```
agent-browser --session <name> --args "--host-resolver-rules=MAP *.menuza.test [::1]" open http://<slug>.menuza.test:3008/
```

- The rule must map to **`[::1]`**. Sites and App listen on IPv6 loopback only,
  and `127.0.0.1` gives `ERR_CONNECTION_REFUSED`.
- `--args` applies only when the session's browser is launched. If the session
  is already running, close it first.

### Admin

Admin has no `/login` route; `/login` returns 404. It reuses the `en_session`
cookie, which is shared across ports on `localhost`, but it checks the session
against **`packages/database/db/data.db`**, while the App writes sessions to D1.

Bootstrap:

1. Log in to the App as kody in the same agent-browser session.
2. Copy the newest kody session row from D1 into `data.db`. Run this from
   `apps/app`; it does not print the id:

   ```bash
   U=$(sqlite3 ../../packages/database/db/data.db "select id from User where username='kody'")
   npx wrangler d1 execute DB --local --json --command "select id, expirationDate, createdAt, updatedAt, userId from Session where userId='$U' order by createdAt desc limit 1" 2>/dev/null \
    | jq -r '.[0].results[0] | "INSERT OR REPLACE INTO Session (id, expirationDate, createdAt, updatedAt, userId) VALUES (\u0027\(.id)\u0027, \(.expirationDate), \(.createdAt), \(.updatedAt), \u0027\(.userId)\u0027);"' \
    | sqlite3 ../../packages/database/db/data.db
   ```

3. Open `http://localhost:3005/feature-flags`.

kody has the `admin` role, and the user id is the same in both databases.

**Caveat:** Admin reads and writes flags in `data.db`, but the App dev server
reads D1. A flag set in Admin is therefore not visible to the App dev server.
Set App-facing flags with
`npx wrangler d1 execute DB --local --command "INSERT INTO ConfigFlag …"` from
`apps/app`.

## Reading mock SMS and email

### SMS (tenant-api, both nodes)

When Twilio credentials are absent, the code is printed to the node's stdout:

```
[SMS MOCK] To: +15555550123 | Message: Your verification code is: 988450
```

Retrieve it with:

```bash
grep -oE 'To: \+15555550123 \| Message: .*[0-9]{6}' /tmp/<log> | tail -1 | grep -oE '[0-9]{6}$'
```

US numbers appear in the US log and KSA organizations' codes in the KSA log. The
KSA log also prints "Twilio credentials not found. SMS will be logged to
console."

### Email sent by tenant-api

The path is `sendTenantEmail` → `sendOciEmail`
(`packages/email/src/oci/send-oci-email.ts:35-62`). tenant-api has no `MOCKS`
setting and no OCI configuration, so outside production it prints one line and
returns `{status:'skipped', data:{mock:true}}`:

```
[OCI EMAIL MOCK] To: guest@example.com | Subject: Reservation confirmed
```

I verified this by calling `sendTenantEmail` with the tenant-api varlock
environment. **The body, HTML, links and sender are not captured anywhere**:
there is no file and no dev endpoint.

If tenant-api were run with `MOCKS=true`, it would POST to
`https://mock.epic-stack.test/oci-email/...`, and nothing intercepts that inside
tenant-api, so it would fail.

A reservations feature whose validators need to follow email links needs a
dev-only sink. One example: when there is no OCI config and
`NODE_ENV!=='production'`, also write `{to, subject, text, html}` as JSON to a
gitignored directory, or log the text body. Treat this as a feature task.

### Email sent by the App

- **Workers dev (`npm run dev`):** this **does not work.**
  `EMAIL_PROVIDER=resend` and `MOCKS=true`, but no MSW runs inside workerd.
  `sendEmail` calls the real `api.resend.com` with an empty key. A signup with
  `vr-readiness@example.com` showed "API key is invalid" and nothing was
  captured.
- **Node mode with MSW (Playwright `start:mocks`, App `npm run dev:node`, Admin
  `npm run dev`):** the Resend and OCI requests are intercepted. Each email is
  written to
  `/home/factory-user/repos/menuza/packages/test-utils/fixtures/email/<recipient>.json`
  (gitignored; fields `to`, `from`, `subject`, `html`, `text`). Stdout also
  shows `🔶 mocked email contents:`. In e2e tests, use `readEmail` /
  `requireEmail` from `@repo/test-utils/mocks/utils`.

## KSA result

All steps succeeded after fix B2.

1. Created the organization in the App UI at `/organizations/create`: name
   "Riyadh Readiness Grill", slug **`riyadh-grill`**, id
   **`ru0dm42cud9scs4g2duep21c`**. Wizard steps: skip invites, then size "1-10"
   and department "Engineering", then Finish onboarding.
   - Creation provisions on the US node first. The create form has no region
     field.
2. On `/riyadh-grill/website`, set "Customer data region" to "Saudi Arabia
   (KSA)" and confirmed with "Delete data and switch".
   - US `/api/deprovision` returned 200 and KSA `/api/provision` returned 200.
3. With the original shared tenant DB directory, the KSA node reported success,
   but **no file existed**. The KSA process held a cached connection to the US
   file, which had been deleted (B2).
4. I restarted KSA with
   `TENANT_DB_DIR=/home/factory-user/repos/menuza/packages/database/db/ksa` and
   re-ran provisioning: `POST :3009/api/provision` with the internal token
   returned 200.
   - The file now exists:
     `/home/factory-user/repos/menuza/packages/database/db/ksa/tenant_ru0dm42cud9scs4g2duep21c.db`.
5. Published the site with the switch on the same page. D1 shows
   `dataRegion=ksa, hasProvisionedDb=1, sitePublished=1, active=1`.
   - The organization exists **only in D1**, not in `data.db`. tenant-api
     resolves it through the App fallback, and Admin will not list it.
6. Opened `http://riyadh-grill.menuza.test:3008/` with the `[::1]` host-resolver
   rule: the title is "Home - Riyadh Readiness Grill" and `data-tenant-api-url`
   is `http://localhost:3009`.
   - OTP for `+966500000123`: `POST :3009/auth/send-code` returned 200
     (preflight 204), the code appeared in the KSA log, and verify succeeded.
     The KSA database `customers` table now has 1 row.
7. `http://riyadh-grill.localhost:3008/` and `http://acme.localhost:3008/`
   resolve to loopback, but Sites returns **404 Not Found**.

## Playwright result

- Build: `cd /home/factory-user/repos/menuza && npm run build -w app` exited 0
  in 110 s.
  - I ran it with all five dev services up. Available memory fell to 800 MB and
    swap use peaked at 3.4 GB.
- Test:
  `cd apps/app && PORT=3101 CI=true npx playwright test tests/e2e/staff-roster.test.ts --workers=1 --reporter=line`
  gave **4 passed (36.2 s)**, exit 0, 39 s wall time. Minimum available memory
  during the run was 4.1 GB.
- Port 3101 was free afterwards. `apps/app/test-results/` is gitignored. Leave
  out `--reporter=line` to get the default html report (`playwright-report/`,
  gitignored).

## Resources

| State                                    | Used MB      | Available MB | Notes                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle baseline                            | 782          | 7174         | load 0.14, 95 processes                                                                                                                                                                                                                |
| All 5 services up, 0 browsers (steady)   | 4970-5390    | 2560-2990    | Service RSS about 4.0 GB: vite 1.3-1.5 GB, workerd 0.7-1.1 GB (peaked at 1.9 GB while warming), Admin node 0.6-0.9 GB plus an esbuild process of 0.75 GB, astro 0.75-0.8 GB, each tenant-api about 0.12-0.19 GB. Swap held 0.2-0.8 GB. |
| App cold start                           | up to 5.2 GB | 2.7 GB       | workerd hit its V8 heap limit twice and restarted                                                                                                                                                                                      |
| + 1 session (App, logged in, Staff page) | +530         | 2035         |                                                                                                                                                                                                                                        |
| + 2nd session (Sites login page)         | +105         | 1931         | about 2.9 GB of summed chromium RSS, which counts shared pages more than once                                                                                                                                                          |
| 2 sessions reloading at once             |              | 1885         | CPU busy 54-81% for about 3 s                                                                                                                                                                                                          |
| App build with all services up           |              | 800 min      | 3.4 GB swap                                                                                                                                                                                                                            |
| After shutdown                           | 735          | 7221         |                                                                                                                                                                                                                                        |

Per-session cost:

- An App operator session costs about **450-530 MB**. App dev serves unbundled
  modules, so this is the heavy case.
- A Sites guest session costs about **100-150 MB**.
- Use 450 MB per validator for planning.

Concurrency recommendation:

- Headroom with all services up is about 2600 MB. 70% of that is 1820 MB, and
  1820 / 450 = **4** sessions by memory alone.
- CPU is the tighter limit on 4 cores. Two concurrent reloads already reached
  about 80% CPU. App dev also recompiles routes on first hit, and a first App
  page load took 30-66 s.
- **Recommended maximum: 3 concurrent agent-browser validators** with all five
  services up.
  - Use **2** if any App build, typecheck, lint or Playwright run happens at the
    same time. App build plus services alone drove swap to 3.4 GB.
  - Use **4** if Admin is stopped (it frees about 0.6-1.4 GB) and nothing heavy
    runs.
- Never run the App build or typecheck alongside 3 or more browser sessions.

## Blockers and fixes applied

1. **B1 – acme tenant DB had stale staffing migrations from an older branch, so
   every operator Staff call returned 500 "Tenant Database unavailable".**
   - Cause: `SqliteError: table kiosk_devices already exists`. The database had
     4 old migration rows (created_at 1791694775370, 1791696360236,
     1791697502231, 1791700694777) and 11 old-schema tables: `kiosk_devices`,
     `kiosk_pairing_codes`, `schedule_publications`, `shifts`,
     `staff_assignments`, `staff_events`, `staff_members`, `staff_positions`,
     `staffing_settings`, `time_entries`, `time_entry_events`.
   - Check before fixing: comparing against a fresh build of migrations
     0000-0013 showed no column differences in the other tables.
   - **Fix:** backed up the database, dropped those 11 tables, and deleted the 4
     rows. On the next request tenant-api applied 0014 and 0015 (16 rows now),
     and Staff calls return 200.
   - The old staffing demo rows (3 staff, 22 shifts) are gone. Backup:
     `/home/factory-user/reservations-planning/readiness/backups/tenant_acme_before_fix.db`.
   - To get demo staff data again, run
     `npm run seed:staffing -w tenant-api -- acme`. This was not run.
2. **B2 – US and KSA tenant-api share `packages/database/db/` by default.**
   - The KSA staff tick opens every tenant file in that directory, including
     acme's. After a region switch, the KSA node keeps a cached connection to
     the file the US node just deleted, so "provision" succeeds against a file
     that no longer exists.
   - **Fix:** start KSA with
     `TENANT_DB_DIR=/home/factory-user/repos/menuza/packages/database/db/ksa`
     (gitignored). The directory and the KSA database are kept.
3. **B3 – App HMR websocket targets the HTTPS proxy.** The browser logs
   `failed to connect to websocket`, so pages do not auto-reload after vite
   re-optimizes dependencies; the result is stale chunks and "Invalid hook
   call".
   - **Fix:** `VITE_DIRECT_DEV=1`. Verified that the console shows
     `[vite] connected.`
4. **B4 – App cold start takes about 14 min after any `npm install` or
   `add-linux-bindings.sh`.** The lockfile hash changes, the vite SSR dependency
   scan fails on the lingui macro, and dependencies are discovered one by one,
   with 86 reloads and 2 workerd out-of-heap crashes.
   - Once the dependency cache in `apps/app/node_modules/.vite` is warm, a
     restart takes 69 s with zero re-optimizations.
   - Warm it once before the mission and do not reinstall mid-mission.
5. **B5 – Sites ignores `localhost` as a host suffix** (`splitHosts` filters it
   out), so `*.localhost` returns 404. Use
   `--host-resolver-rules=MAP *.menuza.test [::1]`.
6. **B6 – Admin login needs a session row copied into `data.db`**, and Admin
   flags live in `data.db` rather than D1. See the bootstrap steps above.
7. **B7 – tenant-api email body is not captured.** Only the recipient and
   subject are logged. A feature-level dev sink is needed if validators must
   follow email links.
8. **B8 – App email under Workers dev calls the real Resend API and fails.** Use
   Node/MSW mode (`start:mocks`, i.e. Playwright) to capture App emails as
   fixture files.

Smaller notes:

- The first `/resources/healthcheck` during warm-up can return 500 or take more
  than 30 s, and logs "Call bindCloudflareD1() before using db". Poll with
  `--max-time 60`.
- `pgrep -f workerd` matches the calling shell. Use `lsof` or
  `ps -eo args | grep [w]orkerd` instead.

## Local data created (approved)

- D1: organization `riyadh-grill` (`ru0dm42cud9scs4g2duep21c`, KSA, published),
  with kody as admin.
- KSA tenant DB: one customer, `+966500000123`.
- acme tenant DB: one customer, `+15555550123`, plus the B1 schema repair.
- D1: user `vr-readiness@example.com` was **not** created, because signup failed
  at the email step.
- `data.db`: one copied kody Session row.

## Files written

- `/home/factory-user/reservations-planning/readiness/validation-readiness.md`
  (this file)
- `/home/factory-user/reservations-planning/readiness/backups/tenant_acme_before_fix.db`
- Screenshots in
  `/home/factory-user/reservations-planning/readiness/screenshots/`:
  - `01-app-staff-team.png`
  - `02-sites-acme-home.png`
  - `03-sites-acme-after-otp.png`
  - `04-app-ksa-org-website-settings.png`
  - `05-sites-ksa-org-home.png`
  - `06-admin-feature-flags.png`
- `/home/factory-user/repos/menuza/packages/database/db/ksa/tenant_ru0dm42cud9scs4g2duep21c.db`
  (gitignored)
- Logs in `/tmp/vr/`: `tenant-us.log`, `tenant-ksa.log`, `app.log` (cold start),
  `app2.log` (warm start), `sites.log`, `admin.log`, `app-build.log`,
  `playwright.log`
