import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.test.ts'],
		// Suites provision real SQLite databases and apply the full migration
		// chain (about 0.5s alone, but a loaded CI runner took over 15s).
		testTimeout: 60000,
		// The hooks apply the same chain, and a loaded CI runner takes more than
		// the 10s default for it.
		hookTimeout: 30000,
	},
})
