import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		setupFiles: ['./tests/setup-env.ts'],
		// Suites provision real SQLite databases (every migration is replayed); 5s
		// is too tight when every workspace's tests run in parallel, and a loaded
		// CI runner has taken 19s for one.
		testTimeout: 60000,
		// Hooks do that provisioning: give them the same room (the default is 10s).
		hookTimeout: 60000,
	},
})
