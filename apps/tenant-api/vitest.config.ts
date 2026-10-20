import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		setupFiles: ['./tests/setup-env.ts'],
		// Suites provision real SQLite databases; 5s is too tight when every
		// workspace's tests run in parallel.
		testTimeout: 15000,
	},
})
