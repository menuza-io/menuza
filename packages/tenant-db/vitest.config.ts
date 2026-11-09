import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.test.ts'],
		// Suites provision real SQLite databases and apply the full migration
		// chain; 5s is too tight when every workspace's tests run in parallel.
		testTimeout: 15000,
	},
})
