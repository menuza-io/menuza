import { defineConfig, devices } from '@playwright/test'
import 'varlock/auto-load'

const PORT = process.env.PORT || '3001'

/**
 * Match the GitHub Actions Playwright job (`.github/workflows/deploy.yml`):
 * - `CI=true` uses the production build with mocks (`npm run start:mocks`)
 * - `LAUNCH_STATUS` defaults to `LAUNCHED` so waitlist does not swallow sign-in
 * - `MOCKS=true` so invitation emails are captured instead of sent
 *
 * `waitlist-referral` tests override `LAUNCH_STATUS=CLOSED_BETA`.
 *
 * `npm run test:e2e:run` sets `CI=true` (same as CI). Do not leave a stray
 * `npm run dev` on :3001 with a different `LAUNCH_STATUS` when using that
 * script — a fresh mocked server is started instead of reusing it.
 */
export default defineConfig({
	testDir: './tests/e2e',
	timeout: 60 * 1000,
	expect: {
		timeout: 15 * 1000,
	},
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: 'html',
	use: {
		baseURL: `http://localhost:${PORT}/`,
		trace: 'on-first-retry',
	},

	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				launchOptions: {
					args: ['--host-rules=MAP *.menuza.test [::1]'],
				},
			},
		},
	],

	webServer: {
		command: process.env.CI ? 'npm run start:mocks' : 'npm run dev',
		port: Number(PORT),
		reuseExistingServer: !process.env.CI,
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...process.env,
			// Resolve the server's env again after applying the overrides below.
			// The runner's Varlock snapshot otherwise restores MOCKS=false in CI.
			__VARLOCK_ENV: '',
			PORT,
			BASE_URL: `http://localhost:${PORT}`,
			NODE_ENV: 'test',
			MOCKS: 'true',
			AUDIT_LOG_SECRET_KEY: 'playwright-only-audit-integrity-key',
			VITE_DIRECT_DEV: '1',
			NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=6144',
			// Local `.env` is often CLOSED_BETA for product work. CI has no such
			// file and defaults to LAUNCHED. Do not inherit `.env` here — it would
			// send `/organizations` to the waitlist. Waitlist tests match `waitlist`
			// in the Playwright argv (`npm run test:e2e:waitlist`).
			LAUNCH_STATUS: process.argv.some((arg) => arg.includes('waitlist'))
				? 'CLOSED_BETA'
				: 'LAUNCHED',
			// Force the POS platform sandbox during E2E even if the developer's
			// `.env` has real (or OAuth) credentials. `MOCK_`/`demo-` values are the
			// sentinels that keep the mock on.
			CLOVER_APP_ID: 'MOCK_CLOVER_APP_ID',
			CLOVER_APP_SECRET: 'MOCK_CLOVER_APP_SECRET',
			SQUARE_APP_ID: 'MOCK_SQUARE_APP_ID',
			SQUARE_APP_SECRET: 'MOCK_SQUARE_APP_SECRET',
			TOAST_CLIENT_ID: 'MOCK_TOAST_CLIENT_ID',
			TOAST_CLIENT_SECRET: 'MOCK_TOAST_CLIENT_SECRET',
			UBER_EATS_CLIENT_ID: 'MOCK_UBER_EATS_CLIENT_ID',
			UBER_EATS_CLIENT_SECRET: 'MOCK_UBER_EATS_CLIENT_SECRET',
			DOORDASH_DEVELOPER_ID: 'MOCK_DOORDASH_DEVELOPER_ID',
			DOORDASH_KEY_ID: 'MOCK_DOORDASH_KEY_ID',
			DOORDASH_SIGNING_SECRET: 'MOCK_DOORDASH_SIGNING_SECRET',
			GBP_CLIENT_ID: 'MOCK_GBP_CLIENT_ID',
			GBP_CLIENT_SECRET: 'MOCK_GBP_CLIENT_SECRET',
			YELP_CLIENT_ID: 'MOCK_YELP_CLIENT_ID',
			YELP_CLIENT_SECRET: 'MOCK_YELP_CLIENT_SECRET',
			TRIPADVISOR_CLIENT_ID: 'MOCK_TRIPADVISOR_CLIENT_ID',
			TRIPADVISOR_CLIENT_SECRET: 'MOCK_TRIPADVISOR_CLIENT_SECRET',
			DELIVEROO_CLIENT_ID: 'MOCK_DELIVEROO_CLIENT_ID',
			DELIVEROO_CLIENT_SECRET: 'MOCK_DELIVEROO_CLIENT_SECRET',
			JUST_EAT_CLIENT_ID: 'MOCK_JUST_EAT_CLIENT_ID',
			JUST_EAT_CLIENT_SECRET: 'MOCK_JUST_EAT_CLIENT_SECRET',
			OPENTABLE_CLIENT_ID: 'MOCK_OPENTABLE_CLIENT_ID',
			OPENTABLE_CLIENT_SECRET: 'MOCK_OPENTABLE_CLIENT_SECRET',
			RESY_CLIENT_ID: 'MOCK_RESY_CLIENT_ID',
			RESY_CLIENT_SECRET: 'MOCK_RESY_CLIENT_SECRET',
		},
	},
})
