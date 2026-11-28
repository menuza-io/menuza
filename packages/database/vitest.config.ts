import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		env: {
			DATABASE_URL: 'file:./db/data.db',
		},
		testTimeout: 10000,
		// The migration tests apply dozens of migrations in a hook; a loaded CI
		// runner needs more than the 10 seconds default.
		hookTimeout: 90000,
	},
})
