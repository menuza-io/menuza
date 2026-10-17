# Dependency readiness: Reservations mission

- Repo: `/Users/zama/menuza` at commit `5f61fd1c` on branch `main`.
- Date: 2026-10-15.
- Machine: Linux x64, 4 CPUs, 7.9 GB RAM, 6 GB swap.
- No tracked files were left modified and nothing was committed.
  `git status --porcelain` is empty at the end.
  - One tracked file was regenerated and then restored:
    `packages/reports/src/env.ts`. It was clean before; details are in step 7.

## Status

| Dependency                                                         | Status                     | Notes                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node deps (`npm install`)                                          | available                  | Exit 0, 16 s. No lockfile drift.                                                                                                                                                                                                       |
| Linux native bindings for ESLint (`unrs-resolver`, `oxc-resolver`) | **installed (workaround)** | They are missing from the macOS-generated lockfile, so every `npm install` prunes them. Re-add them with `add-linux-bindings.sh` (see below).                                                                                          |
| `apps/admin/.env` (gitignored)                                     | **created**                | It was missing, so admin typecheck failed in varlock (`SESSION_SECRET` required). Created with the 3 keys copied from `apps/app/.env`, matching what `.agents/setup` produces.                                                         |
| fast-check                                                         | available                  | 4.9.0, hoisted to the root `node_modules` (devDependency of `apps/app`, `^4.3.0`). It resolves from any workspace. A new package should add `"fast-check": "^4.3.0"` to its own devDependencies. The throwaway install was not needed. |
| Control-plane migrations, `packages/database/db/data.db`           | applied                    | 26 rows; latest is `0024_dashboards`.                                                                                                                                                                                                  |
| Control-plane migrations, local D1                                 | applied                    | Latest is `0024_dashboards`. `wrangler d1 migrations list` reports "No migrations to apply".                                                                                                                                           |
| JDK 17                                                             | installed                  | apt `openjdk-17-jdk-headless`, javac 17.0.20.1, 17 s.                                                                                                                                                                                  |
| Android SDK                                                        | installed                  | `~/android-sdk`: cmdline-tools 15859902, platform-tools 37.0.1, platforms;android-36, build-tools;36.0.0. 11 s, 621 MB.                                                                                                                |
| Android test, build, release and size                              | pass                       | 77 of 77 tests pass. Release APK and AAB are within budget.                                                                                                                                                                            |
| Swift 6.4.1 (latest swift.org release)                             | installed                  | Tarball extracted to `~/swift`, 31 s, 3.5 GB. The GPG signature was **not verified** (the key import failed, "No public key"); the download was over HTTPS only.                                                                       |
| `apps/ios` `swift build` and `swift test` on Linux                 | pass                       | 72 of 72 XCTest tests pass. No code changes were needed.                                                                                                                                                                               |
| Lingui (`npm run lingui:check`)                                    | **passes**                 | No failure on this HEAD.                                                                                                                                                                                                               |
| Typecheck (12 workspaces)                                          | pass                       | Requires `NODE_OPTIONS=--max-old-space-size=4096`. Without it, the `app` typecheck runs out of heap (exit 134).                                                                                                                        |
| ESLint: sites, admin, `@repo/marketing-workflow`                   | pass                       |                                                                                                                                                                                                                                        |
| ESLint: app                                                        | **pre-existing failure**   | 59 errors and 79 warnings. It also needs a 4 GB heap.                                                                                                                                                                                  |
| oxlint (root)                                                      | pass                       | 0 errors, 19 warnings.                                                                                                                                                                                                                 |
| Unit tests (all requested)                                         | pass                       | No pre-existing test failures.                                                                                                                                                                                                         |

## Env exports workers must use

None of these were added to `~/.bash_profile`, so export them in the same
command:

```bash
# Android
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_SDK_ROOT=$HOME/android-sdk ANDROID_HOME=$HOME/android-sdk
export PATH=$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH
# Swift
export PATH=$HOME/swift/usr/bin:$PATH
# Heavy TS/ESLint on apps/app
export NODE_OPTIONS=--max-old-space-size=4096
```

`HOME` is `/home/factory-user`.

## Step details

### 1. npm install

- Command: `PUPPETEER_SKIP_DOWNLOAD=true npm install`
- Result: exit 0 in 16 s ("up to date"). `git status --porcelain` is empty, so
  there is no lockfile drift.
- Problem found later: the lockfile contains only
  `@unrs/resolver-binding-darwin-arm64`. It has no linux-x64 entries for
  `@unrs/resolver-binding-linux-x64-gnu@1.12.2` or
  `@oxc-resolver/binding-linux-x64-gnu@11.24.2`.
  - Without these, every ESLint run (app, sites, admin, marketing-workflow)
    crashes with "Cannot find native binding".
  - Both a plain `npm install` and the `.agents/setup` variant with
    `npm_config_os=linux npm_config_cpu=x64 npm_config_libc=glibc` **prune**
    them, and neither changes the lockfile.
- Workaround:
  `/home/factory-user/reservations-planning/readiness/add-linux-bindings.sh`.
  - It runs `npm pack` for the two bindings and extracts them into
    `node_modules`.
  - It is idempotent and touches no tracked files.
  - **Run it after every `npm install`.**
  - A permanent fix would regenerate the lockfile on Linux or add the bindings
    as optional dependencies. That modifies tracked files, so it was not done.

### 2. fast-check

- `ls node_modules/fast-check` finds the package.
- `npm ls fast-check` reports `app -> fast-check@4.9.0`.
- `node -e "require('fast-check')"` works from the repo root.

### 3. Control-plane migrations

- Both copies are git-ignored:
  - `.gitignore:49:packages/database/db/`
  - `.gitignore:85:.wrangler/` (covers
    `apps/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/a36f84ea…6006.sqlite`)
- Analysis of the old `0022_staffing_permissions` migration:
  - **data.db (drizzle):** the migrator applies journal entries whose `when` is
    greater than the last `created_at`. The old row has hash `2dc1371e…` and
    created_at 1791693288667. The new `0022_staffing_foundation` has
    when=1791956177889, so it is applied and not skipped.
  - **D1 (wrangler):** wrangler matches migrations by name, so the old name
    simply stays as an extra row.
  - The new 0022 re-inserts the same staffing permissions with
    `INSERT OR IGNORE`, so nothing conflicts.
- `npm run db:migrate:deploy`: exit 0 in 3 s.
  - `__drizzle_migrations` now has 26 rows; max created_at is 1791987385684
    (`0024_dashboards`).
  - Tables `JobPosting`, `StaffingOutbox`, `Dashboard` and `DashboardShare`
    exist.
- `cd apps/app && npm run db:migrate:d1:local`: exit 0 in 4 s. It applied
  `0022_staffing_foundation`, `0023_staffing_restaurant_locations` and
  `0024_dashboards`.
  - The final `d1_migrations` list includes: 21
    `0020_menu_permissions_and_legacy_cleanup`, 22 `0021_phone_agent`, 23
    `0022_staffing_permissions` (old, harmless), 24 `0022_staffing_foundation`,
    25 `0023_staffing_restaurant_locations`, 26 `0024_dashboards`.
  - The same 4 tables exist.
- `git status` was unchanged.

### 4. Android

- Install:
  - `sudo apt-get install -y openjdk-17-jdk-headless`: 17 s.
  - cmdline-tools zip plus `yes | sdkmanager --licenses` plus
    `sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"`:
    11 s.
- Verification, run from `apps/android` with the env above:

| Command                                                     | Exit | Time | Result                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run android:test` (first run; downloads Gradle 8.14.5) | 0    | 80 s | 77 tests, 0 failures                                                                                                                                                                                               |
| `npm run android:build` (assembleDebug)                     | 0    | 12 s |                                                                                                                                                                                                                    |
| `node scripts/generate-tenant.mjs --tenant ci --no-api`     | 0    | <1 s | Writes the ignored `app/tenant.properties`. With no ImageMagick it restores the placeholder icon. The tree stayed clean.                                                                                           |
| `bash scripts/gradle.sh assembleRelease bundleRelease`      | 0    | 15 s |                                                                                                                                                                                                                    |
| `npm run android:size`                                      | 0    | <1 s | Release APK 88,676 B (86.6 KB) against a 160,000 B budget. AAB 145,554 B (142.1 KB) against a 220,000 B budget. classes.dex is 113.1 KB uncompressed. Headroom: about 71 KB on the APK and about 74 KB on the AAB. |

- The Gradle daemon used about 2 GB. Stop it with `./gradlew --stop` before
  running heavy Node jobs.
- Disk use: `~/.gradle` is 847 MB.

### 5. Swift

- Install:
  - apt dependencies
    (`binutils git gnupg2 libc6-dev libcurl4-openssl-dev libedit2 libgcc-13-dev libncurses-dev libpython3-dev libsqlite3-0 libstdc++-13-dev libxml2-dev libz3-dev pkg-config tzdata zlib1g-dev unzip`):
    7 s.
  - Tarball `swift-6.4.1-RELEASE-ubuntu24.04.tar.gz` extracted into `~/swift`.
- `swift --version` reports
  `Swift version 6.4.1 (swift-6.4.1-RELEASE) Target: x86_64-unknown-linux-gnu`.
- `cd apps/ios && swift build`: exit 0 in 8 s, with no errors or warnings in the
  output.
- `swift test`: exit 0 in 5 s.
  - 72 tests, 0 failures: CustomerSession 15, RGBA 14, SiteLocale 7, SiteTheme
    8, Support 16, TenantAPIClient 12.
- `.build/` is ignored and the tree stayed clean.
- Nothing needs fixing for Linux.

### 6. Lingui

- `npm run lingui:check`: **exit 0** in 14 s. The output was "Lingui
  translations complete across all apps (apps/admin, apps/app, apps/mobile,
  apps/sites)".
- The "pre-existing admin lingui catalog failure" mentioned in commits da8fd4e8
  and 067207dd (2026-10-14) has been fixed on this HEAD, apparently by later
  syncs that touched the admin `.po` files.
- `scripts/check-lingui.mjs` fails in three cases:
  1. A source string has not been extracted into a catalog
     (`missing_from_catalog`).
  2. A non-source locale has an empty `msgstr` (for example Arabic).
  3. Only when something is staged: a `.po` file is modified but unstaged, or
     untracked.
- So the pre-commit hook will fail as soon as a feature adds a `t`/`<Trans>`
  string without extracting it and filling in every locale.
- **No fix is needed now.** Proposed rule for mission workers:
  1. Run `npm run lingui:extract` (app; or `npm run lingui:extract -w <app>` for
     admin and sites).
  2. Fill in the `msgstr` for every non-source locale.
  3. `git add` the `.po` files together with the source change.

### 7. Baseline checks

Real workspace names: `tenant-api`, `app`, `sites`, `admin`, `voice-agent`,
`jobs-cron`, `@repo/tenant-db`, `@repo/staffing`, `@repo/phone-agent`,
`@repo/phone-agent-restaurant`, `@repo/reports`, `@repo/marketing-workflow`.

`@repo/zoned-time` and `@repo/reservations` do not exist yet.

Lint scripts exist only in `app`, `sites`, `admin` and
`@repo/marketing-workflow` (`eslint .`). The others are covered by root oxlint
only.

| Check                                                                                                             | Exit | Time | Result                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------- | ---- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| Filtered turbo typecheck, first run                                                                               | 1    | 9 s  | admin failed: varlock `SESSION_SECRET` missing because there was no `apps/admin/.env`. Fixed by creating that file. |
| Same command, second run                                                                                          | 134  | 86 s | `app` typecheck ran out of heap at about 2 GB (V8 default).                                                         |
| `cd apps/app && NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck`                                         | 0    | 71 s | Peak system memory used: about 3.4 GB.                                                                              |
| Same filtered turbo typecheck with `NODE_OPTIONS=--max-old-space-size=4096`                                       | 0    | 72 s | 12 of 12 tasks pass (11 cached). `NODE_OPTIONS` reaches the task through turbo.                                     |
| `npm run lint:oxc`                                                                                                | 0    | 1 s  | 0 errors, 19 warnings                                                                                               |
| `npx turbo run lint --filter=app --filter=sites --filter=admin --filter=@repo/marketing-workflow --concurrency=2` | 134  | 90 s | sites, admin and marketing-workflow pass. app ran out of heap.                                                      |
| `cd apps/app && NODE_OPTIONS=--max-old-space-size=4096 npm run lint`                                              | 1    | 78 s | **59 errors and 79 warnings, pre-existing** (peak about 4.1 GB).                                                    |

Pre-existing App ESLint errors (all design-system rules, all in the menu
module):

| Count | File                                                              | Rule                   |
| ----- | ----------------------------------------------------------------- | ---------------------- |
| 20    | `apps/app/app/components/menu/option-form.tsx`                    | `shadcn/no-restyle`    |
| 3     | `apps/app/app/components/menu/option-form.tsx`                    | `shadcn/no-raw-colors` |
| 16    | `apps/app/app/components/menu/menu-form.tsx`                      | `shadcn/no-restyle`    |
| 8     | `apps/app/app/components/menu/category-form.tsx`                  | `shadcn/no-restyle`    |
| 7     | `apps/app/app/components/menu/modifier-guest-preview.tsx`         | `shadcn/no-restyle`    |
| 3     | `apps/app/app/routes/_app+/$orgSlug_+/menu+/modifiers._index.tsx` | `shadcn/no-raw-colors` |
| 2     | `apps/app/app/routes/_app+/$orgSlug_+/menu+/options._index.tsx`   | `shadcn/no-raw-colors` |

Examples of the restyle errors: `text-xs` on `<FrameDescription>`, and `gap-3`,
`p-3.5`, `border-primary/60` or `bg-primary/5` on `<Item>`.

Warnings: `playwright/no-raw-locators` 36, `import/order` 22, `no-unused-vars`
13, `lingui/no-expression-in-message` 4, `import/no-duplicates` 2,
`consistent-type-imports` 2.

**Gate on "no new errors in changed files"**, for example
`npx eslint <changed files>`, or by comparing against the count of 59. Do not
gate on a green `app` lint.

Unit tests (all run with `CI=true`, non-watch):

| Workspace                                            | Exit | Wall time | Files | Tests                    |
| ---------------------------------------------------- | ---- | --------- | ----- | ------------------------ |
| tenant-api                                           | 0    | 95 s      | 80    | 1526                     |
| app (`vitest --run`, `CI=true` gives `maxWorkers` 2) | 0    | 454 s     | 254   | 2499 (peak about 2.6 GB) |
| sites                                                | 0    | 3 s       | 24    | 182                      |
| @repo/staffing                                       | 0    | 3 s       | 35    | 634                      |
| @repo/tenant-db                                      | 0    | 6 s       | 12    | 171                      |
| voice-agent                                          | 0    | 4 s       | 12    | 192                      |
| @repo/phone-agent                                    | 0    | 1 s       | 11    | 101                      |
| @repo/phone-agent-restaurant                         | 0    | 2 s       | 3     | 45                       |
| @repo/reports                                        | 0    | 1 s       | 8     | 129                      |
| @repo/marketing-workflow                             | 0    | 1 s       | 2     | 9                        |
| jobs-cron                                            | 0    | 1 s       | 4     | 91                       |

- **No pre-existing test failures.** The tenant-api log line
  `ERR_JWT_CLAIM_VALIDATION_FAILED` is expected output from a negative test.
- Side effect: `npm run test -w @repo/reports` (varlock run) regenerated the
  tracked `packages/reports/src/env.ts`. The change was formatting only
  (semicolons and indentation). The file was clean before, so it was restored
  with `git checkout`.
  - Workers should expect this, and the same for `packages/security/src/env.ts`
    after dev, and should not commit these files.

### 8. Resources

| When                                           | Used         | Available | Load average |
| ---------------------------------------------- | ------------ | --------- | ------------ |
| Start                                          | 604 MB       | 7352 MB   | 0.04         |
| After the Android builds (Gradle daemon alive) | 2774 MB      | 5182 MB   | 3.57         |
| Peak during app typecheck                      | about 3.4 GB |           |              |
| Peak during app lint                           | about 4.1 GB |           |              |
| Peak during app tests                          | about 2.6 GB |           |              |
| End                                            | 763 MB       | 7193 MB   | 2.05         |

- Disk on `/`: 25 GB free at the end.
- Toolchain disk use: `~/swift` 3.5 GB, `~/android-sdk` 621 MB, `~/.gradle` 847
  MB.
- **Do not run the app typecheck and the app lint concurrently.** Each needs
  about 3.5 to 4 GB.

## Recommended services.yaml commands

```yaml
commands:
  install:
    'PUPPETEER_SKIP_DOWNLOAD=true npm install && bash
    /home/factory-user/reservations-planning/readiness/add-linux-bindings.sh'
  migrate_control_plane:
    'npm run db:migrate:deploy && (cd apps/app && npm run db:migrate:d1:local)'
  typecheck:
    'NODE_OPTIONS=--max-old-space-size=4096 npx turbo run typecheck
    --filter=tenant-api --filter=app --filter=sites --filter=admin
    --filter=@repo/tenant-db --filter=@repo/staffing --filter=@repo/phone-agent
    --filter=@repo/phone-agent-restaurant --filter=voice-agent
    --filter=@repo/reports --filter=@repo/marketing-workflow --filter=jobs-cron
    --concurrency=2 --continue'
  # add --filter=@repo/reservations --filter=@repo/zoned-time once they exist
  lint_oxc: 'npm run lint:oxc'
  lint_eslint_small:
    'npx turbo run lint --filter=sites --filter=admin
    --filter=@repo/marketing-workflow --concurrency=2 --continue'
  lint_eslint_app: 'cd apps/app && NODE_OPTIONS=--max-old-space-size=4096 npx
    eslint .' # baseline: 59 pre-existing errors; gate on no new errors
  test_fast:
    'for w in sites @repo/staffing @repo/tenant-db voice-agent @repo/phone-agent
    @repo/phone-agent-restaurant @repo/reports @repo/marketing-workflow
    jobs-cron; do CI=true npm run test -w $w || exit 1; done'
  test_tenant_api: 'CI=true npm run test -w tenant-api' # about 95 s
  test_app: 'CI=true npm run test -w app' # about 7.5 min; run alone
  android_env:
    'export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
    ANDROID_SDK_ROOT=$HOME/android-sdk ANDROID_HOME=$HOME/android-sdk
    PATH=/usr/lib/jvm/java-17-openjdk-amd64/bin:$PATH'
  android_test:
    'cd apps/android && export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
    ANDROID_SDK_ROOT=$HOME/android-sdk ANDROID_HOME=$HOME/android-sdk && npm run
    android:test'
  android_build:
    'cd apps/android && export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
    ANDROID_SDK_ROOT=$HOME/android-sdk ANDROID_HOME=$HOME/android-sdk && npm run
    android:build'
  android_size:
    'cd apps/android && export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
    ANDROID_SDK_ROOT=$HOME/android-sdk ANDROID_HOME=$HOME/android-sdk && node
    scripts/generate-tenant.mjs --tenant ci --no-api && bash scripts/gradle.sh
    assembleRelease bundleRelease && npm run android:size && ./gradlew --stop'
  android_lint: 'cd apps/android && export
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
    ANDROID_SDK_ROOT=$HOME/android-sdk ANDROID_HOME=$HOME/android-sdk && npm run
    android:lint' # not run in baseline
  ios_build: 'cd apps/ios && PATH=$HOME/swift/usr/bin:$PATH swift build'
  ios_test: 'cd apps/ios && PATH=$HOME/swift/usr/bin:$PATH swift test'
  lingui_check: 'npm run lingui:check'
  post_check_clean:
    'git checkout -- packages/reports/src/env.ts packages/security/src/env.ts
    2>/dev/null; git status --porcelain'
```

**Suggested milestone gate order on 4 CPUs:**

1. `typecheck`
2. `lint_oxc`
3. `lint_eslint_small`
4. `lint_eslint_app`
5. `test_fast`
6. `test_tenant_api`
7. `test_app`
8. Android (`./gradlew --stop` afterwards)
9. iOS
10. `lingui_check`

The full gate takes about 15 to 17 minutes when warm.

## Files written

- `/home/factory-user/reservations-planning/readiness/dependency-readiness.md`
  (this file)
- `/home/factory-user/reservations-planning/readiness/add-linux-bindings.sh`
- `/Users/zama/menuza/apps/admin/.env` (gitignored; 3 keys copied from
  `apps/app/.env`)
- Outside the repo: `~/android-sdk`, `~/swift`, `~/.gradle`, and the system
  packages JDK 17 and the Swift apt dependencies.
- `/Users/zama/menuza/apps/android/app/tenant.properties` (gitignored, written
  by the CI tenant generation).
