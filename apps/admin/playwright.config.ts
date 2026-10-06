import { defineConfig, devices } from '@playwright/test'
import 'varlock/auto-load'

const PORT = process.env.PORT || '3005'

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 15 * 1000,
	expect: {
		timeout: 5 * 1000,
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
			},
		},
	],

	webServer: {
		command: process.env.CI ? 'npm run start:mocks' : 'npm run dev',
		port: Number(PORT),
		reuseExistingServer: !process.env.CI,
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 120 * 1000,
		env: {
			// Do not reuse the runner's pre-override Varlock snapshot.
			__VARLOCK_ENV: '',
			PORT,
			NODE_ENV: 'test',
			MOCKS: 'true',
			AUDIT_LOG_SECRET_KEY: 'playwright-only-audit-integrity-key',
		},
	},
})
