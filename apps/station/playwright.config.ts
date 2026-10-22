import { defineConfig, devices } from '@playwright/test'

/**
 * Full-stack suite. Two servers start before the tests:
 *
 *  1. The backend harness (apps/tenant-api/tests/pos-e2e-server.ts): the real
 *     tenant-api app on real SQLite, plus a stub of the App's public routes.
 *  2. The POS production build behind `vite preview`, so the service worker
 *     and offline behaviour are what ships.
 *
 * Tests share one backend and reset it in `beforeEach`, so they run serially.
 * Disk-light on purpose: no video, no traces, screenshots only on failure.
 */
const POS_PORT = 3110
const API_PORT = 4711

export default defineConfig({
	testDir: './e2e',
	timeout: 45_000,
	expect: { timeout: 8_000 },
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: [['list']],
	use: {
		baseURL: `http://localhost:${POS_PORT}`,
		trace: 'off',
		video: 'off',
		screenshot: 'only-on-failure',
	},
	projects: [
		{
			name: 'tablet',
			testIgnore: /phone\.spec\.ts/,
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 1180, height: 820 },
				hasTouch: true,
			},
		},
		{
			name: 'phone',
			testMatch: /phone\.spec\.ts/,
			use: { ...devices['Pixel 7'] },
		},
	],
	webServer: [
		{
			command: 'npx tsx tests/pos-e2e-server.ts',
			cwd: '../tenant-api',
			url: `http://127.0.0.1:${API_PORT}/__test/health`,
			reuseExistingServer: !process.env.CI,
			timeout: 90_000,
			stdout: 'ignore',
			stderr: 'pipe',
		},
		{
			command: `npx vite build && npx vite preview --port ${POS_PORT} --strictPort --host localhost`,
			url: `http://localhost:${POS_PORT}`,
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
			stdout: 'ignore',
			stderr: 'pipe',
		},
	],
})
