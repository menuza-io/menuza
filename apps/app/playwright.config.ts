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
			PORT,
			BASE_URL: `http://localhost:${PORT}`,
			NODE_ENV: 'test',
			MOCKS: 'true',
			// Local `.env` is often CLOSED_BETA for product work. CI has no such
			// file and defaults to LAUNCHED. Do not inherit `.env` here — it would
			// send `/organizations` to the waitlist. Waitlist tests match `waitlist`
			// in the Playwright argv (`npm run test:e2e:waitlist`).
			LAUNCH_STATUS: process.argv.some((arg) => arg.includes('waitlist'))
				? 'CLOSED_BETA'
				: 'LAUNCHED',
		},
	},
})
